import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sshPathValue } from '@dsh-slop/operations'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCAL_OWNER_PRINCIPAL_ID,
  connectionLeaseIdSchema,
  machineIdSchema,
  type ConnectionLeaseId,
  type MachineId,
} from '@dsh-slop/core'
import { MachineTransferService } from '../src/machine-transfer-service.ts'
import type { ConnectionLeaseRecord, SshConnectionProfile } from '../src/types.ts'

const roots: string[] = []
const machineA = machineIdSchema.parse('00000000-0000-7000-8000-000000000001')
const machineB = machineIdSchema.parse('00000000-0000-7000-8000-000000000002')

interface SpawnObservation {
  readonly argv: readonly string[]
  readonly config: string
}

function leaseId(machineId: MachineId): ConnectionLeaseId {
  return connectionLeaseIdSchema.parse(machineId === machineA
    ? '00000000-0000-7000-8000-000000000011'
    : '00000000-0000-7000-8000-000000000012')
}

function profile(machineId: MachineId): SshConnectionProfile {
  return {
    machineId,
    revision: 1,
    alias: machineId === machineA ? 'alice@a.example' : 'bob@b.example',
    trust: { mode: 'user-known-hosts', expectedFingerprints: [] },
    ownership: 'app-managed',
    connectTimeoutSeconds: 30,
    keepaliveSeconds: 30,
    idleTimeoutSeconds: 600,
    concurrencyLimit: 8,
  }
}

