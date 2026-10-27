import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  canonicalSha256,
  connectionLeaseIdSchema,
  machineIdSchema,
  type ConnectionLeaseId,
  type MachineId,
  type PrincipalId,
  type Sha256,
} from '@dsh-slop/core'
import { controlSocketPath, sshBaseArgv, validateLocalKeyFilePath, validateSshTarget, type OpenSshTarget } from '@dsh-slop/operations'
import type { AuthFlowSeam, ConnectionLeaseRecord, ConnectionProfileSource, ConnectionState, ProcessDriver, SshConnectionProfile } from './types.ts'
import { sshDiagnostic } from './ssh-diagnostic.ts'

interface LiveConnection {
  readonly profile: SshConnectionProfile
  readonly identityDigest: Sha256
  socketPath?: string
  state: ConnectionState
  message?: string
  leases: Map<ConnectionLeaseId, ConnectionLeaseRecord>
  channels: number
  connectPromise: Promise<void> | undefined
  reconcilePromise?: Promise<void>
  lastUsedAt: number
}

const APP_MANAGED_MASTER_POLICY_VERSION = 1

export class SshConnectionError extends Error {
  constructor(readonly code: 'HOST_KEY_REQUIRED' | 'HOST_KEY_CHANGED' | 'AUTH_REQUIRED' | 'CONNECTION_UNAVAILABLE', message: string) { super(message) }
}

function safeAlias(alias: string): void {
  validateSshTarget(alias)
}

export function profileIdentityDigest(profile: SshConnectionProfile): Sha256 {
  if (profile.localKeyFilePath !== undefined) validateLocalKeyFilePath(profile.localKeyFilePath)
  return canonicalSha256({
    revision: profile.revision,
    alias: profile.alias,
    ...(profile.port === undefined ? {} : { port: profile.port }),
    ...(profile.localKeyFilePath === undefined ? {} : { localKeyFilePath: profile.localKeyFilePath }),
    trust: profile.trust,
    ownership: profile.ownership,
    ...(profile.ownership === 'app-managed'
      ? {
          masterPolicy: {
            version: APP_MANAGED_MASTER_POLICY_VERSION,
            idleTimeoutSeconds: profile.idleTimeoutSeconds,
            keepaliveSeconds: profile.keepaliveSeconds,
            keepaliveMisses: profile.keepaliveMisses ?? 3,
          },
        }
      : {}),
  })
}

/** Socket identity used before app-managed master policy became part of the digest. */
function legacyProfileIdentityDigest(profile: SshConnectionProfile): Sha256 {
  if (profile.localKeyFilePath !== undefined) validateLocalKeyFilePath(profile.localKeyFilePath)
  return canonicalSha256({
    revision: profile.revision,
    alias: profile.alias,
    ...(profile.port === undefined ? {} : { port: profile.port }),
    ...(profile.localKeyFilePath === undefined ? {} : { localKeyFilePath: profile.localKeyFilePath }),
    trust: profile.trust,
    ownership: profile.ownership,
  })
}

function identityFileArgv(profile: SshConnectionProfile): readonly string[] {
  if (profile.localKeyFilePath === undefined) return []
  validateLocalKeyFilePath(profile.localKeyFilePath)
  return ['-i', profile.localKeyFilePath]
}

function openSshTarget(profile: SshConnectionProfile): OpenSshTarget {
  const common = {
    alias: profile.alias,
    connectTimeoutSeconds: profile.connectTimeoutSeconds,
    keepaliveSeconds: profile.keepaliveSeconds,
    ...(profile.port === undefined ? {} : { port: profile.port }),
    ...(profile.localKeyFilePath === undefined ? {} : { localKeyFilePath: profile.localKeyFilePath }),
    ...(profile.keepaliveMisses === undefined ? {} : { keepaliveMisses: profile.keepaliveMisses }),
    ...(profile.trust.appKnownHostsPath === undefined ? {} : { appKnownHosts: profile.trust.appKnownHostsPath }),
  }
  return profile.ownership === 'app-managed'
    ? { ...common, controlMode: profile.ownership, controlPersistSeconds: profile.idleTimeoutSeconds }
    : { ...common, controlMode: profile.ownership }
}

