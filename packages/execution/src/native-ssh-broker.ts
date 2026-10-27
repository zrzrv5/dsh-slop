import ssh2, { type Client as SshClient, type SFTPWrapper } from 'ssh2'
import { canonicalSha256, connectionLeaseIdSchema, createUuidV7, machineIdSchema, type ConnectionLeaseId, type MachineId, type PrincipalId, type Sha256 } from '@dsh-slop/core'
import { profileIdentityDigest, SshConnectionError, verifyPinnedTrust, type OpenSshBroker } from './ssh-broker.ts'
import type { AuthFlowSeam, ConnectionLeaseRecord, ConnectionProfileSource, ConnectionState, SshConnectionProfile } from './types.ts'
import type { NativeAuthPrompt } from './native-auth-flow.ts'
import type { NativeConfigResolver } from './native-ssh-config.ts'
import { knownHostName, sshFingerprint } from './native-ssh-trust.ts'
import { captureNativeCommand, openNativeConnection } from './native-ssh-client.ts'

const { Client } = ssh2

interface Connection {
  readonly profile: SshConnectionProfile
  readonly identityDigest: Sha256
  readonly lifetime: AbortController
  readonly leases: Map<ConnectionLeaseId, ConnectionLeaseRecord>
  state: ConnectionState
  client?: SshClient
  pending?: Promise<void>
  message?: string
  lastUsed: number
}

export type SshBroker = Pick<OpenSshBroker, keyof OpenSshBroker>

/** Windows transport: one SSH connection, independent exec/SFTP channels, no WSL. */
export class NativeSshBroker implements SshBroker {
  private readonly connections = new Map<MachineId, Connection>()
  private readonly leases = new Map<ConnectionLeaseId, Connection>()
  private readonly lifetime = new AbortController()
  private readonly reaper: ReturnType<typeof setInterval>

  constructor(private readonly profiles: ConnectionProfileSource, private readonly resolveConfig: NativeConfigResolver, private readonly authFlows: AuthFlowSeam, private readonly cwd: string) {
    this.reaper = setInterval(() => { void this.reapIdle() }, 60_000)
    this.reaper.unref()
  }

