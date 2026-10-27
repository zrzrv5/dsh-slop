import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LocalArtifactStore } from '../src/artifact-store.js'
import { controlSocketPath, controlSocketRoot, remoteHelperArgv, sshBaseArgv } from '../src/openssh.js'
import { FileOperationStreamStore, ResyncRequiredError } from '../src/operation-stream-store.js'
import { normalizeSlurmState, parsePbsJson, parseSlurmAccounting, pbsObserveArgv, slurmObserveArgv } from '../src/scheduler.js'
import { runValidationChecks } from '../src/validation.js'
import { DshAuthFlow } from '../src/auth-flow.js'

describe('scheduler evidence', () => {
  it('retains Slurm raw states and child handles', () => {
    expect(normalizeSlurmState('OUT_OF_MEMORY')).toBe('failed')
    const rows = parseSlurmAccounting('123|COMPLETED|0:0|17|n1|None\n123.batch|FAILED|2:0|16|n1|error\n')
    expect(rows).toMatchObject([{ nativeId: '123', state: 'completed' }, { nativeId: '123.batch', childScope: 'batch', state: 'failed', exitCode: 2 }])
  })

  it('parses PBS JSON without treating missing rows as completion', () => {
    expect(parsePbsJson('{"Jobs":{"42.server":{"job_state":"F","Exit_status":1,"resources_used":{"walltime":"00:02:03"}}}}')).toMatchObject([{ nativeId: '42.server', state: 'failed', elapsedSeconds: 123 }])
    expect(parsePbsJson('{}')).toEqual([])
  })

  it('constructs argv without shell interpolation', () => {
    expect(slurmObserveArgv(['12_3'])).toContain('12_3')
    expect(() => slurmObserveArgv(['12;id'])).toThrow()
    expect(() => pbsObserveArgv(['12;id'])).toThrow()
  })
})

describe('operation streams', () => {
  it('replays independent offsets and reports retention gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-stream-'))
    const store = new FileOperationStreamStore(root, 4)
    await store.append('op_1', 'stdout', new TextEncoder().encode('abcdef'))
    expect(new TextDecoder().decode((await store.read('op_1', 'stdout', '2', 4)).bytes)).toBe('cdef')
    await expect(store.read('op_1', 'stdout', '0', 1)).rejects.toBeInstanceOf(ResyncRequiredError)
    await store.close('op_1', 'stdout', 'success')
    expect((await store.read('op_1', 'stdout', '6', 1)).eof).toBe(true)
  })
})

