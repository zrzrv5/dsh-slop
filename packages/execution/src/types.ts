import type {
  ConnectionLeaseId,
  MachineId,
  PrincipalId,
  Sha256,
} from '@dsh-slop/core'

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'auth-required'
  | 'host-key-required'
  | 'host-key-changed'
  | 'ready'
  | 'stale'
  | 'failed'
  | 'closing'

export interface SshConnectionProfile {
  readonly machineId: MachineId
  readonly revision: number
  readonly alias: string
  readonly port?: number
  /** Non-secret local identity-file path passed to OpenSSH as one argv value. */
  readonly localKeyFilePath?: string
  readonly trust: Readonly<{
    mode: 'pinned' | 'user-known-hosts' | 'tofu'
    expectedFingerprints: readonly string[]
    appKnownHostsPath?: string
  }>
  readonly ownership: 'app-managed' | 'adopt-user-master' | 'direct'
  readonly connectTimeoutSeconds: number
  readonly keepaliveSeconds: number
  readonly keepaliveMisses?: number
  readonly idleTimeoutSeconds: number
  readonly concurrencyLimit: number
}

export interface ConnectionLeaseRecord {
  readonly id: ConnectionLeaseId
  readonly ownerPrincipalId: PrincipalId
  readonly machineId: MachineId
  readonly identityDigest: Sha256
  readonly acquiredAt: string
  readonly expiresAt: string
}

export interface CapturedProcess {
  readonly argv: readonly string[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly timedOut: boolean
}

export interface ProcessDriver {
  capture(request: Readonly<{
    argv: readonly string[]
    cwd: string
    env?: Readonly<Record<string, string>>
    stdin?: Uint8Array
    timeoutMs: number
    maxOutputBytes: number
    signal?: AbortSignal
  }>): Promise<CapturedProcess>
}

export interface ConnectionProfileSource {
  get(machineId: MachineId): Promise<SshConnectionProfile | undefined>
}

export interface AuthFlowRequest {
  readonly ownerPrincipalId: PrincipalId
  readonly profile: SshConnectionProfile
  readonly identityDigest: Sha256
  readonly bootstrapArgv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/** Protected PTY carrier; its bytes never enter ordinary Chat history. */
export interface AuthFlowSeam {
  begin(request: AuthFlowRequest): Promise<Readonly<{ flowId: string; expiresAt: string }>>
  status(flowId: string, principalId: PrincipalId): Promise<Readonly<{
    state: 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired'
  }>>
  cancel(flowId: string, principalId: PrincipalId): Promise<void>
}
