import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_OWNER_PRINCIPAL_ID as OWNER, asPrincipalId, machineIdSchema } from '@dsh-slop/core'
import { DshAuthFlowAdapter } from '../src/auth-adapter.ts'
import { NativeAuthFlow } from '../src/native-auth-flow.ts'
import { NativeSshBroker } from '../src/native-ssh-broker.ts'
import { nativeSftpTransfer } from '../src/native-sftp-transfer.ts'
import { MachineTransferService } from '../src/machine-transfer-service.ts'
import { persistPinnedKnownHost } from '../src/ssh-broker.ts'
import { sshFingerprint } from '../src/native-ssh-trust.ts'
import type { SshConnectionProfile } from '../src/types.ts'
import { fixtureKey, nativeServer, nativeAgent, parsedKey } from './native-ssh-fixture.ts'
import { randomUUID, createPrivateKey } from 'node:crypto'
import { nativeAlgorithms } from '../src/native-ssh-algorithms.ts'

const KEY = machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a1')
const INTERACTIVE = machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a2')
const OTHER = machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a3')
let root: string, keyPath: string, trustPath: string, broker: NativeSshBroker, auth: NativeAuthFlow, adapter: DshAuthFlowAdapter, transfer: MachineTransferService
let server: Awaited<ReturnType<typeof nativeServer>>, other: Awaited<ReturnType<typeof nativeServer>>
let profiles: Map<string, SshConnectionProfile>
let agentPath: string | undefined

beforeEach(async () => {
  // macOS tmpdir() commonly traverses /var -> /private/var. The transfer
  // correctly rejects symlink destinations, so use the fixture's real path.
  root = await realpath(await mkdtemp(join(tmpdir(), 'slop native SSH ')))
  agentPath = undefined
  const hostKey = fixtureKey(), userKey = fixtureKey(), publicKey = parsedKey(hostKey)
  keyPath = join(root, 'private key.pem'); trustPath = join(root, 'approved known_hosts')
  await writeFile(keyPath, userKey)
  await mkdir(join(root, 'server')); await mkdir(join(root, 'other'))
  server = await nativeServer(join(root, 'server'), hostKey, userKey)
  other = await nativeServer(join(root, 'other'), hostKey, userKey)
  const fingerprint = sshFingerprint(publicKey.getPublicSSH())
  await persistPinnedKnownHost(trustPath, `[127.0.0.1]:${server.port},[127.0.0.1]:${other.port} ${publicKey.type} ${publicKey.getPublicSSH().toString('base64')}\n`, fingerprint, [fingerprint])
  profiles = new Map([KEY, INTERACTIVE, OTHER].map(machineId => [machineId, {
    machineId, revision: 1, alias: machineId === INTERACTIVE ? 'interactive' : 'key', port: machineId === OTHER ? other.port : server.port,
    ...(machineId === INTERACTIVE ? {} : { localKeyFilePath: keyPath }), trust: { mode: 'pinned', expectedFingerprints: [fingerprint], appKnownHostsPath: trustPath }, ownership: 'app-managed', connectTimeoutSeconds: 3, keepaliveSeconds: 30, idleTimeoutSeconds: 43200, concurrencyLimit: 8,
  }]))
  auth = new NativeAuthFlow(async (request, prompt) => broker.authenticate(machineIdSchema.parse(request.machineId), request.connectionIdentityDigest, prompt))
  adapter = new DshAuthFlowAdapter(auth)
  broker = new NativeSshBroker({ get: async id => profiles.get(id) }, async profile => ({ host: '127.0.0.1', port: profile.port!, username: profile.alias, identityFiles: profile.localKeyFilePath === undefined ? [] : [profile.localKeyFilePath], knownHostsFiles: [], algorithms: nativeAlgorithms(() => undefined), ...(agentPath === undefined ? {} : { agent: agentPath }) }), adapter, root)
  transfer = new MachineTransferService({ broker, cwd: root, subprocess: { spawnTerminal: () => { throw new Error('Native backend must not start a terminal, ssh, scp or WSL') } } as never, nativeTransfer: nativeSftpTransfer(broker) })
})

