import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  LOCAL_OWNER_PRINCIPAL_ID,
  localAbsolutePathSchema,
  machineIdSchema,
  remotePathSchema,
  type MachineId,
} from '@dsh-slop/core'
import type { OpenSshBroker } from './ssh-broker.ts'
import type { ConnectionLeaseRecord, SshConnectionProfile } from './types.ts'
import { sshPathValue } from '@dsh-slop/operations'

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const MAX_TIMEOUT_MS = 24 * 60 * 60_000
const MAX_TERMINAL_BYTES = 128 * 1_024

export type MachineTransferEndpoint =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'machine'; readonly machineId: MachineId; readonly path: string }

export interface MachineTransferRequest {
  /** SFTP by default; SCP explicitly uses the remote shell's path namespace. */
  readonly protocol?: 'sftp' | 'scp'
  readonly source: MachineTransferEndpoint
  readonly destination: MachineTransferEndpoint
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly onProgress?: (text: string) => void
}

export interface MachineTransferResult {
  readonly kind: 'completed'
  readonly source: MachineTransferEndpoint
  readonly destination: MachineTransferEndpoint
  readonly entryKind: 'file' | 'directory'
  readonly relayedThroughHost: boolean
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  /** Bounded native scp PTY transcript for Tool presentation, not transfer state. */
  readonly terminalOutput: string
}

type TransferBroker = Pick<OpenSshBroker, 'connect' | 'release' | 'requireLease' | 'run'>

export interface MachineTransferServiceOptions {
  readonly broker: TransferBroker
  readonly subprocess: SubprocessRuntime
  readonly cwd: string
  readonly prepareCommand?: (argv: readonly string[]) => Promise<readonly string[]>
  readonly nativeTransfer?: (request: MachineTransferRequest) => Promise<MachineTransferResult>
}

interface RemoteLease {
  readonly machineId: MachineId
  readonly lease: ConnectionLeaseRecord
  readonly profile: SshConnectionProfile
  readonly socketPath: string
}

/** Thin scp wrapper using only Host-to-Machine app-managed SSH masters. */
export class MachineTransferService {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<MachineTransferResult>>()
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Machine component stopped'))
    await Promise.allSettled(this.active)
  }
  constructor(private readonly options: MachineTransferServiceOptions) {}

  async transfer(request: MachineTransferRequest): Promise<MachineTransferResult> {
    const signal = request.signal === undefined ? this.lifetime.signal : AbortSignal.any([request.signal, this.lifetime.signal])
    const task = this.transferOwned({ ...request, signal })
    this.active.add(task)
    try { return await task } finally { this.active.delete(task) }
  }

  private async transferOwned(request: MachineTransferRequest): Promise<MachineTransferResult> {
    request.signal?.throwIfAborted()
    const source = endpoint(request.source)
    const destination = endpoint(request.destination)
    if (source.kind === 'local' && destination.kind === 'local') {
      throw new Error('Local-to-local copies use the native cp tool, not slop_machine_transfer.')
    }
    if (source.kind === 'machine'
      && destination.kind === 'machine'
      && source.machineId === destination.machineId) {
      throw new Error('Copies within one Machine use slop_machine_shell, not slop_machine_transfer.')
    }

    const timeoutMs = positiveTimeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (this.options.nativeTransfer !== undefined) return await this.options.nativeTransfer({ ...request, source, destination, timeoutMs })
    const machineIds = [...new Set([source, destination]
      .filter((value): value is Extract<MachineTransferEndpoint, { kind: 'machine' }> => value.kind === 'machine')
      .map(value => value.machineId))]
    const leases: RemoteLease[] = []
    let configRoot: string | undefined
    try {
      for (const machineId of machineIds) {
        const lease = await this.options.broker.connect(machineId, LOCAL_OWNER_PRINCIPAL_ID)
        const connection = this.options.broker.requireLease(lease.id, LOCAL_OWNER_PRINCIPAL_ID)
        if (connection.profile.ownership !== 'app-managed' || connection.socketPath === undefined) {
          throw new Error('Machine transfer requires an app-managed reusable SSH connection.')
        }
        leases.push({ machineId, lease, profile: connection.profile, socketPath: connection.socketPath })
      }

      const entryKind = source.kind === 'local'
        ? await localEntryKind(source.path)
        : await this.remoteEntryKind(source, requireRemoteLease(leases, source.machineId), timeoutMs, request.signal)
      configRoot = await mkdtemp(join(tmpdir(), 'dsh-slop-scp-'))
      const configPath = join(configRoot, 'ssh_config')
      const aliases = new Map(leases.map((value, index) => [value.machineId, `dsh-slop-transfer-${index + 1}`]))
      await writeFile(configPath, sshConfig(leases, aliases), { encoding: 'utf8', mode: 0o600 })
      const argv = [
        'scp',
        ...(request.protocol === 'scp' ? ['-O'] : []),
        '-F', configPath,
        ...(source.kind === 'machine' && destination.kind === 'machine' ? ['-3'] : []),
        ...(entryKind === 'directory' ? ['-r'] : []),
        '--',
        scpOperand(source, aliases, request.protocol),
        scpOperand(destination, aliases, request.protocol),
      ]
      const terminal = await this.options.subprocess.spawnTerminal({
        argv: await this.options.prepareCommand?.(argv) ?? argv,
        cwd: this.options.cwd,
        rows: 24,
        cols: 100,
        terminalType: 'dumb',
        graceMs: 5_000,
      })
      const controller = new AbortController()
      let timedOut = false
      const abort = (): void => controller.abort(request.signal?.reason)
      if (request.signal?.aborted) abort()
      else request.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort(new Error('transfer timed out'))
      }, timeoutMs)
      let termination: Promise<void> | undefined
      const terminate = (): void => { termination ??= terminal.terminate() }
      controller.signal.addEventListener('abort', terminate, { once: true })
      if (controller.signal.aborted) terminate()
      const decoder = new StringDecoder('utf8')
      let terminalOutput = ''
      const readOutput = (async (): Promise<void> => {
        for await (const raw of terminal.output) {
          const text = decoder.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array))
          terminalOutput = boundedTail(terminalOutput + text)
          if (text.length > 0) request.onProgress?.(text)
        }
        const tail = decoder.end()
        terminalOutput = boundedTail(terminalOutput + tail)
        if (tail.length > 0) request.onProgress?.(tail)
      })()
      try {
        const [outcome] = await Promise.all([terminal.done, readOutput])
        if (request.signal?.aborted) request.signal.throwIfAborted()
        return {
          kind: 'completed',
          source,
          destination,
          entryKind,
          relayedThroughHost: source.kind === 'machine' && destination.kind === 'machine',
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          timedOut,
          terminalOutput,
        }
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', terminate)
        if (controller.signal.aborted) {
          terminate()
          await termination?.catch(() => undefined)
        }
      }
    } finally {
      if (configRoot !== undefined) await rm(configRoot, { recursive: true, force: true }).catch(() => undefined)
      await Promise.all(leases.map(async value => {
        await this.options.broker.release(value.lease.id, LOCAL_OWNER_PRINCIPAL_ID).catch(() => undefined)
      }))
    }
  }

  private async remoteEntryKind(
    source: Extract<MachineTransferEndpoint, { kind: 'machine' }>,
    remote: RemoteLease,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<'file' | 'directory'> {
    const script = `if [ -L "$1" ]; then exit 42; elif [ -f "$1" ]; then printf file; elif [ -d "$1" ]; then printf directory; else exit 44; fi`
    const result = await this.options.broker.run(
      remote.lease.id,
      ['sh', '-c', shellQuote(script), 'dsh-slop-transfer-kind', shellQuote(source.path)],
      undefined,
      Math.min(timeoutMs, 30_000),
      4_096,
      signal,
    )
    if (result.exitCode === 42) throw new Error('The remote source must be a regular file or directory, not a symbolic link.')
    if (result.exitCode !== 0) throw new Error('The remote source does not exist or is not a regular file or directory.')
    const kind = Buffer.from(result.stdout).toString('utf8')
    if (kind !== 'file' && kind !== 'directory') throw new Error('The remote source type could not be determined.')
    return kind
  }
}

