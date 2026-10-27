import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlSocketRoot } from '@dsh-slop/operations'
import {
  LOCAL_OWNER_PRINCIPAL_ID,
  RelationalAuthority,
  accessProfileIdSchema,
  accessProfileSchema,
  createUuidV7,
  jsonValueSchema,
  machineIdSchema,
  redesignMachineSchema,
  toInstant,
  type AccessProfile,
  type RedesignMachine,
} from '@dsh-slop/core'
import {
  MachineAuthenticationRequiredError,
  MachineService,
} from '../src/machine-service.ts'
import { AuthorityMachineProfileSource } from '../src/machine-host.ts'
import { ScriptedProcessDriver } from '../src/process-driver.ts'
import { OpenSshBroker, SshConnectionError } from '../src/ssh-broker.ts'
import type {
  AuthFlowRequest,
  CapturedProcess,
  ConnectionProfileSource,
  SshConnectionProfile,
} from '../src/types.ts'

const roots: string[] = []
const authorities: RelationalAuthority[] = []

interface SeededTarget {
  readonly machine: RedesignMachine
  readonly access: Extract<AccessProfile, { readonly kind: 'ssh' }>
}

// The scripted SSH backend also supplies the WSL directory-check handshake.
function machineDriver(handler: ConstructorParameters<typeof ScriptedProcessDriver>[0]): ScriptedProcessDriver {
  return new ScriptedProcessDriver(request => {
    if (request.argv[0] === 'sh' && request.argv[3] === 'dsh-slop-socket-root') {
      return { exitCode: 0, stdout: Buffer.from('dsh-slop-wsl-ready\n') }
    }
    return handler(request)
  })
}

async function fixture(
  handler: ConstructorParameters<typeof ScriptedProcessDriver>[0],
): Promise<{
  readonly root: string
  readonly authority: RelationalAuthority
  readonly driver: ScriptedProcessDriver
  readonly service: MachineService
  readonly broker: OpenSshBroker
}> {
  const root = await mkdtemp(join(tmpdir(), 'slop-machine-service-'))
  roots.push(root)
  const authority = await RelationalAuthority.open(join(root, 'authority'))
  authorities.push(authority)
  const driver = machineDriver(handler)
  const profiles = new AuthorityMachineProfileSource(authority, join(root, 'trust'))
  const broker = new OpenSshBroker(profiles, driver, controlSocketRoot(root), root)
  return {
    root,
    authority,
    driver,
    broker,
    service: new MachineService({ authority, broker }),
  }
}