afterEach(async () => {
  await transfer?.close(); await auth?.close(); await broker?.close()
  await server?.close(); await other?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('native SSH protocol journeys', () => {
  it('falls back from an unavailable agent to the configured key file', async () => {
    agentPath = process.platform === 'win32' ? `\\\\.\\pipe\\slop-missing-agent-${randomUUID()}` : join(root, 'missing-agent.sock')
    const lease = await broker.connect(KEY, OWNER)
    try {
      expect((await broker.run(lease.id, ['probe'], undefined, 2000, 4096)).exitCode).toBe(0)
      expect(server.authenticated).toHaveLength(1)
    } finally { await broker.release(lease.id, OWNER) }
  })

  it('falls back from an unavailable agent to protected password and 2FA', async () => {
    agentPath = process.platform === 'win32' ? `\\\\.\\pipe\\slop-missing-agent-${randomUUID()}` : join(root, 'missing-agent.sock')
    await expect(broker.connect(INTERACTIVE, OWNER)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    const created = await broker.beginAuth(INTERACTIVE, OWNER)
    let transcript = '', password = false, code = false
    auth.subscribe(created.flowId, OWNER, bytes => {
      transcript += Buffer.from(bytes).toString()
      if (!password && transcript.includes('Password:')) { password = true; void auth.write(created.flowId, OWNER, 'fixture-password\r') }
      if (!code && transcript.includes('Verification code:')) { code = true; void auth.write(created.flowId, OWNER, '654321\r') }
    })
    await vi.waitFor(async () => expect(await adapter.status(created.flowId, OWNER)).toEqual({ state: 'ready' }), { timeout: 5000 })
    expect(password && code).toBe(true)
    expect(transcript).not.toContain('fixture-password'); expect(transcript).not.toContain('654321')
    const lease = await broker.connect(INTERACTIVE, OWNER)
    try {
      expect((await broker.run(lease.id, ['probe'], undefined, 2000, 4096)).exitCode).toBe(0)
      expect(server.authenticated).toHaveLength(1)
    } finally { await broker.release(lease.id, OWNER) }
  })

  it('authenticates with the Windows named-pipe agent without reading a private key', async () => {
    agentPath = process.platform === 'win32' ? `\\\\.\\pipe\\slop-agent-${randomUUID()}` : join(root, 'agent.sock')
    const agent = await nativeAgent(agentPath, await readFile(keyPath, 'utf8'))
    const { localKeyFilePath: _keyPath, ...profile } = profiles.get(KEY)!
    profiles.set(KEY, profile)
    await rm(keyPath)
    try {
      for (let index = 0; index < 2; index++) {
        const lease = await broker.connect(KEY, OWNER)
        expect((await broker.run(lease.id, ['probe'], undefined, 2000, 4096)).exitCode).toBe(0)
        await broker.release(lease.id, OWNER)
      }
      expect(agent.signatures).toBe(1); expect(server.authenticated).toHaveLength(1)
    } finally { await agent.close() }
  })

  it('requests an encrypted key passphrase only through protected input', async () => {
    const encrypted = createPrivateKey(await readFile(keyPath)).export({ format: 'pem', type: 'pkcs1', cipher: 'aes-256-cbc', passphrase: 'fixture-passphrase' })
    await writeFile(keyPath, encrypted)
    await expect(broker.connect(KEY, OWNER)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    const created = await broker.beginAuth(KEY, OWNER)
    let transcript = '', sent = false
    auth.subscribe(created.flowId, OWNER, bytes => {
      transcript += Buffer.from(bytes).toString()
      if (!sent && transcript.includes('Private key passphrase:')) { sent = true; void auth.write(created.flowId, OWNER, 'fixture-passphrase\r') }
    })
    await vi.waitFor(async () => expect(await adapter.status(created.flowId, OWNER)).toEqual({ state: 'ready' }))
    expect(transcript).not.toContain('fixture-passphrase')
    expect(server.authenticated).toHaveLength(1)
  })

  it('reuses key authentication for concurrent commands and preserves exit status 255', async () => {
    const leases = await Promise.all([broker.connect(KEY, OWNER), broker.connect(KEY, OWNER)])
    const results = await Promise.all(leases.map(lease => broker.run(lease.id, ['probe'], undefined, 2000, 4096)))
    expect(results.every(result => Buffer.from(result.stdout).toString() === 'fixture-stdout\n')).toBe(true)
    expect(Buffer.from(results[0]!.stderr).toString()).toBe('fixture-stderr\n')
    expect(server.authenticated).toHaveLength(1)
    const failedCommand = await broker.run(leases[0]!.id, ['status255'], undefined, 2000, 4096)
    expect(failedCommand.exitCode).toBe(255)
    expect(broker.status(KEY).state).toBe('ready')
    for (const lease of leases) await broker.release(lease.id, OWNER)
  })

  it('authenticates password plus 2FA through the protected socket once, without echo or cross-owner access', async () => {
    await expect(broker.connect(INTERACTIVE, OWNER)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    const created = await broker.beginAuth(INTERACTIVE, OWNER)
    await expect(adapter.status(created.flowId, asPrincipalId('other-owner'))).rejects.toThrow('not found')
    const socket = await adapter.openSocket({ principalId: OWNER, source: 'browser' })
    let transcript = '', password = false, code = false
    const reader = (async () => {
      for await (const frame of socket.frames) {
        if (!(frame instanceof Uint8Array)) continue
        transcript += Buffer.from(frame).toString()
        if (!password && transcript.includes('Password:')) { password = true; await socket.receiveBinary(Buffer.from('fixture-password\r')) }
        if (!code && transcript.includes('Verification code:')) { code = true; await socket.receiveBinary(Buffer.from('654321\r')) }
      }
    })()
    await socket.receive({ kind: 'subscribe', flowId: created.flowId })
    await vi.waitFor(async () => expect(await adapter.status(created.flowId, OWNER)).toEqual({ state: 'ready' }), { timeout: 5000 })
    expect(transcript).not.toContain('fixture-password'); expect(transcript).not.toContain('654321')
    for (let index = 0; index < 2; index++) {
      const lease = await broker.connect(INTERACTIVE, OWNER)
      expect((await broker.run(lease.id, ['probe'], undefined, 2000, 4096)).exitCode).toBe(0)
      await broker.release(lease.id, OWNER)
    }
    expect(server.authenticated).toHaveLength(1)
    await socket.close(); await reader
  })

  it('cancels a pending protected prompt and never publishes a ready connection', async () => {
    const created = await broker.beginAuth(INTERACTIVE, OWNER)
    let transcript = ''
    auth.subscribe(created.flowId, OWNER, bytes => { transcript += Buffer.from(bytes).toString() })
    await vi.waitFor(() => expect(transcript).toContain('Password:'))
    await adapter.cancel(created.flowId, OWNER)
    expect(await adapter.status(created.flowId, OWNER)).toEqual({ state: 'cancelled' })
    await expect(auth.write(created.flowId, OWNER, 'fixture-password\r')).rejects.toThrow('does not accept')
    await vi.waitFor(() => expect(broker.status(INTERACTIVE).state).not.toBe('connecting'))
    expect(server.authenticated).toHaveLength(0)
  })

  it('rejects missing trust, tampering and changed profile leases before dispatch', async () => {
    const profile = profiles.get(KEY)!
    profiles.set(KEY, { ...profile, trust: { mode: 'tofu', expectedFingerprints: [] } })
    await expect(broker.connect(KEY, OWNER)).rejects.toMatchObject({ code: 'HOST_KEY_REQUIRED' })
    const inspected = await broker.inspectHostKey(KEY)
    expect(inspected.fingerprint).toBe(profile.trust.expectedFingerprints[0])
    expect(server.authenticated).toHaveLength(0)
    profiles.set(KEY, profile)
    const lease = await broker.connect(KEY, OWNER)
    expect(() => broker.requireLease(lease.id, asPrincipalId('intruder'))).toThrow('another principal')
    await writeFile(trustPath, 'tampered\n')
    await expect(broker.run(lease.id, ['probe'], undefined, 2000, 4096)).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
    profiles.set(KEY, { ...profile, revision: 2 })
    await expect(broker.run(lease.id, ['probe'], undefined, 2000, 4096)).rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE' })
    expect(server.commands).toHaveLength(0)
  })

  it('bounds output and timeout without replaying commands or losing the reusable connection', async () => {
    const lease = await broker.connect(KEY, OWNER)
    const timeout = await broker.run(lease.id, ['hang'], undefined, 50, 4096)
    expect(timeout.timedOut).toBe(true)
    await expect(broker.run(lease.id, ['flood'], undefined, 2000, 1024)).rejects.toThrow('exceeded')
    expect((await broker.run(lease.id, ['probe'], undefined, 2000, 4096)).exitCode).toBe(0)
    expect(server.commands).toEqual(['hang', 'flood', 'probe'])
    expect(server.authenticated).toHaveLength(1)
  })

  it('streams upload, download, directories and Machine-to-Machine relay over authenticated SFTP', async () => {
    const payload = Buffer.alloc(150_000, 37), source = join(root, 'source file.bin'), destination = join(root, 'download file.bin')
    await writeFile(source, payload)
    const uploaded = await transfer.transfer({ source: { kind: 'local', path: source }, destination: { kind: 'machine', machineId: KEY, path: '/remote file.bin' } })
    expect(uploaded.exitCode, uploaded.terminalOutput).toBe(0)
    const relayed = await transfer.transfer({ source: { kind: 'machine', machineId: KEY, path: '/remote file.bin' }, destination: { kind: 'machine', machineId: OTHER, path: '/relayed file.bin' } })
    expect(relayed.exitCode, relayed.terminalOutput).toBe(0); expect(relayed.relayedThroughHost).toBe(true)
    const downloaded = await transfer.transfer({ source: { kind: 'machine', machineId: OTHER, path: '/relayed file.bin' }, destination: { kind: 'local', path: destination } })
    expect(downloaded.exitCode, downloaded.terminalOutput).toBe(0); expect(await readFile(destination)).toEqual(payload)
    await mkdir(join(root, 'folder')); await writeFile(join(root, 'folder', 'nested.txt'), 'nested')
    const directory = await transfer.transfer({ source: { kind: 'local', path: join(root, 'folder') }, destination: { kind: 'machine', machineId: KEY, path: '/folder' } })
    expect(directory.exitCode, directory.terminalOutput).toBe(0); expect(directory.entryKind).toBe('directory')
    expect(await readFile(join(root, 'server', 'folder', 'nested.txt'), 'utf8')).toBe('nested')
    expect(server.authenticated).toHaveLength(1); expect(other.authenticated).toHaveLength(1)
  }, 15_000)

  it('preserves authentication errors and rejects unsupported legacy SCP before copying', async () => {
    await writeFile(join(root, 'source'), 'fixture')
    const request = { source: { kind: 'local' as const, path: join(root, 'source') }, destination: { kind: 'machine' as const, machineId: INTERACTIVE, path: '/output' } }
    await expect(transfer.transfer(request)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    await expect(transfer.transfer({ ...request, protocol: 'scp' })).rejects.toThrow('Legacy SCP')
    expect(server.authenticated).toHaveLength(0)
  })

  it('settles stalled SFTP on its deadline and preserves the connection for a new operation', async () => {
    await writeFile(join(root, 'server', 'stalled.bin'), 'payload')
    const lease = await broker.connect(KEY, OWNER); await broker.release(lease.id, OWNER)
    server.state.stallReads = true
    const request = { source: { kind: 'machine' as const, machineId: KEY, path: '/stalled.bin' }, destination: { kind: 'local' as const, path: join(root, 'partial.bin') } }
    // The deadline must outlast SFTP subsystem setup, which can take a few hundred
    // milliseconds on a loaded host; only the stalled read may trip it.
    const timed = await transfer.transfer({ ...request, timeoutMs: 2_000 })
    expect(timed.timedOut).toBe(true); expect(timed.terminalOutput).toContain('partial destination')
    server.state.stallReads = false
    const completed = await transfer.transfer(request)
    expect(completed.exitCode, completed.terminalOutput).toBe(0)
    expect(server.authenticated).toHaveLength(1)
  })
  it('cancels stalled SFTP setup without retaining a ready connection', async () => {
    const lease = await broker.connect(KEY, OWNER); await broker.release(lease.id, OWNER)
    server.state.stallSftp = true
    const result = await transfer.transfer({ source: { kind: 'machine', machineId: KEY, path: '/input' }, destination: { kind: 'local', path: join(root, 'output') }, timeoutMs: 100 })
    expect(result.timedOut).toBe(true)
    await vi.waitFor(() => expect(broker.status(KEY).state).toBe('stale'))
  })
})
