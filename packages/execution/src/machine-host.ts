import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import {
  EXECUTION_AUTHORITY_DOMAINS,
  LOCAL_OWNER_PRINCIPAL_ID,
  accessProfileSchema,
  effectiveSshIdlePolicy,
  machineIdSchema,
  principalIdSchema,
  redesignMachineSchema,
  type MachineId,
  type PrincipalContext,
  type RelationalAuthority,
  type SlopAuthWebSocketSession,
} from '@dsh-slop/core'
import { controlSocketRoot, DshAuthFlow } from '@dsh-slop/operations'
import { DshAuthFlowAdapter } from './auth-adapter.ts'
import { AuthorityConnectionTrustOverrides } from './connection-trust-overrides.ts'
import { MachineService } from './machine-service.ts'
import { MachineTransferService } from './machine-transfer-service.ts'
import { DshProcessDriver } from './process-driver.ts'
import { OpenSshBroker } from './ssh-broker.ts'
import { SshPlatform } from './ssh-platform.ts'
import { sshBackend } from './ssh-backend.ts'
import { NativeSshBroker, type SshBroker } from './native-ssh-broker.ts'
import { NativeAuthFlow } from './native-auth-flow.ts'
import { nativeConfigResolver } from './native-ssh-config.ts'
import { nativeSftpTransfer } from './native-sftp-transfer.ts'
import { MachineConnectionRuntime } from './connection-runtime.ts'
import type { ConnectionProfileSource, SshConnectionProfile } from './types.ts'

export class AuthorityMachineProfileSource implements ConnectionProfileSource {
  constructor(
    private readonly authority: RelationalAuthority,
    private readonly trustRoot: string,
    private readonly trustOverrides?: AuthorityConnectionTrustOverrides,
  ) {}

  async get(machineId: MachineId): Promise<SshConnectionProfile | undefined> {
    const machineRecord = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, EXECUTION_AUTHORITY_DOMAINS.machine, machineId)
    if (machineRecord === undefined) return undefined
    const machine = redesignMachineSchema.parse(machineRecord.value)
    if (machineRecord.revision !== machine.revision || machine.lifecycle !== 'active') return undefined
    const accessRecord = this.authority.get(
      LOCAL_OWNER_PRINCIPAL_ID,
      EXECUTION_AUTHORITY_DOMAINS.accessProfile,
      machine.accessProfileId,
    )
    if (accessRecord === undefined) return undefined
    const access = accessProfileSchema.parse(accessRecord.value)
    if (accessRecord.revision !== access.revision || access.kind === 'local') return undefined
    const alias = access.target.kind === 'config-alias'
      ? access.target.alias
      : `${access.target.user === undefined ? '' : `${access.target.user}@`}${access.target.host}`
    const idlePolicy = effectiveSshIdlePolicy(access)
    const configuredTrust: SshConnectionProfile['trust'] = (() => {
      switch (access.trustPolicy.kind) {
        case 'user-known-hosts':
          return { mode: 'user-known-hosts', expectedFingerprints: [] }
        case 'trust-on-first-use':
          return { mode: 'tofu', expectedFingerprints: [] }
        case 'pinned':
          return {
            mode: 'pinned',
            expectedFingerprints: access.trustPolicy.expectedFingerprints,
            appKnownHostsPath: join(this.trustRoot, `${machineId}.known_hosts`),
          }
        default: {
          const exhaustive: never = access.trustPolicy
          return exhaustive
        }
      }
    })()
    const base: SshConnectionProfile = {
      machineId,
      revision: access.revision,
      alias,
      ...(access.target.kind === 'endpoint' ? { port: access.target.port } : {}),
      ...(access.authentication.kind === 'ssh-agent' && access.authentication.localKeyFilePath !== undefined
        ? { localKeyFilePath: access.authentication.localKeyFilePath }
        : {}),
      trust: configuredTrust,
      ownership: access.controlOwnership,
      connectTimeoutSeconds: access.timeouts.connectSeconds,
      keepaliveSeconds: access.timeouts.keepaliveSeconds,
      keepaliveMisses: access.timeouts.keepaliveMisses,
      idleTimeoutSeconds: idlePolicy.effectiveIdleSeconds,
      concurrencyLimit: 8,
    }
    const activeTrust = await this.trustOverrides?.get(machineId, base)
    return activeTrust === undefined ? base : { ...base, trust: activeTrust }
  }
}

