import {
  EXECUTION_AUTHORITY_DOMAINS,
  LOCAL_OWNER_PRINCIPAL_ID,
  accessProfileSchema,
  machineIdSchema,
  redesignMachineSchema,
  type AccessProfile,
  type MachineId,
  type RedesignMachine,
  type RelationalAuthority,
} from '@dsh-slop/core'
import { SshConnectionError, type OpenSshBroker } from './ssh-broker.ts'
import type { ConnectionState } from './types.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024
const MAX_TIMEOUT_MS = 24 * 60 * 60_000
const MAX_COMMAND_BYTES = 1 * 1_024 * 1_024
const MAX_WORKDIR_BYTES = 4_096

export type MachineServiceBroker = Pick<OpenSshBroker,
  'connect'
  | 'reconcileStatus'
  | 'release'
  | 'run'>

export interface MachineServiceOptions {
  readonly authority: Pick<RelationalAuthority, 'get'>
  readonly broker: MachineServiceBroker
  readonly defaultTimeoutMs?: number
  readonly maxOutputBytes?: number
}

export interface MachineShellRequest {
  readonly machineId: MachineId
  /** Arbitrary login-shell source. DSH-SLOP does not inspect or rewrite it. */
  readonly command: string
  /** Absolute remote directory entered before the command runs. */
  readonly workdir?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface MachineShellResult {
  readonly kind: 'completed'
  readonly machineId: MachineId
  readonly machineRevision: number
  readonly accessProfileRevision: number
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  /** UTF-8 process output with terminal escape/control bytes normalized only. */
  readonly stdout: string
  /** UTF-8 process output with terminal escape/control bytes normalized only. */
  readonly stderr: string
}

export type MachineConnectionStatus =
  | {
      readonly kind: 'local'
      readonly machineId: MachineId
      readonly machineRevision: number
      readonly accessProfileRevision: number
      readonly state: 'local'
    }
  | {
      readonly kind: 'ssh'
      readonly machineId: MachineId
      readonly machineRevision: number
      readonly accessProfileRevision: number
      readonly state: ConnectionState
      readonly message?: string
    }

export type MachineServiceErrorCode =
  | 'MACHINE_NOT_FOUND'
  | 'MACHINE_UNAVAILABLE'
  | 'ACCESS_PROFILE_NOT_FOUND'
  | 'ACCESS_PROFILE_UNAVAILABLE'
  | 'LOCAL_MACHINE'
  | 'INVALID_REQUEST'
  | 'TARGET_CHANGED'

export class MachineServiceError extends Error {
  constructor(
    readonly code: MachineServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'MachineServiceError'
  }
}

/**
 * Typed AUTH_REQUIRED error for the existing protected authentication carrier.
 * It remains an SshConnectionError so existing access-flow catches keep working.
 */
export class MachineAuthenticationRequiredError extends SshConnectionError {
  readonly kind = 'authentication-required'

  constructor(
    readonly machineId: MachineId,
    readonly machineRevision: number,
    readonly accessProfileRevision: number,
    message: string,
  ) {
    super('AUTH_REQUIRED', message)
    this.name = 'MachineAuthenticationRequiredError'
  }
}

interface MachineTarget {
  readonly machine: RedesignMachine
  readonly access: AccessProfile
}

/**
 * Machine-owned remote shell boundary. Durable authority and broker leases stay
 * inside this service; model-facing callers identify only the Machine.
 */
export class MachineService {
  private readonly authority: MachineServiceOptions['authority']
  private readonly broker: MachineServiceBroker
  private readonly defaultTimeoutMs: number
  private readonly maxOutputBytes: number

  constructor(options: MachineServiceOptions) {
    this.authority = options.authority
    this.broker = options.broker
    this.defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'defaultTimeoutMs', MAX_TIMEOUT_MS)
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes', Number.MAX_SAFE_INTEGER)
  }