function endpoint(value: MachineTransferEndpoint): MachineTransferEndpoint {
  return value.kind === 'local'
    ? { kind: 'local', path: localAbsolutePathSchema.parse(value.path) }
    : {
        kind: 'machine',
        machineId: machineIdSchema.parse(value.machineId),
        path: remotePathSchema.parse(value.path),
      }
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}.`)
  }
  return value
}

async function localEntryKind(path: string): Promise<'file' | 'directory'> {
  const stats = await lstat(path)
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  throw new Error('The local source must be a regular file or directory.')
}

function requireRemoteLease(leases: readonly RemoteLease[], machineId: MachineId): RemoteLease {
  const value = leases.find(candidate => candidate.machineId === machineId)
  if (value === undefined) throw new Error('Machine transfer connection lease was not acquired.')
  return value
}

function sshConfig(leases: readonly RemoteLease[], aliases: ReadonlyMap<MachineId, string>): string {
  return leases.map(value => {
    const alias = aliases.get(value.machineId)
    if (alias === undefined) throw new Error('Machine transfer SSH alias was not assigned.')
    return [
      `Host ${alias}`,
      // A live ControlPath is the destination. The unroutable fallback keeps a
      // vanished master from silently opening a fresh network connection.
      '  HostName 127.0.0.1',
      '  Port 1',
      `  ControlPath ${sshPathValue(value.socketPath)}`,
      '  ControlMaster no',
      '  BatchMode yes',
      '  RequestTTY no',
      '',
    ].join('\n')
  }).join('\n')
}

function scpOperand(endpointValue: MachineTransferEndpoint, aliases: ReadonlyMap<MachineId, string>, protocol?: 'sftp' | 'scp'): string {
  if (endpointValue.kind === 'local') return endpointValue.path
  const alias = aliases.get(endpointValue.machineId)
  if (alias === undefined) throw new Error('Machine transfer SSH alias was not assigned.')
  return `${alias}:${protocol === 'scp' ? shellQuote(endpointValue.path) : endpointValue.path}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function boundedTail(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= MAX_TERMINAL_BYTES) return value
  let start = bytes.length - MAX_TERMINAL_BYTES
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}