  async connect(machineId: MachineId, principalId: PrincipalId): Promise<ConnectionLeaseRecord> {
    const connection = await this.current(machineId)
    await this.verifyTrust(connection)
    if (connection.state !== 'ready') await this.establish(connection)
    this.assertCurrent(connection)
    for (const lease of connection.leases.values()) if (Date.parse(lease.expiresAt) <= Date.now()) await this.release(lease.id)
    if (connection.leases.size >= connection.profile.concurrencyLimit) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine connection channel limit is reached.')
    const lease: ConnectionLeaseRecord = { id: connectionLeaseIdSchema.parse(createUuidV7()), ownerPrincipalId: principalId, machineId, identityDigest: connection.identityDigest, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + connection.profile.idleTimeoutSeconds * 1000).toISOString() }
    connection.leases.set(lease.id, lease)
    connection.lastUsed = Date.now()
    this.leases.set(lease.id, connection)
    return lease
  }

  status(machineId: MachineId): ReturnType<OpenSshBroker['status']> {
    const connection = this.connections.get(machineId)
    return connection === undefined ? { state: 'disconnected' } : { state: connection.state, identityDigest: connection.identityDigest, ...(connection.message === undefined ? {} : { message: connection.message }) }
  }

  async reconcileStatus(machineId: MachineId, signal?: AbortSignal): Promise<ReturnType<OpenSshBroker['status']>> {
    signal?.throwIfAborted()
    const profile = await this.profiles.get(machineId)
    const connection = this.connections.get(machineId)
    if (connection !== undefined && (profile === undefined || this.identity(profile) !== connection.identityDigest)) this.dispose(connection)
    else if (connection !== undefined) await this.verifyTrust(connection).catch(() => undefined)
    // Read-only: no config commands, network connection, authentication or key scan.
    return this.status(machineId)
  }

  async configuredAlias(machineId: MachineId): Promise<string | undefined> { return (await this.profiles.get(machineId))?.alias }

  requireLease(id: ConnectionLeaseId, principalId?: PrincipalId): ReturnType<OpenSshBroker['requireLease']> {
    const connection = this.leases.get(id), lease = connection?.leases.get(id)
    if (connection === undefined || lease === undefined || Date.parse(lease.expiresAt) <= Date.now()) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease is missing or expired.')
    if (principalId !== undefined && principalId !== lease.ownerPrincipalId) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease belongs to another principal.')
    this.assertCurrent(connection)
    if (connection.state === 'host-key-required' || connection.state === 'host-key-changed') throw new SshConnectionError(connection.state === 'host-key-required' ? 'HOST_KEY_REQUIRED' : 'HOST_KEY_CHANGED', connection.message ?? 'Host key verification failed.')
    if (connection.state !== 'ready' || connection.client === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection is not ready.')
    return { lease, profile: connection.profile }
  }

  async ensureLease(id: ConnectionLeaseId, principalId: PrincipalId, signal?: AbortSignal): Promise<ConnectionLeaseRecord> {
    signal?.throwIfAborted()
    const connection = this.leases.get(id), lease = connection?.leases.get(id)
    if (lease === undefined || connection === undefined || lease.ownerPrincipalId !== principalId) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease is unavailable for this principal.')
    await this.reconcileStatus(lease.machineId, signal)
    if (connection.state === 'ready' && this.leases.get(id) === connection) {
      const renewed = { ...lease, expiresAt: new Date(Date.now() + connection.profile.idleTimeoutSeconds * 1000).toISOString() }
      connection.leases.set(id, renewed)
      connection.lastUsed = Date.now()
      return renewed
    }
    await this.release(id, principalId)
    return await this.connect(lease.machineId, principalId)
  }

  async run(...args: Parameters<OpenSshBroker['run']>): ReturnType<OpenSshBroker['run']> {
    const [leaseId, argv, stdin, timeoutMs, maximum, signal] = args
    const client = await this.clientForLease(leaseId)
    const connection = this.leases.get(leaseId)!
    const combined = AbortSignal.any([connection.lifetime.signal, ...signal === undefined ? [] : [signal]])
    try { return await captureNativeCommand(client, argv, stdin, timeoutMs, maximum, combined) }
    finally { connection.lastUsed = Date.now() }
  }

  async openSftp(id: ConnectionLeaseId, principalId: PrincipalId, signal?: AbortSignal): Promise<SFTPWrapper> {
    const client = await this.clientForLease(id, principalId)
    signal?.throwIfAborted()
    return await new Promise((resolve, reject) => {
      // ssh2 has no public cancellation handle until subsystem setup completes.
      // Close the transport if that setup stalls, instead of leaking channels.
      const abort = (): void => { client.destroy(); reject(new Error('SFTP channel cancelled')) }
      signal?.addEventListener('abort', abort, { once: true })
      client.sftp((error, sftp) => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) { sftp?.end(); abort() }
        else if (error) reject(new SshConnectionError('CONNECTION_UNAVAILABLE', 'The server could not open SFTP.'))
        else resolve(sftp)
      })
    })
  }

  async beginAuth(machineId: MachineId, principalId: PrincipalId): Promise<{ flowId: string; expiresAt: string }> {
    const connection = await this.current(machineId)
    return await this.authFlows.begin({ ownerPrincipalId: principalId, profile: connection.profile, identityDigest: connection.identityDigest, bootstrapArgv: [], cwd: this.cwd, env: {} })
  }

  async authenticate(machineId: MachineId, identityDigest: string, prompt: NativeAuthPrompt): Promise<void> {
    const connection = await this.current(machineId)
    if (identityDigest !== connection.identityDigest) throw new Error('Machine access changed before authentication')
    await this.establish(connection, prompt)
  }

  async inspectHostKey(machineId: MachineId): ReturnType<OpenSshBroker['inspectHostKey']> {
    const connection = await this.current(machineId)
    const config = await this.resolveConfig(connection.profile)
    this.assertCurrent(connection)
    const client = new Client()
    return await new Promise((resolve, reject) => {
      let observed = false
      const abort = (): void => { client.destroy(); reject(new Error('Host key inspection cancelled')) }
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      client.on('error', () => { if (!observed) reject(new SshConnectionError('CONNECTION_UNAVAILABLE', 'The endpoint did not return a host key.')) })
      client.once('close', () => { this.lifetime.signal.removeEventListener('abort', abort); if (!observed) reject(new SshConnectionError('CONNECTION_UNAVAILABLE', 'The endpoint closed during host key inspection.')) })
      client.connect({ host: config.host, port: config.port, username: config.username, readyTimeout: connection.profile.connectTimeoutSeconds * 1000,
        ...(config.algorithms === undefined ? {} : { algorithms: config.algorithms }),
        forceIPv4: config.addressFamily === 'inet', forceIPv6: config.addressFamily === 'inet6', ...(config.bindAddress === undefined ? {} : { localAddress: config.bindAddress }),
        hostVerifier: (key: Buffer) => {
          if (key.length < 4 || key.readUInt32BE(0) > key.length - 4) return false
          const algorithm = key.subarray(4, 4 + key.readUInt32BE(0)).toString('ascii')
          if (!/^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._+-]+$/u.test(algorithm)) return false
          observed = true
          resolve({ endpoint: `${config.host}:${config.port}`, algorithm, fingerprint: sshFingerprint(key), knownHostLine: `${knownHostName(config)} ${algorithm} ${key.toString('base64')}\n`, source: 'network-scan-untrusted' })
          return false // Inspection never authenticates, even with an agent available.
        },
      })
    })
  }

  async release(id: ConnectionLeaseId, principalId?: PrincipalId): Promise<void> {
    const connection = this.leases.get(id), lease = connection?.leases.get(id)
    if (connection === undefined || lease === undefined) return
    if (principalId !== undefined && lease.ownerPrincipalId !== principalId) throw new Error('Connection lease belongs to another principal')
    connection.leases.delete(id)
    this.leases.delete(id)
    connection.lastUsed = Date.now()
    if (connection.profile.ownership === 'direct' && !connection.leases.size) this.dispose(connection)
  }

  async closeOwned(machineId: MachineId, force = false): Promise<void> {
    const connection = this.connections.get(machineId)
    if (connection === undefined) return
    if (connection.profile.ownership !== 'app-managed') throw new Error('Cannot close a user-owned connection')
    if (!force && connection.leases.size) throw new Error('Connection has active leases')
    this.dispose(connection)
    await connection.pending?.catch(() => undefined)
  }

  async reapIdle(): Promise<void> {
    for (const connection of this.connections.values()) if (!connection.leases.size && connection.pending === undefined && Date.now() - connection.lastUsed >= connection.profile.idleTimeoutSeconds * 1000) this.dispose(connection)
  }

  async close(): Promise<void> {
    this.lifetime.abort()
    clearInterval(this.reaper)
    const connections = [...this.connections.values()]
    for (const connection of connections) this.dispose(connection)
    await Promise.allSettled(connections.flatMap(connection => connection.pending === undefined ? [] : [connection.pending]))
  }

  private identity(profile: SshConnectionProfile): Sha256 { return canonicalSha256({ transport: 'native-ssh2-v1', profile: profileIdentityDigest(profile) }) }

  private async current(machineIdInput: MachineId): Promise<Connection> {
    this.lifetime.signal.throwIfAborted()
    const machineId = machineIdSchema.parse(machineIdInput)
    const profile = await this.profiles.get(machineId)
    this.lifetime.signal.throwIfAborted()
    if (profile === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine has no SSH connection profile.')
    if (profile.ownership === 'adopt-user-master') throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'Native Windows SSH cannot adopt a user OpenSSH master. Select app-managed access or the WSL backend.')
    const identityDigest = this.identity(profile)
    let connection = this.connections.get(machineId)
    if (connection !== undefined && connection.identityDigest !== identityDigest) { this.dispose(connection); connection = undefined }
    if (connection === undefined) {
      connection = { profile, identityDigest, lifetime: new AbortController(), leases: new Map(), state: 'disconnected', lastUsed: Date.now() }
      this.connections.set(machineId, connection)
    }
    return connection
  }

  private assertCurrent(connection: Connection): void {
    if (this.lifetime.signal.aborted || connection.lifetime.signal.aborted || this.connections.get(connection.profile.machineId) !== connection) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The Machine connection was closed or replaced.')
  }

  private async clientForLease(id: ConnectionLeaseId, owner?: PrincipalId): Promise<SshClient> {
    const lease = this.leases.get(id)?.leases.get(id)
    if (lease === undefined) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease does not exist.')
    if (owner !== undefined && lease.ownerPrincipalId !== owner) throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The connection lease belongs to another principal.')
    await this.reconcileStatus(lease.machineId)
    this.requireLease(id, owner)
    const connection = this.leases.get(id)!
    await this.verifyTrust(connection)
    return connection.client!
  }

  private async establish(connection: Connection, prompt?: NativeAuthPrompt): Promise<void> {
    if (connection.state === 'ready') return
    connection.pending ??= (async () => {
      connection.state = 'connecting'
      try {
        const config = await this.resolveConfig(connection.profile)
        const signal = AbortSignal.any([this.lifetime.signal, connection.lifetime.signal, ...prompt === undefined ? [] : [prompt.signal]])
        const client = await openNativeConnection(config, connection.profile, signal, prompt)
        const latest = await this.profiles.get(connection.profile.machineId)
        if (latest === undefined || this.identity(latest) !== connection.identityDigest || signal.aborted) { client.destroy(); throw new Error('Machine access changed during authentication') }
        this.assertCurrent(connection)
        connection.client = client
        connection.state = 'ready'
        connection.lastUsed = Date.now()
        delete connection.message
        client.once('close', () => { if (connection.client === client) { delete connection.client; connection.state = 'stale'; connection.message = 'The native SSH connection closed. Reconnect to continue.' } })
      } catch (error) {
        const typed = error instanceof SshConnectionError ? error : new SshConnectionError('CONNECTION_UNAVAILABLE', 'Native SSH connection setup failed.')
        connection.state = typed.code === 'AUTH_REQUIRED' ? 'auth-required' : typed.code === 'HOST_KEY_REQUIRED' ? 'host-key-required' : typed.code === 'HOST_KEY_CHANGED' ? 'host-key-changed' : 'failed'
        connection.message = typed.message
        throw typed
      }
    })().finally(() => { delete connection.pending })
    await connection.pending
  }

  private dispose(connection: Connection): void {
    connection.lifetime.abort()
    connection.client?.destroy()
    delete connection.client
    connection.state = 'disconnected'
    for (const id of connection.leases.keys()) this.leases.delete(id)
    connection.leases.clear()
    if (this.connections.get(connection.profile.machineId) === connection) this.connections.delete(connection.profile.machineId)
  }

  private async verifyTrust(connection: Connection): Promise<void> {
    if (connection.profile.trust.mode !== 'pinned') return
    try { await verifyPinnedTrust(connection.profile) }
    catch (error) {
      connection.client?.destroy()
      delete connection.client
      connection.state = error instanceof SshConnectionError && error.code === 'HOST_KEY_CHANGED' ? 'host-key-changed' : 'host-key-required'
      connection.message = error instanceof Error ? error.message : 'Host key verification failed.'
      throw error
    }
  }
}