  async execute(request: MachineShellRequest): Promise<MachineShellResult> {
    request.signal?.throwIfAborted()
    const machineId = machineIdSchema.parse(request.machineId)
    const command = commandText(request.command)
    const workdir = request.workdir === undefined ? undefined : workdirPath(request.workdir)
    const timeoutMs = positiveInteger(request.timeoutMs ?? this.defaultTimeoutMs, 'timeoutMs', MAX_TIMEOUT_MS)
    const remoteArgv = loginShellArgv(command, workdir)

    // One retry closes the authority-read/connect race without hiding sustained
    // inventory churn. Every broker lease remains internal and owner-bound.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = this.loadTarget(machineId)
      if (target.access.kind === 'local') {
        throw new MachineServiceError('LOCAL_MACHINE', 'Local Machines use the DSH native bash tool, not Machine remote shell.')
      }

      let lease: Awaited<ReturnType<MachineServiceBroker['connect']>>
      try {
        lease = await this.broker.connect(machineId, LOCAL_OWNER_PRINCIPAL_ID, target.access.timeouts.connectSeconds)
      } catch (error) {
        throw this.connectionError(error, target)
      }

      const current = this.loadTarget(machineId)
      if (!sameTarget(target, current)) {
        await this.broker.release(lease.id, LOCAL_OWNER_PRINCIPAL_ID)
        if (attempt === 0) continue
        throw new MachineServiceError('TARGET_CHANGED', 'Machine access changed repeatedly while remote execution was starting.')
      }

      try {
        const captured = await this.broker.run(
          lease.id,
          remoteArgv,
          undefined,
          timeoutMs,
          this.maxOutputBytes,
          request.signal,
        )
        await this.broker.release(lease.id, LOCAL_OWNER_PRINCIPAL_ID)
        return {
          kind: 'completed',
          machineId,
          machineRevision: current.machine.revision,
          accessProfileRevision: current.access.revision,
          exitCode: captured.exitCode,
          signal: captured.signal,
          timedOut: captured.timedOut,
          stdout: normalizeTerminalOutput(captured.stdout),
          stderr: normalizeTerminalOutput(captured.stderr),
        }
      } catch (error) {
        await this.broker.release(lease.id, LOCAL_OWNER_PRINCIPAL_ID).catch(() => undefined)
        throw this.connectionError(error, current)
      }
    }

    throw new MachineServiceError('TARGET_CHANGED', 'Machine access changed while remote execution was starting.')
  }

  async connectionStatus(machineIdInput: MachineId, signal?: AbortSignal): Promise<MachineConnectionStatus> {
    signal?.throwIfAborted()
    const target = this.loadTarget(machineIdSchema.parse(machineIdInput))
    if (target.access.kind === 'local') {
      return {
        kind: 'local',
        machineId: target.machine.id,
        machineRevision: target.machine.revision,
        accessProfileRevision: target.access.revision,
        state: 'local',
      }
    }
    const status = await this.broker.reconcileStatus(target.machine.id, signal)
    return {
      kind: 'ssh',
      machineId: target.machine.id,
      machineRevision: target.machine.revision,
      accessProfileRevision: target.access.revision,
      state: status.state,
      ...(status.message === undefined ? {} : { message: status.message }),
    }
  }

  private loadTarget(machineId: MachineId): MachineTarget {
    const machineRecord = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, EXECUTION_AUTHORITY_DOMAINS.machine, machineId)
    if (machineRecord === undefined) {
      throw new MachineServiceError('MACHINE_NOT_FOUND', `Machine '${machineId}' does not exist.`)
    }
    const machine = redesignMachineSchema.parse(machineRecord.value)
    if (machineRecord.ownerPrincipalId !== LOCAL_OWNER_PRINCIPAL_ID
      || machine.ownerPrincipalId !== LOCAL_OWNER_PRINCIPAL_ID
      || machine.id !== machineId
      || machine.revision !== machineRecord.revision
      || machine.lifecycle !== 'active') {
      throw new MachineServiceError('MACHINE_UNAVAILABLE', 'Machine authority is inconsistent or archived.')
    }

    const accessRecord = this.authority.get(
      LOCAL_OWNER_PRINCIPAL_ID,
      EXECUTION_AUTHORITY_DOMAINS.accessProfile,
      machine.accessProfileId,
    )
    if (accessRecord === undefined) {
      throw new MachineServiceError('ACCESS_PROFILE_NOT_FOUND', `AccessProfile '${machine.accessProfileId}' does not exist.`)
    }
    const access = accessProfileSchema.parse(accessRecord.value)
    if (accessRecord.ownerPrincipalId !== LOCAL_OWNER_PRINCIPAL_ID
      || access.ownerPrincipalId !== LOCAL_OWNER_PRINCIPAL_ID
      || access.id !== machine.accessProfileId
      || access.revision !== accessRecord.revision) {
      throw new MachineServiceError('ACCESS_PROFILE_UNAVAILABLE', 'AccessProfile authority is inconsistent.')
    }
    return { machine, access }
  }

  private connectionError(error: unknown, target: MachineTarget): Error {
    if (error instanceof MachineAuthenticationRequiredError) return error
    if (error instanceof SshConnectionError && error.code === 'AUTH_REQUIRED') {
      return new MachineAuthenticationRequiredError(
        target.machine.id,
        target.machine.revision,
        target.access.revision,
        error.message,
      )
    }
    if (error instanceof Error) return error
    return new MachineServiceError('MACHINE_UNAVAILABLE', 'Remote execution failed without a typed provider error.')
  }
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new MachineServiceError('INVALID_REQUEST', `${label} must be a positive integer no greater than ${maximum}.`)
  }
  return value
}