describe('protected authentication', () => {
  function terminalFixture(readiness: () => Promise<boolean> = async () => false) {
    const output = new EventEmitter()
    let resolveDone = (): void => {}
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    const writes: string[] = []
    const terminal = { output, done, write: async (value: string) => { writes.push(value) }, terminate: async () => { resolveDone() } }
    return { output, resolveDone, writes, terminal, flow: new DshAuthFlow({ spawnTerminal: async () => terminal } as never, readiness) }
  }

  it('replays the rolling SSH terminal tail to every owner reattachment without retaining input', async () => {
    const { flow, output, writes } = terminalFixture()
    const view = await flow.create({ ownerPrincipalId: 'owner', machineId: 'machine', connectionIdentityDigest: 'digest', argv: ['ssh', 'cluster'], cwd: '/tmp', expiresInMs: 30_000 })
    output.emit('data', 'Password: ')
    const first: string[] = []
    const detach = flow.subscribe(view.flowId, 'owner', bytes => { first.push(Buffer.from(bytes).toString('utf8')) })
    output.emit('data', '\r\nDuo choice: ')
    detach()
    const second: string[] = []
    flow.subscribe(view.flowId, 'owner', bytes => { second.push(Buffer.from(bytes).toString('utf8')) })
    expect(first.join('')).toBe('Password: \r\nDuo choice: ')
    expect(second.join('')).toBe('Password: \r\nDuo choice: ')
    await flow.write(view.flowId, 'owner', 'secret\n')
    expect(writes).toEqual(['secret\n'])
    const third: string[] = []
    flow.subscribe(view.flowId, 'owner', bytes => { third.push(Buffer.from(bytes).toString('utf8')) })
    expect(third.join('')).not.toContain('secret')
    await flow.cancel(view.flowId, 'owner')
  })

  it('retains exactly the newest 64 KiB when one PTY chunk exceeds the replay bound', async () => {
    const { flow, output } = terminalFixture()
    const view = await flow.create({ ownerPrincipalId: 'owner', machineId: 'machine', connectionIdentityDigest: 'digest', argv: ['ssh', 'cluster'], cwd: '/tmp', expiresInMs: 30_000 })
    output.emit('data', Buffer.concat([Buffer.alloc(37, 0x61), Buffer.alloc(65_536, 0x62)]))
    const replayed: Uint8Array[] = []
    flow.subscribe(view.flowId, 'owner', bytes => { replayed.push(bytes) })
    const tail = Buffer.concat(replayed.map(bytes => Buffer.from(bytes)))
    expect(tail.byteLength).toBe(65_536)
    expect(tail.equals(Buffer.alloc(65_536, 0x62))).toBe(true)
    await flow.cancel(view.flowId, 'owner')
  })

  it('preserves exact owner-bound checking and terminal tombstone states', async () => {
    let resolveReadiness = (_ready: boolean): void => {}
    const readiness = new Promise<boolean>(resolve => { resolveReadiness = resolve })
    const readyFixture = terminalFixture(async () => await readiness)
    const ready = await readyFixture.flow.create({ ownerPrincipalId: 'owner', machineId: 'machine', connectionIdentityDigest: 'digest', argv: ['ssh', 'cluster'], cwd: '/tmp', expiresInMs: 30_000 })
    expect(readyFixture.flow.describe(ready.flowId, 'owner').state).toBe('interactive')
    readyFixture.resolveDone()
    await vi.waitFor(() => { expect(readyFixture.flow.describe(ready.flowId, 'owner').state).toBe('checking') })
    resolveReadiness(true)
    await vi.waitFor(() => { expect(readyFixture.flow.describe(ready.flowId, 'owner').state).toBe('ready') })
    expect(() => readyFixture.flow.describe(ready.flowId, 'another-owner')).toThrow('auth flow not found')

    const failedFixture = terminalFixture()
    const failed = await failedFixture.flow.create({ ownerPrincipalId: 'owner', machineId: 'machine', connectionIdentityDigest: 'digest', argv: ['ssh', 'cluster'], cwd: '/tmp', expiresInMs: 30_000 })
    failedFixture.output.emit('data', 'Permission denied')
    failedFixture.resolveDone()
    await vi.waitFor(() => { expect(failedFixture.flow.describe(failed.flowId, 'owner').state).toBe('failed') })
    const terminalReplay: string[] = []
    failedFixture.flow.subscribe(failed.flowId, 'owner', bytes => { terminalReplay.push(Buffer.from(bytes).toString('utf8')) })
    expect(terminalReplay.join('')).toBe('Permission denied')

    const cancelledFixture = terminalFixture()
    const cancelled = await cancelledFixture.flow.create({ ownerPrincipalId: 'owner', machineId: 'machine', connectionIdentityDigest: 'digest', argv: ['ssh', 'cluster'], cwd: '/tmp', expiresInMs: 30_000 })
    await cancelledFixture.flow.cancel(cancelled.flowId, 'owner')
    expect(cancelledFixture.flow.describe(cancelled.flowId, 'owner').state).toBe('cancelled')
  })

  it('does not overwrite an expired tombstone when terminal termination settles done', async () => {
    vi.useFakeTimers()
    try {
      const fixture = terminalFixture(async () => true)
      const view = await fixture.flow.create({ ownerPrincipalId: 'owner', machineId: 'machine', connectionIdentityDigest: 'digest', argv: ['ssh', 'cluster'], cwd: '/tmp', expiresInMs: 30_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(fixture.flow.describe(view.flowId, 'owner').state).toBe('expired')
      await Promise.resolve()
      expect(fixture.flow.describe(view.flowId, 'owner').state).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('security and scientific results', () => {
  it('builds fixed OpenSSH argv', () => {
    const socket = controlSocketPath('/tmp/s', 'user@example')
    const target = { alias: 'cluster', controlMode: 'app-managed' as const, connectTimeoutSeconds: 10, keepaliveSeconds: 30, controlPersistSeconds: 43_200 }
    expect(sshBaseArgv(target, socket)).toContain('BatchMode=yes')
    expect(sshBaseArgv(target, socket)).toContain('ControlPersist=43200')
    expect(remoteHelperArgv(target, '/opt/dsh-slop/helper', socket).at(-1)).toBe('--stdio-json-v1')
    expect(() => sshBaseArgv({ ...target, alias: 'cluster;id' }, socket)).toThrow()
    expect(sshBaseArgv({ ...target, alias: 'alice@login.cluster.example.edu' }, socket)).toContain('alice@login.cluster.example.edu')
    expect(sshBaseArgv({ ...target, alias: 'alice@login.cluster.example.edu', port: 2222, keepaliveMisses: 5 }, socket)).toEqual(expect.arrayContaining(['-p', '2222', 'ServerAliveCountMax=5']))
    const identityArgv = sshBaseArgv({ ...target, localKeyFilePath: '/Users/alice/SSH Keys/id_ed25519' }, socket)
    const identityAt = identityArgv.indexOf('-i')
    expect(identityArgv.slice(identityAt, identityAt + 2)).toEqual(['-i', '/Users/alice/SSH Keys/id_ed25519'])
    expect(identityAt).toBeLessThan(identityArgv.indexOf('--'))
    expect(() => sshBaseArgv({ ...target, localKeyFilePath: 'relative/id_ed25519' }, socket)).toThrow(/absolute/)
    expect(() => sshBaseArgv({ ...target, localKeyFilePath: '/tmp/key\n-oProxyCommand=bad' }, socket)).toThrow(/invalid local SSH key/)
    expect(() => sshBaseArgv({ ...target, alias: 'alice@login;id' }, socket)).toThrow()
    expect(() => sshBaseArgv({ ...target, controlPersistSeconds: 0 }, socket)).toThrow(/control persist/)
  })

  it('keeps app-owned ControlMaster sockets below the macOS Unix path limit', () => {
    const longInstanceRoot = '/Users/example/Documents/a-deliberately-long-workspace/runtime/dsh-slop/slop/execution'
    const root = controlSocketRoot(longInstanceRoot, 501)
    const socket = controlSocketPath(root, 'a'.repeat(64))
    expect(root).toMatch(/^\/tmp\/dsh-slop-501-[a-f0-9]{16}$/)
    expect(controlSocketRoot(longInstanceRoot, 501)).toBe(root)
    expect(controlSocketRoot(`${longInstanceRoot}-other`, 501)).not.toBe(root)
    expect(Buffer.byteLength(`${socket}.Br6eLR57SkpPcw2g`)).toBeLessThanOrEqual(103)
    expect(() => controlSocketPath(`${longInstanceRoot}/ssh-sockets`, 'identity')).toThrow(/safe limit/)
    expect(() => controlSocketPath('relative/socket-root', 'identity')).toThrow(/absolute/)
    expect(() => controlSocketPath(`/tmp/${'é'.repeat(30)}`, 'identity')).toThrow(/safe limit/)
  })

  it('stores artifacts and distinguishes invalid validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-artifact-'))
    const store = new LocalArtifactStore(root)
    const artifact = await store.putBytes(new TextEncoder().encode('{"energy":-1}'))
    expect(new TextDecoder().decode(await store.read(artifact.sha256, 0, 100))).toContain('energy')
    const validation = await runValidationChecks(root, [{ kind: 'required-file', relativePath: 'missing' }, { kind: 'numeric-range', name: 'force', value: 2, max: 1 }])
    expect(validation.outcome).toBe('invalid')
  })
})