function seedTarget(
  authority: RelationalAuthority,
  input: {
    readonly name: string
    readonly host: string
    readonly keyPath?: string
    readonly controlOwnership?: 'app-managed' | 'direct'
    readonly idleSeconds?: number
  },
): SeededTarget {
  const now = toInstant()
  const access = accessProfileSchema.parse({
    schemaVersion: 1,
    id: accessProfileIdSchema.parse(createUuidV7()),
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    kind: 'ssh',
    target: { kind: 'endpoint', host: input.host, user: 'alice', port: 22 },
    controlOwnership: input.controlOwnership ?? 'app-managed',
    trustPolicy: { kind: 'user-known-hosts' },
    vpn: { kind: 'none' },
    authentication: input.keyPath === undefined
      ? { kind: 'interactive' }
      : { kind: 'ssh-agent', localKeyFilePath: input.keyPath },
    timeouts: {
      connectSeconds: 30,
      keepaliveSeconds: 30,
      keepaliveMisses: 3,
      idleSeconds: input.idleSeconds ?? 600,
    },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  if (access.kind !== 'ssh') throw new Error('test setup did not create SSH access')
  const machine = redesignMachineSchema.parse({
    schemaVersion: 1,
    id: machineIdSchema.parse(createUuidV7()),
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    accessProfileId: access.id,
    name: input.name,
    declaredRoots: [{ id: 'work', role: 'work', label: 'Work', path: { kind: 'remote', path: '/work/alice' } }],
    revision: 1,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
  })
  authority.transact({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    mutations: [
      { kind: 'insert', domain: 'access-profile', id: access.id, value: jsonValueSchema.parse(access) },
      { kind: 'insert', domain: 'machine', id: machine.id, value: jsonValueSchema.parse(machine) },
    ],
  })
  return { machine, access }
}

function sshAlias(argv: readonly string[]): string | undefined {
  const separator = argv.lastIndexOf('--')
  return separator < 0 ? undefined : argv[separator + 1]
}

function controlPath(argv: readonly string[]): string | undefined {
  const direct = argv.find(value => value.startsWith('ControlPath='))
  if (direct !== undefined) return direct.slice('ControlPath='.length)
  const socket = argv.indexOf('-S')
  return socket < 0 ? undefined : argv[socket + 1]
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async authority => { await authority.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('MachineService', () => {
  it('closes owned masters on component disposal without issuing a scheduler cancellation', async () => {
    const { authority, broker, driver } = await fixture(() => ({ exitCode: 0 }))
    const owned = seedTarget(authority, { name: 'Owned', host: 'owned.example' })
    const direct = seedTarget(authority, { name: 'Direct', host: 'direct.example', controlOwnership: 'direct' })
    await broker.connect(owned.machine.id, LOCAL_OWNER_PRINCIPAL_ID)
    await broker.connect(direct.machine.id, LOCAL_OWNER_PRINCIPAL_ID)
    const before = driver.requests.length
    await broker.close()
    expect(driver.requests.slice(before)).toHaveLength(1)
    expect(driver.requests[before]?.argv).toEqual(expect.arrayContaining(['-O', 'exit']))
    expect(driver.requests[before]?.argv.some(arg => /scancel|qdel/.test(arg))).toBe(false)
    await expect(broker.connect(owned.machine.id, LOCAL_OWNER_PRINCIPAL_ID)).rejects.toThrow('disabled')
  })

  it('uses the configured idle horizon above the app-managed minimum', async () => {
    const liveSockets = new Set<string>()
    const { authority, driver, service } = await fixture(request => {
      const path = controlPath(request.argv)
      if (request.argv.includes('-O') && request.argv.includes('check')) {
        return { exitCode: path !== undefined && liveSockets.has(path) ? 0 : 255 }
      }
      if (request.argv.includes('-M') && path !== undefined) liveSockets.add(path)
      return { exitCode: 0 }
    })
    const target = seedTarget(authority, {
      name: 'Long-lived',
      host: 'long-lived.example.org',
      idleSeconds: 86_400,
    })

    await service.execute({ machineId: target.machine.id, command: 'true' })

    const remote = driver.requests.find(request => request.argv[0] === 'ssh' && request.argv.includes('sh'))
    expect(remote?.argv).toContain('ControlPersist=86400')
  })

  it('does not adopt a legacy app-managed master with a shorter effective policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-master-policy-'))
    roots.push(root)
    const machineId = machineIdSchema.parse(createUuidV7())
    const idleTimeoutSeconds = 43_200
    const source: ConnectionProfileSource = {
      async get(): Promise<SshConnectionProfile> {
        return {
          machineId,
          revision: 1,
          alias: 'policy.example.org',
          trust: { mode: 'user-known-hosts', expectedFingerprints: [] },
          ownership: 'app-managed',
          connectTimeoutSeconds: 30,
          keepaliveSeconds: 30,
          keepaliveMisses: 3,
          idleTimeoutSeconds,
          concurrencyLimit: 8,
        }
      },
    }
    const checkedPaths: string[] = []
    const bootstrapPaths: string[] = []
    const liveSockets = new Set<string>()
    const driver = machineDriver(request => {
      const path = controlPath(request.argv)
      if (request.argv.includes('-O') && request.argv.includes('check')) {
        if (path === undefined) return { exitCode: 255 }
        checkedPaths.push(path)
        if (checkedPaths.length === 2) {
          return { exitCode: 0, stderr: Buffer.from('Master running (pid=123)') }
        }
        return { exitCode: liveSockets.has(path) ? 0 : 255 }
      }
      if (request.argv[0] === '/bin/ps') {
        const legacyPath = checkedPaths[1]
        return {
          exitCode: 0,
          stdout: Buffer.from(`ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ControlPersist=300 -o ControlPath=${legacyPath} -- policy.example.org`),
        }
      }
      if (request.argv.includes('-M') && path !== undefined) {
        bootstrapPaths.push(path)
        liveSockets.add(path)
      }
      return { exitCode: 0 }
    })
    const socketRoot = controlSocketRoot(root)
    const upgraded = new OpenSshBroker(source, driver, socketRoot, root)
    await upgraded.reconcileStatus(machineId)
    const upgradedLease = await upgraded.connect(machineId, LOCAL_OWNER_PRINCIPAL_ID)
    await upgraded.release(upgradedLease.id, LOCAL_OWNER_PRINCIPAL_ID)

    expect(checkedPaths.length).toBeGreaterThanOrEqual(4)
    expect(new Set(checkedPaths.slice(0, 2)).size).toBe(2)
    expect(bootstrapPaths).toHaveLength(1)
    expect(driver.requests.find(request => request.argv.includes('-M')
      && request.argv.includes('ControlPersist=43200'))).toBeDefined()
  })

  it('reuses a compatible legacy app-managed master after a host upgrade', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-compatible-master-policy-'))
    roots.push(root)
    const machineId = machineIdSchema.parse(createUuidV7())
    const source: ConnectionProfileSource = {
      async get(): Promise<SshConnectionProfile> {
        return {
          machineId,
          revision: 1,
          alias: 'compatible.example.org',
          trust: { mode: 'user-known-hosts', expectedFingerprints: [] },
          ownership: 'app-managed',
          connectTimeoutSeconds: 30,
          keepaliveSeconds: 30,
          keepaliveMisses: 3,
          idleTimeoutSeconds: 43_200,
          concurrencyLimit: 8,
        }
      },
    }
    const checkedPaths: string[] = []
    let legacyPath = ''
    const driver = machineDriver(request => {
      const path = controlPath(request.argv)
      if (request.argv.includes('-O') && request.argv.includes('check')) {
        if (path === undefined) return { exitCode: 255 }
        checkedPaths.push(path)
        if (checkedPaths.length === 2) {
          legacyPath = path
          return { exitCode: 0, stderr: Buffer.from('Master running (pid=456)') }
        }
        return { exitCode: path === legacyPath ? 0 : 255 }
      }
      if (request.argv[0] === '/bin/ps') {
        return {
          exitCode: 0,
          stdout: Buffer.from(`ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ControlPersist=43200 -o ControlPath=${legacyPath} -M -N -f -- compatible.example.org`),
        }
      }
      if (request.argv[0] === 'ssh' && request.argv.includes('sh')) return { exitCode: 0, stdout: Buffer.from('reused\n') }
      return { exitCode: 0 }
    })
    const broker = new OpenSshBroker(source, driver, controlSocketRoot(root), root)

    const lease = await broker.connect(machineId, LOCAL_OWNER_PRINCIPAL_ID)
    const result = await broker.run(lease.id, ['sh', '-lc', 'true'], undefined, 5_000, 64 * 1024)
    await broker.release(lease.id, LOCAL_OWNER_PRINCIPAL_ID)

    expect(Buffer.from(result.stdout).toString('utf8')).toBe('reused\n')
    expect(driver.requests.filter(request => request.argv.includes('-M'))).toHaveLength(0)
    expect(driver.requests.find(request => request.argv[0] === 'ssh' && request.argv.includes('sh'))?.argv).toContain(`ControlPath=${legacyPath}`)
  })

  it('recovers an auth-required connection when a compatible managed master appears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-late-compatible-master-'))
    roots.push(root)
    const machineId = machineIdSchema.parse(createUuidV7())
    const profile: SshConnectionProfile = {
      machineId,
      revision: 1,
      alias: 'late-master.example.org',
      trust: { mode: 'user-known-hosts', expectedFingerprints: [] },
      ownership: 'app-managed',
      connectTimeoutSeconds: 30,
      keepaliveSeconds: 30,
      keepaliveMisses: 3,
      idleTimeoutSeconds: 43_200,
      concurrencyLimit: 8,
    }
    let legacyAvailable = false
    let legacyPath = ''
    let availableChecks = 0
    const driver = machineDriver(request => {
      const path = controlPath(request.argv)
      if (request.argv.includes('-O') && request.argv.includes('check')) {
        if (!legacyAvailable || path === undefined) return { exitCode: 255 }
        availableChecks += 1
        if (availableChecks === 1) return { exitCode: 255 }
        legacyPath = path
        return { exitCode: 0, stderr: Buffer.from('Master running (pid=789)') }
      }
      if (request.argv[0] === '/bin/ps') {
        return {
          exitCode: 0,
          stdout: Buffer.from(`ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ControlPersist=43200 -o ControlPath=${legacyPath} -M -N -f -- late-master.example.org`),
        }
      }
      if (request.argv.includes('-M')) {
        return { exitCode: 255, stderr: Buffer.from('Permission denied (publickey,password).') }
      }
      return { exitCode: 0 }
    })
    const broker = new OpenSshBroker({ get: async () => profile }, driver, controlSocketRoot(root), root)

    await expect(broker.connect(machineId, LOCAL_OWNER_PRINCIPAL_ID)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    expect(broker.status(machineId).state).toBe('auth-required')

    legacyAvailable = true
    await expect(broker.reconcileStatus(machineId)).resolves.toMatchObject({ state: 'ready' })
    expect(driver.requests.some(request => request.argv[0] === '/bin/ps')).toBe(true)
  })

  it('isolates interleaved Machines, reuses each managed connection, and keeps a spaced key path as one argv value', async () => {
    const liveSockets = new Set<string>()
    const bootstraps: string[] = []
    const remoteRuns: string[] = []
    const { authority, driver, service } = await fixture(request => {
      const path = controlPath(request.argv)
      if (request.argv.includes('-O') && request.argv.includes('check')) {
        return { exitCode: path !== undefined && liveSockets.has(path) ? 0 : 255 }
      }
      if (request.argv.includes('-M')) {
        if (path !== undefined) liveSockets.add(path)
        bootstraps.push(sshAlias(request.argv) ?? 'missing')
        return { exitCode: 0 }
      }
      const alias = sshAlias(request.argv) ?? 'missing'
      remoteRuns.push(alias)
      return { exitCode: 0, stdout: Buffer.from(`${alias}\n`) }
    })
    const keyPath = '/tmp/keys with spaces/id_ed25519'
    const alpha = seedTarget(authority, { name: 'Alpha', host: 'alpha.example.org', keyPath })
    const beta = seedTarget(authority, { name: 'Beta', host: 'beta.example.org' })

    const alphaFirst = await service.execute({
      machineId: alpha.machine.id,
      command: 'printf alpha',
      workdir: '/work/alice/project with spaces',
    })
    const betaOnly = await service.execute({ machineId: beta.machine.id, command: 'printf beta' })
    const alphaSecond = await service.execute({ machineId: alpha.machine.id, command: 'hostname' })

    expect([alphaFirst.stdout, betaOnly.stdout, alphaSecond.stdout]).toEqual([
      'alice@alpha.example.org\n',
      'alice@beta.example.org\n',
      'alice@alpha.example.org\n',
    ])
    expect(bootstraps).toEqual(['alice@alpha.example.org', 'alice@beta.example.org'])
    expect(remoteRuns).toEqual(['alice@alpha.example.org', 'alice@beta.example.org', 'alice@alpha.example.org'])
    const alphaRemote = driver.requests.find(request => sshAlias(request.argv) === 'alice@alpha.example.org'
      && request.argv[0] === 'ssh' && request.argv.includes('sh'))
    expect(alphaRemote?.argv.filter(value => value === keyPath)).toEqual([keyPath])
    expect(alphaRemote?.argv).toContain('ControlPersist=43200')
    expect(alphaRemote?.argv.at(-1)).toContain('project with spaces')
    expect(alphaFirst).not.toHaveProperty('lease')
    expect(alphaFirst).not.toHaveProperty('connectionRef')

    await expect(service.connectionStatus(alpha.machine.id)).resolves.toMatchObject({
      kind: 'ssh',
      machineId: alpha.machine.id,
      state: 'ready',
    })
  })

  it('surfaces interactive SSH failure as a typed error accepted by the protected auth flow', async () => {
    const { authority, service } = await fixture(request => {
      if (request.argv.includes('-O') && request.argv.includes('check')) return { exitCode: 255 }
      return {
        exitCode: 255,
        stderr: Buffer.from('Permission denied (publickey,keyboard-interactive).'),
      }
    })
    const target = seedTarget(authority, { name: '2FA cluster', host: 'two-factor.example.org' })

    try {
      await service.execute({ machineId: target.machine.id, command: 'hostname' })
      throw new Error('expected protected authentication requirement')
    } catch (error) {
      expect(error).toBeInstanceOf(MachineAuthenticationRequiredError)
      expect(error).toBeInstanceOf(SshConnectionError)
      expect(error).toMatchObject({
        kind: 'authentication-required',
        code: 'AUTH_REQUIRED',
        machineId: target.machine.id,
        machineRevision: 1,
        accessProfileRevision: 1,
      })
    }
  })

  it('recreates a purged socket root before interactive authentication binds the master', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-machine-service-'))
    roots.push(root)
    const authority = await RelationalAuthority.open(join(root, 'authority'))
    authorities.push(authority)
    const socketRoot = controlSocketRoot(root)
    roots.push(socketRoot)
    const driver = machineDriver(request => request.argv.includes('-O')
      ? { exitCode: 255 }
      : { exitCode: 255, stderr: Buffer.from('Permission denied (keyboard-interactive).') })
    const begun: AuthFlowRequest[] = []
    const broker = new OpenSshBroker(new AuthorityMachineProfileSource(authority, join(root, 'trust')), driver, socketRoot, root, {
      begin: async request => { begun.push(request); return { flowId: 'flow', expiresAt: new Date(Date.now() + 60_000).toISOString() } },
      status: async () => ({ state: 'pending' }),
      cancel: async () => undefined,
    })
    const target = seedTarget(authority, { name: '2FA cluster', host: 'two-factor.example.org' })

    const rootChecks = () => driver.requests.filter(request => request.argv[3] === 'dsh-slop-socket-root').length

    await expect(broker.connect(target.machine.id, LOCAL_OWNER_PRINCIPAL_ID)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    const checksBeforeAuth = rootChecks()
    // On Windows the root lives inside WSL, so recovery is the repeated WSL check.
    if (process.platform !== 'win32') await rm(socketRoot, { recursive: true })
    await broker.beginAuth(target.machine.id, LOCAL_OWNER_PRINCIPAL_ID)

    if (process.platform === 'win32') expect(rootChecks()).toBeGreaterThan(checksBeforeAuth)
    else expect((await stat(socketRoot)).isDirectory()).toBe(true)
    expect(controlPath(begun[0]!.bootstrapArgv)?.startsWith(`${socketRoot}/`)).toBe(true)
  })

  it('keeps channel failure diagnostics and does not replay a possibly executed command', async () => {
    const { authority, service, driver } = await fixture(request => request.argv[0] === 'ssh' && request.argv.includes('sh')
      ? { exitCode: 255, stderr: Buffer.from('\u001b[31mmux_client_request_session: read from master failed: Broken pipe\u001b[0m') }
      : { exitCode: 0 })
    const target = seedTarget(authority, { name: 'Cluster', host: 'cluster.example' })
    await expect(service.execute({ machineId: target.machine.id, command: 'echo changed > result.txt' })).rejects.toThrow('remote command may have run')
    expect(driver.requests.filter(request => request.argv[0] === 'ssh' && request.argv.includes('sh'))).toHaveLength(1)
    expect(service.connectionStatus(target.machine.id)).resolves.toBeDefined()
  })

  it('reports DNS connection failures with their bounded diagnostic', async () => {
    const { authority, service } = await fixture(() => ({ exitCode: 255, stderr: Buffer.from('ssh: Could not resolve hostname cluster.example: nodename nor servname provided') }))
    const target = seedTarget(authority, { name: 'Cluster', host: 'cluster.example' })
    await expect(service.execute({ machineId: target.machine.id, command: 'true' })).rejects.toThrow('Could not resolve hostname')
  })

  it('starts a new managed connection when the durable AccessProfile revision changes', async () => {
    const liveSockets = new Set<string>()
    let bootstraps = 0
    const { authority, service } = await fixture(request => {
      const path = controlPath(request.argv)
      if (request.argv.includes('-O') && request.argv.includes('check')) {
        return { exitCode: path !== undefined && liveSockets.has(path) ? 0 : 255 }
      }
      if (request.argv.includes('-M')) {
        if (path !== undefined) liveSockets.add(path)
        bootstraps += 1
      }
      return { exitCode: 0 }
    })
    const target = seedTarget(authority, { name: 'Revisioned', host: 'revisioned.example.org' })

    await service.execute({ machineId: target.machine.id, command: 'true' })
    const updatedAccess = accessProfileSchema.parse({
      ...target.access,
      revision: 2,
      timeouts: { ...target.access.timeouts, connectSeconds: 45 },
      updatedAt: toInstant(),
    })
    authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{
        kind: 'replace',
        domain: 'access-profile',
        id: updatedAccess.id,
        expectedRevision: target.access.revision,
        value: jsonValueSchema.parse(updatedAccess),
      }],
    })

    const result = await service.execute({ machineId: target.machine.id, command: 'true' })

    expect(result.accessProfileRevision).toBe(2)
    expect(bootstraps).toBe(2)
  })

  it('forwards timeout and cancellation while preserving content and normalizing only terminal controls', async () => {
    let remoteRequest: Parameters<ConstructorParameters<typeof ScriptedProcessDriver>[0]>[0] | undefined
    const captured: Partial<CapturedProcess> = {
      exitCode: 255,
      signal: null,
      timedOut: true,
      stdout: Buffer.from('API_TOKEN=plain-secret\u001b[31m red\u001b[0m\r\nnext\0line\n'),
      stderr: Buffer.from('password=hunter2\u001b]0;window-title\u0007\n'),
    }
    const { authority, service } = await fixture(request => {
      if (request.argv[0] === 'ssh' && request.argv.includes('sh')) {
        remoteRequest = request
        return captured
      }
      return { exitCode: 0 }
    })
    const target = seedTarget(authority, {
      name: 'Direct cluster',
      host: 'direct.example.org',
      controlOwnership: 'direct',
    })
    const controller = new AbortController()

    const result = await service.execute({
      machineId: target.machine.id,
      command: 'printf API_TOKEN=plain-secret',
      timeoutMs: 3_210,
      signal: controller.signal,
    })

    expect(result).toMatchObject({
      exitCode: 255,
      signal: null,
      timedOut: true,
      stdout: 'API_TOKEN=plain-secret red\nnextline\n',
      stderr: 'password=hunter2\n',
    })
    expect(remoteRequest?.timeoutMs).toBe(3_210)
    expect(remoteRequest?.signal).toBe(controller.signal)
    expect(remoteRequest?.argv.at(-1)).toContain('API_TOKEN=plain-secret')
    expect(result.stdout).not.toContain('[REDACTED')
    expect(result.stderr).not.toContain('[REDACTED')
  })
})