function commandText(value: string): string {
  if (typeof value !== 'string'
    || value.trim().length === 0
    || value.includes('\0')
    || Buffer.byteLength(value) > MAX_COMMAND_BYTES) {
    throw new MachineServiceError('INVALID_REQUEST', 'command must be nonempty, NUL-free, and at most 1 MiB.')
  }
  return value
}

function workdirPath(value: string): string {
  if (typeof value !== 'string'
    || !value.startsWith('/')
    || value.includes('\0')
    || value.includes('\r')
    || value.includes('\n')
    || Buffer.byteLength(value) > MAX_WORKDIR_BYTES) {
    throw new MachineServiceError('INVALID_REQUEST', 'workdir must be an absolute, single-line, NUL-free remote path.')
  }
  return value
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function loginShellArgv(command: string, workdir?: string): readonly string[] {
  const script = workdir === undefined ? command : `cd -- ${shellQuote(workdir)} && ${command}`
  // OpenSSH joins remote argv with spaces. Quote the complete source once so
  // the remote transport shell passes it unchanged to sh -lc.
  return ['sh', '-lc', shellQuote(script)]
}

function sameTarget(left: MachineTarget, right: MachineTarget): boolean {
  return left.machine.id === right.machine.id
    && left.machine.revision === right.machine.revision
    && left.access.id === right.access.id
    && left.access.revision === right.access.revision
}

function normalizeTerminalOutput(bytes: Uint8Array): string {
  const input = Buffer.from(bytes).toString('utf8')
  let output = ''
  for (let index = 0; index < input.length;) {
    const code = input.charCodeAt(index)
    if (code === 0x1b) {
      index = skipEscapeSequence(input, index)
      continue
    }
    if (code === 0x0d) {
      output += '\n'
      index += input.charCodeAt(index + 1) === 0x0a ? 2 : 1
      continue
    }
    if (code === 0x0a || code === 0x09 || code >= 0x20) output += input[index]
    index += 1
  }
  return output
}

function skipEscapeSequence(input: string, escapeIndex: number): number {
  const marker = input.charCodeAt(escapeIndex + 1)
  if (marker === 0x5b) {
    for (let index = escapeIndex + 2; index < input.length; index += 1) {
      const code = input.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return index + 1
    }
    return input.length
  }
  if (marker === 0x5d) {
    for (let index = escapeIndex + 2; index < input.length; index += 1) {
      const code = input.charCodeAt(index)
      if (code === 0x07) return index + 1
      if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 2
    }
    return input.length
  }
  return Math.min(input.length, escapeIndex + 2)
}