function uuidV7Like(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const now = BigInt(Date.now())
  for (let i = 0; i < 6; i++) bytes[5 - i] = Number((now >> BigInt(i * 8)) & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function stderrText(result: { stderr: Uint8Array }): string { return Buffer.from(result.stderr).toString('utf8') }

function classifySshFailure(stderr: string, stage: 'connect' | 'command' = 'connect'): SshConnectionError {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed.*changed/i.test(stderr)) return new SshConnectionError('HOST_KEY_CHANGED', 'The remote host key changed; ordinary reconnect is blocked.')
  if (/Host key verification failed|No .* host key is known|strict checking/i.test(stderr)) return new SshConnectionError('HOST_KEY_REQUIRED', 'The remote host key is not trusted.')
  if (/Permission denied|Authentication failed|keyboard-interactive|publickey,password/i.test(stderr)) return new SshConnectionError('AUTH_REQUIRED', 'Human authentication is required.')
  const diagnostic = sshDiagnostic(stderr)
  const context = stage === 'connect'
    ? 'OpenSSH could not establish the connection; no remote command was started.'
    : 'The SSH command channel ended with status 255. The remote command may have run; inspect its state before retrying a mutation.'
  return new SshConnectionError('CONNECTION_UNAVAILABLE', context + (diagnostic ? ` Diagnostic: ${diagnostic}` : ' OpenSSH returned no diagnostic.'))
}

/** Host-global OpenSSH ControlMaster broker with owner-bound channel leases. */
export class OpenSshBroker {
  private closed = false
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.connections.values()].flatMap(connection => [connection.connectPromise, connection.reconcilePromise].filter((task): task is Promise<void> => task !== undefined)))
    await Promise.all([...this.connections].filter(([, connection]) => connection.profile.ownership === 'app-managed').map(([id]) => this.closeOwned(id, true)))
    this.leaseIndex.clear()
    this.connections.clear()
  }
  private readonly connections = new Map<MachineId, LiveConnection>()
  private readonly leaseIndex = new Map<ConnectionLeaseId, LiveConnection>()
  private socketRootReady: Promise<void> | undefined

  constructor(
    private readonly profiles: ConnectionProfileSource,
    private readonly driver: ProcessDriver,
    private readonly socketRoot: string,
    private readonly cwd: string,
    private readonly authFlows?: AuthFlowSeam,
  ) {}

  async connect(machineIdInput: MachineId, principalId: PrincipalId, timeoutSeconds?: number): Promise<ConnectionLeaseRecord> {
    if (this.closed) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Machine component is disabled.')
    const machineId = machineIdSchema.parse(machineIdInput)
    const profile = await this.profiles.get(machineId)
    if (profile === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine has no SSH connection profile.')
    safeAlias(profile.alias)
    const identityDigest = profileIdentityDigest(profile)
    let connection = this.connections.get(machineId)
    if (connection === undefined || connection.identityDigest !== identityDigest) {
      const socketPath = profile.ownership === 'app-managed' ? controlSocketPath(this.socketRoot, identityDigest) : undefined
      connection = { profile, identityDigest, ...(socketPath === undefined ? {} : { socketPath }), state: 'disconnected', leases: new Map(), channels: 0, connectPromise: undefined, lastUsedAt: Date.now() }
      this.connections.set(machineId, connection)
    }
    if (profile.ownership === 'app-managed' && connection.state !== 'ready') {
      connection.reconcilePromise ??= this.reconcileOwnedMaster(connection).finally(() => {
        if (connection !== undefined) delete connection.reconcilePromise
      })
    }
    await connection.reconcilePromise
    if (connection.state !== 'ready') {
      connection.connectPromise ??= this.establish(connection, timeoutSeconds).finally(() => { if (connection !== undefined) connection.connectPromise = undefined })
      await connection.connectPromise
    }
    if (this.closed) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Machine component is disabled.')
    if (connection.channels >= profile.concurrencyLimit) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine connection channel limit is reached.')
    const id = connectionLeaseIdSchema.parse(uuidV7Like())
    const acquiredAt = new Date().toISOString()
    const lease: ConnectionLeaseRecord = {
      id,
      ownerPrincipalId: principalId,
      machineId,
      identityDigest,
      acquiredAt,
      expiresAt: new Date(Date.now() + profile.idleTimeoutSeconds * 1_000).toISOString(),
    }
    connection.leases.set(id, lease)
    connection.channels += 1
    connection.lastUsedAt = Date.now()
    this.leaseIndex.set(id, connection)
    return lease
  }

  status(machineId: MachineId): Readonly<{ state: ConnectionState; identityDigest?: Sha256; message?: string }> {
    const connection = this.connections.get(machineId)
    return connection === undefined ? { state: 'disconnected' } : { state: connection.state, identityDigest: connection.identityDigest, ...(connection.message === undefined ? {} : { message: connection.message }) }
  }

  /**
   * Reconcile an app-owned ControlMaster without starting a new connection or
   * triggering authentication. This makes a surviving master visible after a
   * host restart and detects a master that exited after the last observation.
   */
  async reconcileStatus(machineIdInput: MachineId, signal?: AbortSignal): Promise<Readonly<{ state: ConnectionState; identityDigest?: Sha256; message?: string }>> {
    const machineId = machineIdSchema.parse(machineIdInput)
    const profile = await this.profiles.get(machineId)
    if (profile === undefined) return { state: 'disconnected' }
    safeAlias(profile.alias)
    const identityDigest = profileIdentityDigest(profile)
    let connection = this.connections.get(machineId)
    if (connection === undefined || connection.identityDigest !== identityDigest) {
      const socketPath = profile.ownership === 'app-managed' ? controlSocketPath(this.socketRoot, identityDigest) : undefined
      connection = { profile, identityDigest, ...(socketPath === undefined ? {} : { socketPath }), state: 'disconnected', leases: new Map(), channels: 0, connectPromise: undefined, lastUsedAt: Date.now() }
      this.connections.set(machineId, connection)
    }
    if (profile.ownership !== 'app-managed' || connection.state === 'connecting' || connection.state === 'host-key-required' || connection.state === 'host-key-changed' || connection.state === 'closing') return this.status(machineId)
    connection.reconcilePromise ??= this.reconcileOwnedMaster(connection, signal).finally(() => { if (connection !== undefined) delete connection.reconcilePromise })
    await connection.reconcilePromise
    return this.status(machineId)
  }

  /** Read-only display metadata for durable setup projections. */
  async configuredAlias(machineId: MachineId): Promise<string | undefined> {
    return (await this.profiles.get(machineId))?.alias
  }

  async inspectHostKey(machineId: MachineId): Promise<Readonly<{ endpoint: string; algorithm: string; fingerprint: string; knownHostLine: string; source: 'network-scan-untrusted' }>> {
    const profile = await this.profiles.get(machineId)
    if (profile === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine has no SSH connection profile.')
    const expanded = await this.driver.capture({ argv: ['ssh', '-G', ...(profile.port === undefined ? [] : ['-p', String(profile.port)]), ...identityFileArgv(profile), '--', profile.alias], cwd: this.cwd, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 })
    if (expanded.exitCode !== 0) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'OpenSSH could not resolve the configured alias.')
    const values = new Map(Buffer.from(expanded.stdout).toString('utf8').split(/\r?\n/).map(line => { const index = line.indexOf(' '); return index < 0 ? ['', ''] : [line.slice(0, index), line.slice(index + 1)] as const }))
    const host = values.get('hostname'); const port = values.get('port') ?? '22'; const proxyJump = values.get('proxyjump')
    if (host === undefined || !/^\d{1,5}$/.test(port)) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'OpenSSH alias expansion was incomplete.')
    if (proxyJump !== undefined && proxyJump !== 'none') throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Pinned key network scan through ProxyJump is unavailable; import an out-of-band key instead.')
    const scan = await this.driver.capture({ argv: ['ssh-keyscan', '-p', port, '-T', String(profile.connectTimeoutSeconds), '--', host], cwd: this.cwd, timeoutMs: (profile.connectTimeoutSeconds + 2) * 1_000, maxOutputBytes: 256 * 1024 })
    const knownHostLine = Buffer.from(scan.stdout).toString('utf8').split(/\r?\n/).find(line => line !== '' && !line.startsWith('#'))
    if (scan.exitCode !== 0 || knownHostLine === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'No host key was returned by the endpoint.')
    const fields = knownHostLine.split(/\s+/); const algorithm = fields[1]; const encoded = fields[2]
    if (algorithm === undefined || encoded === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The scanned host key was malformed.')
    let blob: Buffer
    try { blob = Buffer.from(encoded, 'base64') } catch { throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The scanned host key was malformed.') }
    const fingerprint = `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
    return { endpoint: `${host}:${port}`, algorithm, fingerprint, knownHostLine: `${knownHostLine}\n`, source: 'network-scan-untrusted' }
  }

  requireLease(id: ConnectionLeaseId, principalId?: PrincipalId): Readonly<{ lease: ConnectionLeaseRecord; profile: SshConnectionProfile; socketPath?: string }> {
    const connection = this.leaseIndex.get(id)
    const lease = connection?.leases.get(id)
    if (connection === undefined || lease === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease does not exist.')
    if (Date.parse(lease.expiresAt) <= Date.now()) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease expired.')
    if (principalId !== undefined && lease.ownerPrincipalId !== principalId) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease belongs to another principal.')
    if (connection.state !== 'ready') throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection is not ready.')
    return { lease, profile: connection.profile, ...(connection.socketPath === undefined ? {} : { socketPath: connection.socketPath }) }
  }

  /**
   * Keep one active operation lease alive, or make one bounded reconnect
   * attempt when the app-owned master disappeared while the worker was
   * thinking. This never starts an interactive auth flow: reconnect goes
   * through the ordinary BatchMode connection path and reports AUTH_REQUIRED
   * to the caller when human access is needed.
   */
  async ensureLease(id: ConnectionLeaseId, principalId: PrincipalId, signal?: AbortSignal): Promise<ConnectionLeaseRecord> {
    signal?.throwIfAborted()
    const connection = this.leaseIndex.get(id)
    const lease = connection?.leases.get(id)
    if (connection === undefined || lease === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease does not exist.')
    if (lease.ownerPrincipalId !== principalId) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease belongs to another principal.')

    const expired = Date.parse(lease.expiresAt) <= Date.now()
    if (expired || connection.state !== 'ready') {
      await this.reconcileStatus(lease.machineId, signal).catch(() => undefined)
    }
    signal?.throwIfAborted()
    const current = this.leaseIndex.get(id)
    const currentLease = current?.leases.get(id)
    if (current !== undefined && currentLease !== undefined && current.state === 'ready') return this.renewLease(current, currentLease)

    // The old lease is no longer usable. Release only this owner-bound lease,
    // then make one non-interactive reconnect attempt. A failed reconnect is
    // intentionally surfaced (especially AUTH_REQUIRED) for the inline auth
    // recovery card; it is never retried in a loop here.
    await this.release(id, principalId)
    signal?.throwIfAborted()
    return await this.connect(lease.machineId, principalId)
  }

  async run(leaseId: ConnectionLeaseId, remoteArgv: readonly string[], stdin: Uint8Array | undefined, timeoutMs: number, maxOutputBytes: number, signal?: AbortSignal): Promise<Awaited<ReturnType<ProcessDriver['capture']>>> {
    const { profile, socketPath } = this.requireLease(leaseId)
    if (remoteArgv.length === 0 || remoteArgv.some(value => value.length === 0 || value.includes('\0'))) throw new Error('remote argv must be nonempty and NUL-free')
    const base = sshBaseArgv(openSshTarget(profile), socketPath)
    const result = await this.driver.capture({ argv: [...base, ...remoteArgv], cwd: this.cwd, ...(stdin === undefined ? {} : { stdin }), timeoutMs, maxOutputBytes, ...(signal === undefined ? {} : { signal }) })
    // A deadline-owned termination may make OpenSSH exit 255. Preserve the
    // caller's stronger timeout classification instead of rewriting it as a
    // connection failure and provoking blind reconnect/retry loops.
    if (result.timedOut) return result
    if (result.exitCode === 255) {
      const failure = classifySshFailure(stderrText(result), 'command')
      if (failure.code === 'CONNECTION_UNAVAILABLE') {
        const live = this.leaseIndex.get(leaseId)
        if (live !== undefined) {
          live.state = 'stale'
          live.message = failure.message
        }
      }
      throw failure
    }
    return result
  }

  async beginAuth(machineId: MachineId, principalId: PrincipalId): Promise<Readonly<{ flowId: string; expiresAt: string }>> {
    if (this.authFlows === undefined) throw new SshConnectionError('AUTH_REQUIRED', 'Interactive authentication is unavailable in this host composition.')
    const profile = await this.profiles.get(machineId)
    if (profile === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine has no SSH connection profile.')
    const connection = this.connections.get(machineId)
    const identityDigest = connection?.identityDigest ?? profileIdentityDigest(profile)
    const socketPath = connection?.socketPath ?? (profile.ownership === 'app-managed' ? controlSocketPath(this.socketRoot, identityDigest) : undefined)
    if (profile.ownership === 'app-managed') await this.ensureSocketRoot()
    const argv = this.masterBootstrapArgv(profile, socketPath, false)
    return await this.authFlows.begin({ ownerPrincipalId: principalId, profile, identityDigest, bootstrapArgv: argv, cwd: this.cwd, env: {} })
  }

  async release(id: ConnectionLeaseId, principalId?: PrincipalId): Promise<void> {
    const connection = this.leaseIndex.get(id)
    const lease = connection?.leases.get(id)
    if (connection === undefined || lease === undefined) return
    if (principalId !== undefined && lease.ownerPrincipalId !== principalId) throw new Error('connection lease belongs to another principal')
    connection.leases.delete(id)
    connection.channels = Math.max(0, connection.channels - 1)
    connection.lastUsedAt = Date.now()
    this.leaseIndex.delete(id)
  }

  async closeOwned(machineId: MachineId, force = false): Promise<void> {
    const connection = this.connections.get(machineId)
    if (connection === undefined) return
    if (connection.profile.ownership !== 'app-managed') throw new Error('DSH-SLOP does not close user-owned or direct OpenSSH connections')
    if (!force && connection.leases.size > 0) throw new Error('connection has active leases')
    connection.state = 'closing'
    const argv = this.controlArgv(connection.profile, connection.socketPath!, 'exit')
    await this.driver.capture({ argv, cwd: this.cwd, timeoutMs: 10_000, maxOutputBytes: 64 * 1024 }).catch(() => undefined)
    for (const id of connection.leases.keys()) this.leaseIndex.delete(id)
    this.connections.delete(machineId)
  }

  async reapIdle(): Promise<void> {
    const now = Date.now()
    for (const [machineId, connection] of this.connections) {
      if (connection.leases.size === 0 && now - connection.lastUsedAt >= connection.profile.idleTimeoutSeconds * 1_000 && connection.profile.ownership === 'app-managed') {
        await this.closeOwned(machineId)
      }
    }
  }

  private async establish(connection: LiveConnection, timeoutSeconds?: number): Promise<void> {
    connection.state = 'connecting'
    if (connection.profile.ownership === 'app-managed') await this.ensureSocketRoot()
    try {
      if (connection.profile.trust.mode === 'pinned') await this.verifyPinnedTrust(connection.profile)
      const check = connection.profile.ownership === 'app-managed'
        ? await this.driver.capture({ argv: this.controlArgv(connection.profile, connection.socketPath!, 'check'), cwd: this.cwd, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 })
        : undefined
      if (check?.exitCode !== 0) {
        const result = await this.driver.capture({ argv: this.masterBootstrapArgv(connection.profile, connection.socketPath, true), cwd: this.cwd, timeoutMs: (timeoutSeconds ?? connection.profile.connectTimeoutSeconds + 5) * 1_000, maxOutputBytes: 256 * 1024 })
        if (result.exitCode !== 0) throw classifySshFailure(stderrText(result))
      }
      if (connection.profile.ownership === 'app-managed') {
        const verified = await this.driver.capture({ argv: this.controlArgv(connection.profile, connection.socketPath!, 'check'), cwd: this.cwd, timeoutMs: 5_000, maxOutputBytes: 64 * 1024 })
        if (verified.exitCode !== 0) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'OpenSSH master did not become ready.')
      }
      connection.state = 'ready'
      delete connection.message
    } catch (error) {
      const typed = error instanceof SshConnectionError ? error : new SshConnectionError('CONNECTION_UNAVAILABLE', 'OpenSSH connection setup failed.')
      connection.state = typed.code === 'AUTH_REQUIRED' ? 'auth-required' : typed.code === 'HOST_KEY_REQUIRED' ? 'host-key-required' : typed.code === 'HOST_KEY_CHANGED' ? 'host-key-changed' : 'failed'
      connection.message = typed.message
      throw typed
    }
  }

  private renewLease(connection: LiveConnection, lease: ConnectionLeaseRecord): ConnectionLeaseRecord {
    const renewed: ConnectionLeaseRecord = {
      ...lease,
      expiresAt: new Date(Date.now() + Math.max(1, connection.profile.idleTimeoutSeconds) * 1_000).toISOString(),
    }
    connection.leases.set(renewed.id, renewed)
    connection.lastUsedAt = Date.now()
    return renewed
  }

  private async reconcileOwnedMaster(connection: LiveConnection, signal?: AbortSignal): Promise<void> {
    const previouslyReady = connection.state === 'ready' || connection.state === 'stale'
    try {
      await this.ensureSocketRoot()
      if (connection.profile.trust.mode === 'pinned') await this.verifyPinnedTrust(connection.profile)
      const checked = await this.driver.capture({ argv: this.controlArgv(connection.profile, connection.socketPath!, 'check'), cwd: this.cwd, timeoutMs: 5_000, maxOutputBytes: 64 * 1024, ...(signal === undefined ? {} : { signal }) })
      const adoptedLegacyMaster = checked.exitCode !== 0
        && await this.adoptCompatibleLegacyMaster(connection, signal)
      const ready = checked.exitCode === 0 || adoptedLegacyMaster
      connection.state = ready ? 'ready' : previouslyReady ? 'stale' : 'disconnected'
      if (ready) delete connection.message
      else if (previouslyReady) connection.message = 'The app-owned OpenSSH master is no longer responding.'
      else delete connection.message
    } catch (error) {
      if (error instanceof SshConnectionError) {
        connection.state = error.code === 'HOST_KEY_REQUIRED' ? 'host-key-required' : error.code === 'HOST_KEY_CHANGED' ? 'host-key-changed' : previouslyReady ? 'stale' : 'failed'
        connection.message = error.message
        return
      }
      connection.state = previouslyReady ? 'stale' : 'failed'
      connection.message = 'The app-owned OpenSSH master could not be checked.'
    }
  }

  /**
   * Reuse a pre-policy-digest master only after its local process command proves
   * that the transport already satisfies the current effective policy. This is
   * a restart/upgrade bridge, not a general user-master adoption path.
   */
  private async adoptCompatibleLegacyMaster(
    connection: LiveConnection,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (connection.profile.ownership !== 'app-managed') return false
    const legacySocketPath = controlSocketPath(
      this.socketRoot,
      legacyProfileIdentityDigest(connection.profile),
    )
    if (legacySocketPath === connection.socketPath) return false
    const checked = await this.driver.capture({
      argv: this.controlArgv(connection.profile, legacySocketPath, 'check'),
      cwd: this.cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      ...(signal === undefined ? {} : { signal }),
    })
    if (checked.exitCode !== 0) return false
    const checkText = `${Buffer.from(checked.stdout).toString('utf8')}\n${Buffer.from(checked.stderr).toString('utf8')}`
    const pidText = /Master running \(pid=(\d+)\)/u.exec(checkText)?.[1]
    if (pidText === undefined) return false
    const pid = Number(pidText)
    if (!Number.isSafeInteger(pid) || pid < 1) return false
    const processResult = await this.driver.capture({
      argv: ['/bin/ps', '-p', String(pid), '-o', 'command='],
      cwd: this.cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      ...(signal === undefined ? {} : { signal }),
    })
    if (processResult.exitCode !== 0) return false
    const command = Buffer.from(processResult.stdout).toString('utf8')
    const required = [
      `ControlPath=${legacySocketPath}`,
      `ControlPersist=${String(connection.profile.idleTimeoutSeconds)}`,
      `ServerAliveInterval=${String(connection.profile.keepaliveSeconds)}`,
      `ServerAliveCountMax=${String(connection.profile.keepaliveMisses ?? 3)}`,
    ]
    if (!required.every(value => command.includes(value))
      || !command.includes(` -- ${connection.profile.alias}`)) return false
    connection.socketPath = legacySocketPath
    return true
  }

  /**
   * Create or verify the socket root before each OpenSSH use. Only an in-flight
   * check is shared: the OS may purge /tmp while the Host keeps running (macOS
   * periodic cleanup, a WSL restart), and a cached success would let
   * `ssh -M` authenticate and then fail to bind its ControlPath.
   */
  private async ensureSocketRoot(): Promise<void> {
    this.socketRootReady ??= (async () => {
      if (process.platform === 'win32') {
        await verifyWslSocketRoot(this.driver, this.socketRoot, this.cwd)
        return
      }
      try {
        await mkdir(this.socketRoot, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const metadata = await lstat(this.socketRoot)
      const uid = process.getuid?.()
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('OpenSSH socket root must be a real directory')
      if (uid !== undefined && metadata.uid !== uid) throw new Error('OpenSSH socket root is owned by another user')
      if ((metadata.mode & 0o077) !== 0) throw new Error('OpenSSH socket root is not private')
    })().finally(() => {
      this.socketRootReady = undefined
    })
    await this.socketRootReady
  }

  private masterBootstrapArgv(profile: SshConnectionProfile, socketPath: string | undefined, batch: boolean): readonly string[] {
    const base = sshBaseArgv(openSshTarget(profile), socketPath)
    const batchIndex = base.findIndex(value => value === 'BatchMode=yes')
    if (!batch && batchIndex > 0) base[batchIndex] = 'BatchMode=no'
    if (profile.ownership === 'app-managed') base.splice(base.length - 2, 0, '-M', '-N', '-f')
    else base.splice(base.length - 2, 0, '-T')
    if (profile.ownership !== 'app-managed') base.push('true')
    return base
  }

  private controlArgv(profile: SshConnectionProfile, socketPath: string, command: 'check' | 'exit'): readonly string[] {
    return [
      'ssh',
      '-S', socketPath,
      '-O', command,
      ...(profile.port === undefined ? [] : ['-p', String(profile.port)]),
      ...identityFileArgv(profile),
      '--', profile.alias,
    ]
  }

  private async verifyPinnedTrust(profile: SshConnectionProfile): Promise<void> {
    await verifyPinnedTrust(profile)
  }
}

export async function verifyPinnedTrust(profile: SshConnectionProfile): Promise<void> {
    if (profile.trust.expectedFingerprints.length === 0 || profile.trust.appKnownHostsPath === undefined) throw new SshConnectionError('HOST_KEY_REQUIRED', 'Pinned trust requires fingerprints and an app-owned known_hosts file.')
    let content: string
    try { content = await readFile(profile.trust.appKnownHostsPath, 'utf8') } catch { throw new SshConnectionError('HOST_KEY_REQUIRED', 'The pinned host key has not been installed.') }
    const digest = `SHA256:${createHash('sha256').update(content).digest('base64').replace(/=+$/, '')}`
    // A full ssh-keygen fingerprint check is performed at trust enrollment; this
    // digest guard prevents the app-owned record being silently replaced later.
    const sidecar = `${profile.trust.appKnownHostsPath}.record.sha256`
    let recorded: { digest?: unknown; fingerprint?: unknown }
    try { recorded = JSON.parse(await readFile(sidecar, 'utf8')) as typeof recorded } catch { throw new SshConnectionError('HOST_KEY_REQUIRED', 'The pinned trust integrity record is missing.') }
    if (recorded.digest !== digest || typeof recorded.fingerprint !== 'string' || !profile.trust.expectedFingerprints.includes(recorded.fingerprint)) throw new SshConnectionError('HOST_KEY_CHANGED', 'The app-owned pinned host-key record or approved fingerprint changed.')
}

/** Enrollment helper used only after exact fingerprint approval. */
export async function persistPinnedKnownHost(path: string, knownHostLine: string, observedFingerprint: string, expectedFingerprints: readonly string[]): Promise<void> {
  if (!expectedFingerprints.includes(observedFingerprint)) throw new SshConnectionError('HOST_KEY_CHANGED', 'Observed host-key fingerprint does not match the approved pin.')
  if (knownHostLine.includes('\0') || !knownHostLine.endsWith('\n') || knownHostLine.slice(0, -1).includes('\n') || knownHostLine.includes('\r')) throw new Error('known_hosts entry must be exactly one terminated text line')
  const fields = knownHostLine.trimEnd().split(/\s+/)
  if (fields.length !== 3 || fields[0]!.startsWith('#') || !/^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._+-]+$/.test(fields[1]!)) throw new Error('known_hosts entry is malformed')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(fields[2]!) || fields[2]!.length % 4 === 1) throw new Error('known_hosts key blob is malformed')
  const keyBlob = Buffer.from(fields[2]!, 'base64')
  if (keyBlob.length === 0 || keyBlob.toString('base64').replace(/=+$/, '') !== fields[2]!.replace(/=+$/, '')) throw new Error('known_hosts key blob is malformed')
  const actualFingerprint = `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`
  if (actualFingerprint !== observedFingerprint) throw new SshConnectionError('HOST_KEY_CHANGED', 'The approved fingerprint does not match the supplied host-key line.')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const digest = `SHA256:${createHash('sha256').update(knownHostLine).digest('base64').replace(/=+$/, '')}`
  const recordPath = `${path}.record.sha256`
  const suffix = `${process.pid}.${randomUUID()}.tmp`
  const keyTemporary = `${path}.${suffix}`
  const recordTemporary = `${recordPath}.${suffix}`
  try {
    await writeFile(keyTemporary, knownHostLine, { mode: 0o600, flag: 'wx' })
    await writeFile(recordTemporary, `${JSON.stringify({ digest, fingerprint: observedFingerprint })}\n`, { mode: 0o600, flag: 'wx' })
    // Either interruption point fails closed in verifyPinnedTrust: the content
    // digest and approved fingerprint must agree before OpenSSH is invoked.
    await rename(keyTemporary, path)
    await rename(recordTemporary, recordPath)
  } finally {
    await unlink(keyTemporary).catch(() => undefined)
    await unlink(recordTemporary).catch(() => undefined)
  }
}

const WSL_READY_MARKER = 'dsh-slop-wsl-ready'

/** Shown when WSL itself cannot run a command, so no Linux directory was ever checked. */
export const WSL_UNAVAILABLE_MESSAGE = 'WSL could not run a Linux command. Windows WSL mode needs an installed WSL distribution with ssh, scp and ssh-keyscan; select it with DSH_SLOP_WSL_DISTRO, or remove DSH_SLOP_SSH_BACKEND=wsl to use the native Windows SSH client.'

/**
 * Create or verify the private Linux control-socket directory through the same
 * WSL adapter as SSH. Refuse an existing foreign, linked or permissive directory
 * and never repair it. The script prints a marker first, so a WSL launch failure
 * is not reported as a directory problem.
 */
export async function verifyWslSocketRoot(driver: Pick<ProcessDriver, 'capture'>, socketRoot: string, cwd: string): Promise<void> {
  const script = [
    `printf '%s\\n' ${WSL_READY_MARKER}`,
    'umask 077',
    'mkdir -- "$1" 2>/dev/null || test -d "$1" || { echo missing >&2; exit 3; }',
    'test ! -L "$1" || { echo symlink >&2; exit 3; }',
    'test "$(stat -c %u -- "$1")" = "$(id -u)" || { echo owner >&2; exit 3; }',
    'test "$(stat -c %a -- "$1")" = 700 || { echo mode >&2; exit 3; }',
  ].join('; ')
  const result = await driver.capture({ argv: ['sh', '-c', script, 'dsh-slop-socket-root', socketRoot], cwd, timeoutMs: 20_000, maxOutputBytes: 4_096 })
  const ran = Buffer.from(result.stdout).toString('utf8').split(/\r?\n/u).includes(WSL_READY_MARKER)
  if (!ran) throw new Error(WSL_UNAVAILABLE_MESSAGE)
  if (result.exitCode === 0 && !result.timedOut) return
  const reason = Buffer.from(result.stderr).toString('utf8').trim().split(/\s+/u).at(-1)
  const detail = reason === 'owner' ? ' It is owned by another Linux user.' : reason === 'mode' ? ' Its permissions are not 700.' : reason === 'symlink' ? ' It is a symbolic link.' : reason === 'missing' ? ' It could not be created.' : ''
  throw new Error(`WSL OpenSSH socket root ${socketRoot} must be a private directory owned by the current Linux user.${detail} DSH-SLOP does not change it; fix or remove it in WSL.`)
}