async function fixture(remoteKind: 'file' | 'directory' = 'file', terminalMode: 'complete' | 'hang' = 'complete', progress = 'artifact.bin  42%  4.2GB  80.1MB/s  00:52 ETA\r'): Promise<{
  readonly root: string
  readonly observations: SpawnObservation[]
  readonly released: ConnectionLeaseId[]
  readonly terminations: number[]
  readonly service: MachineTransferService
}> {
  const root = await mkdtemp(join(tmpdir(), 'slop-transfer-test-'))
  roots.push(root)
  const observations: SpawnObservation[] = []
  const released: ConnectionLeaseId[] = []
  const terminations: number[] = []
  const leases = new Map<ConnectionLeaseId, ConnectionLeaseRecord>()
  const broker = {
    async connect(machineId: MachineId): Promise<ConnectionLeaseRecord> {
      const id = leaseId(machineId)
      const lease: ConnectionLeaseRecord = {
        id,
        ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
        machineId,
        identityDigest: 'a'.repeat(64) as ConnectionLeaseRecord['identityDigest'],
        acquiredAt: '2026-09-04T00:00:00.000Z',
        expiresAt: '2099-09-04T00:00:00.000Z',
      }
      leases.set(id, lease)
      return lease
    },
    requireLease(id: ConnectionLeaseId) {
      const lease = leases.get(id)
      if (lease === undefined) throw new Error('missing lease')
      return { lease, profile: profile(lease.machineId), socketPath: join(root, `${lease.machineId}.sock`) }
    },
    async release(id: ConnectionLeaseId): Promise<void> { released.push(id) },
    async run() {
      return {
        argv: ['ssh'],
        exitCode: 0,
        signal: null,
        stdout: Buffer.from(remoteKind),
        stderr: new Uint8Array(),
        timedOut: false,
      }
    },
  }
  const subprocess = {
    async spawnTerminal(spec: { readonly argv: readonly string[] }) {
      const configIndex = spec.argv.indexOf('-F')
      const configPath = spec.argv[configIndex + 1]
      if (configPath === undefined) throw new Error('missing scp config')
      observations.push({ argv: [...spec.argv], config: await readFile(configPath, 'utf8') })
      if (terminalMode === 'hang') {
        const output = new PassThrough()
        let settle: ((value: { exitCode: null; signal: 'SIGTERM' }) => void) | undefined
        const done = new Promise<{ exitCode: null; signal: 'SIGTERM' }>(resolve => { settle = resolve })
        return {
          pid: 123,
          output,
          done,
          write: async () => {},
          inspectForeground: async () => undefined,
          signalForeground: async () => 123,
          terminate: async () => {
            terminations.push(1)
            output.end()
            settle?.({ exitCode: null, signal: 'SIGTERM' })
          },
        }
      }
      return {
        pid: 123,
        output: Readable.from([progress]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        write: async () => {},
        inspectForeground: async () => undefined,
        signalForeground: async () => 123,
        terminate: async () => {},
      }
    },
  }
  return {
    root,
    observations,
    released,
    terminations,
    service: new MachineTransferService({ broker: broker as never, subprocess: subprocess as never, cwd: root }),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('MachineTransferService', () => {
  it('stops its active transfer and rejects new work when the Machine component closes', async () => {
    const { root, service, terminations, released, observations } = await fixture('file', 'hang')
    const request = { source: { kind: 'machine' as const, machineId: machineA, path: '/work/file' }, destination: { kind: 'local' as const, path: join(root, 'download') } }
    const pending = service.transfer(request)
    const failed = expect(pending).rejects.toThrow('Machine component stopped')
    while (observations.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    await service.close()
    await failed
    expect(terminations).toHaveLength(1)
    expect(released).toEqual([leaseId(machineA)])
    await expect(service.transfer(request)).rejects.toThrow('Machine component stopped')
    expect(observations).toHaveLength(1)
  })

  it('bounds retained progress by UTF-8 bytes without splitting characters', async () => {
    const { service } = await fixture('file', 'complete', '数'.repeat(100_000))
    const result = await service.transfer({ source: { kind: 'machine', machineId: machineA, path: '/data/a' }, destination: { kind: 'machine', machineId: machineB, path: '/data/b' }, signal: new AbortController().signal })
    expect(Buffer.byteLength(result.terminalOutput)).toBeLessThanOrEqual(128 * 1024)
    expect(result.terminalOutput).not.toContain('�')
    expect(result.terminalOutput.endsWith('数')).toBe(true)
  })

  it('copies a local file to one Machine through its existing control socket', async () => {
    const { root, observations, released, service } = await fixture()
    const source = join(root, 'artifact name;$(literal).bin')
    await writeFile(source, 'payload')
    const progress: string[] = []

    const result = await service.transfer({
      source: { kind: 'local', path: source },
      destination: { kind: 'machine', machineId: machineA, path: '/scratch/artifact name;$(literal).bin' },
      onProgress: text => { progress.push(text) },
    })

    expect(observations[0]?.argv).toEqual(expect.arrayContaining(['scp', '--', source, 'dsh-slop-transfer-1:/scratch/artifact name;$(literal).bin']))
    expect(observations[0]?.argv).not.toContain('-3')
    expect(observations[0]?.config).toContain(`ControlPath ${sshPathValue(join(root, `${machineA}.sock`))}`)
    expect(observations[0]?.config).toContain('HostName 127.0.0.1\n  Port 1')
    expect(progress.join('')).toContain('42%')
    expect(result).toMatchObject({ entryKind: 'file', relayedThroughHost: false, exitCode: 0 })
    expect(released).toEqual([leaseId(machineA)])
  })

  it('copies a remote directory to the Host with recursive scp', async () => {
    const { root, observations, service } = await fixture('directory')
    const destination = join(root, 'download')

    const result = await service.transfer({
      source: { kind: 'machine', machineId: machineA, path: '/work/results' },
      destination: { kind: 'local', path: destination },
    })

    expect(observations[0]?.argv).toEqual(expect.arrayContaining([
      'scp', '-r', '--', 'dsh-slop-transfer-1:/work/results', destination,
    ]))
    expect(result.entryKind).toBe('directory')
  })

  it('uses explicitly requested SCP shell paths and quotes remote metacharacters', async () => {
    const { root, observations, service } = await fixture()
    await service.transfer({
      protocol: 'scp',
      source: { kind: 'machine', machineId: machineA, path: "/volume1/work/a 'file;$(touch injected).bin" },
      destination: { kind: 'local', path: join(root, 'download') },
    })
    expect(observations[0]?.argv).toContain('-O')
    expect(observations[0]?.argv).toContain(`dsh-slop-transfer-1:'/volume1/work/a '"'"'file;$(touch injected).bin'`)
    expect(observations).toHaveLength(1)
  })

  it('uses scp -3 and two distinct control sockets for Machine-to-Machine transfer', async () => {
    const { root, observations, released, service } = await fixture()

    const result = await service.transfer({
      source: { kind: 'machine', machineId: machineA, path: '/work/a.bin' },
      destination: { kind: 'machine', machineId: machineB, path: '/scratch/b.bin' },
    })

    expect(observations[0]?.argv).toEqual(expect.arrayContaining([
      'scp', '-3', '--', 'dsh-slop-transfer-1:/work/a.bin', 'dsh-slop-transfer-2:/scratch/b.bin',
    ]))
    expect(observations[0]?.argv).not.toContain('-R')
    expect(observations[0]?.config).toContain(`ControlPath ${sshPathValue(join(root, `${machineA}.sock`))}`)
    expect(observations[0]?.config).toContain(`ControlPath ${sshPathValue(join(root, `${machineB}.sock`))}`)
    expect(result.relayedThroughHost).toBe(true)
    expect(released).toEqual(expect.arrayContaining([leaseId(machineA), leaseId(machineB)]))
    const configPath = observations[0]?.argv[observations[0].argv.indexOf('-F') + 1]
    if (configPath === undefined) throw new Error('missing observed config path')
    await expect(access(configPath)).rejects.toThrow()
  })

  it('rejects routes that belong to cp or one remote shell', async () => {
    const { root, service } = await fixture()
    const source = join(root, 'source')
    await writeFile(source, 'payload')

    await expect(service.transfer({
      source: { kind: 'local', path: source },
      destination: { kind: 'local', path: join(root, 'destination') },
    })).rejects.toThrow('native cp')
    await expect(service.transfer({
      source: { kind: 'machine', machineId: machineA, path: '/a' },
      destination: { kind: 'machine', machineId: machineA, path: '/b' },
    })).rejects.toThrow('slop_machine_shell')
  })

  it('terminates the PTY and reports a transfer deadline', async () => {
    const { root, service, terminations } = await fixture('file', 'hang')
    const source = join(root, 'artifact.bin')
    await writeFile(source, 'payload')

    const result = await service.transfer({
      source: { kind: 'local', path: source },
      destination: { kind: 'machine', machineId: machineA, path: '/scratch/artifact.bin' },
      timeoutMs: 5,
    })

    expect(result).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGTERM' })
    expect(terminations).toHaveLength(1)
  })

  it('propagates caller cancellation after stopping the PTY', async () => {
    const { root, service, terminations } = await fixture('file', 'hang')
    const source = join(root, 'artifact.bin')
    await writeFile(source, 'payload')
    const controller = new AbortController()
    const transfer = service.transfer({
      source: { kind: 'local', path: source },
      destination: { kind: 'machine', machineId: machineA, path: '/scratch/artifact.bin' },
      signal: controller.signal,
    })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    controller.abort(new Error('cancelled by caller'))

    await expect(transfer).rejects.toThrow('cancelled by caller')
    expect(terminations).toHaveLength(1)
  })
})