export interface CreateMachineHostOptions {
  readonly dataRoot: string
  readonly cwd: string
  readonly authority: RelationalAuthority
  readonly subprocess: SubprocessRuntime
}

export interface MachineHost {
  readonly broker: SshBroker
  readonly machineService: MachineService
  readonly machineTransferService: MachineTransferService
  readonly connectionRuntime: MachineConnectionRuntime
  openAuthFlow(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopAuthWebSocketSession>
  close(): Promise<void>
}

/** Construct only reusable SSH, protected authentication, and generic remote shell. */
export async function createMachineHost(options: CreateMachineHostOptions): Promise<MachineHost> {
  if (![options.dataRoot, options.cwd].every(path => isAbsolute(path) && !path.includes('\0'))) {
    throw new Error('Machine host paths must be absolute')
  }
  await mkdir(options.dataRoot, { recursive: true, mode: 0o700 })
  const trustRoot = join(options.dataRoot, 'trust')
  await mkdir(trustRoot, { recursive: true, mode: 0o700 })
  const localDriver = new DshProcessDriver(options.subprocess)
  const sshPlatform = new SshPlatform(localDriver, options.cwd)
  const processDriver = new DshProcessDriver(options.subprocess, sshPlatform.prepareCommand)
  const trustOverrides = new AuthorityConnectionTrustOverrides(options.authority, trustRoot)
  const profiles = new AuthorityMachineProfileSource(options.authority, trustRoot, trustOverrides)
  let authAdapter: DshAuthFlowAdapter | undefined
  const requireAuthAdapter = (): DshAuthFlowAdapter => {
    if (authAdapter === undefined) throw new Error('Protected authentication adapter is not initialized')
    return authAdapter
  }
  const authSeam = {
    begin: async (request: Parameters<DshAuthFlowAdapter['begin']>[0]) => await requireAuthAdapter().begin(request),
    status: async (flowId: string, principalId: Parameters<DshAuthFlowAdapter['status']>[1]) => await requireAuthAdapter().status(flowId, principalId),
    cancel: async (flowId: string, principalId: Parameters<DshAuthFlowAdapter['cancel']>[1]) => await requireAuthAdapter().cancel(flowId, principalId),
  }
  const native = sshBackend() === 'native'
    ? new NativeSshBroker(profiles, nativeConfigResolver(localDriver, options.cwd), authSeam, options.cwd)
    : undefined
  const broker: SshBroker = native ?? new OpenSshBroker(
    profiles,
    processDriver,
    controlSocketRoot(options.dataRoot),
    options.cwd,
    authSeam,
  )
  const dshAuth = native !== undefined
    ? new NativeAuthFlow(async (request, prompt) => await native.authenticate(machineIdSchema.parse(request.machineId), request.connectionIdentityDigest, prompt))
    : new DshAuthFlow(options.subprocess, async request => {
    try {
      const machineId = machineIdSchema.parse(request.machineId)
      const principalId = principalIdSchema.parse(request.ownerPrincipalId)
      const lease = await broker.connect(machineId, principalId)
      await broker.release(lease.id, principalId)
      return true
    } catch {
      return false
    }
  }, sshPlatform.prepareCommand)
  authAdapter = new DshAuthFlowAdapter(dshAuth)
  const connectionRuntime = new MachineConnectionRuntime({
    authority: options.authority,
    broker,
    authFlows: authAdapter,
    trustOverrides,
  })
  connectionRuntime.pendingConnectionCalls.settleRestartRecoveredWaiters()
  const machineService = new MachineService({ authority: options.authority, broker })
  const machineTransferService = new MachineTransferService({
    broker,
    subprocess: options.subprocess,
    cwd: options.cwd,
    prepareCommand: sshPlatform.prepareCommand,
    ...(native === undefined ? {} : { nativeTransfer: nativeSftpTransfer(native) }),
  })
  let closed = false
  return {
    broker,
    machineService,
    machineTransferService,
    connectionRuntime,
    openAuthFlow: async (principal, signal) => await requireAuthAdapter().openSocket(principal, signal),
    async close() {
      if (closed) return
      closed = true
      connectionRuntime.close()
      await Promise.all([machineTransferService.close(), dshAuth.close(), processDriver.stopActive()])
      await broker.close()
      await processDriver.close()
      await localDriver.close()
    },
  }
}
