/** Browser contracts for the Machine-only settings and Chat projections. */

export type Revision = number
export type Cursor = string
export type Instant = string
export type Sha256 = string

export type MachineId = string & { readonly __brand: 'MachineId' }

const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function parseMachineId(value: unknown): MachineId | undefined {
  return typeof value === 'string' && MACHINE_ID_PATTERN.test(value) ? value as MachineId : undefined
}

export type MachineKind = 'local' | 'ssh'
export type MachineState = 'ready' | 'disabled' | 'archived' | 'degraded' | 'auth-required' | 'unknown'
export type ConnectionState = 'disconnected' | 'connecting' | 'ready' | 'auth-required' | 'stale' | 'error'
export type TrustMode = 'pinned' | 'user-known-hosts' | 'tofu-labelled'
export type ExecutionTarget = { kind: 'local' | 'remote'; path: string }

export type MachineAccessProfileDraft =
  | { kind: 'local' }
  | {
      kind: 'ssh'
      target: { kind: 'config-alias'; alias: string } | { kind: 'endpoint'; host: string; user?: string; port: number }
      controlOwnership: 'app-managed' | 'adopt-user-master' | 'direct'
      trustPolicy: { kind: 'user-known-hosts' } | { kind: 'trust-on-first-use' } | { kind: 'pinned'; expectedFingerprints: readonly string[] }
      vpn: { kind: 'none' } | { kind: 'required'; label: string; instructions?: string }
      authentication:
        | { kind: 'ssh-agent'; localKeyFilePath?: string }
        | { kind: 'interactive' }
        | { kind: 'provider-managed'; provider: string }
        | { kind: 'unknown' }
      timeouts: { connectSeconds: number; keepaliveSeconds: number; keepaliveMisses: number; idleSeconds: number }
    }

export interface MachineDeclaredRoot {
  id: string
  role: 'home' | 'work' | 'scratch' | 'project' | 'other'
  label: string
  path: ExecutionTarget
}

/** Exact inventory baseline retained for Agent-authored corrections and archive checks. */
export interface MachineBaseConfiguration {
  name: string
  access: MachineAccessProfileDraft
  declaredRoots: readonly MachineDeclaredRoot[]
  preferredExecutionProviderId?: string
}

export interface MachineProjection {
  id: MachineId
  name: string
  kind: MachineKind
  state: MachineState
  connectionState: ConnectionState
  target?: string
  sshAlias?: string
  networkAccess?: 'direct' | 'vpn-required'
  authentication?: 'ssh-agent' | 'interactive-2fa' | 'unknown'
  username?: string
  host?: string
  port?: number
  trustMode?: TrustMode
  hostFingerprint?: string
  trustSource?: string
  scheduler?: string
  schedulerPreference?: string
  defaultAccount?: string
  defaultQueue?: string
  storageRoot?: string
  homePath?: string
  workPath?: string
  scratchPath?: string
  lastSeenAt?: Instant
  revision: Revision
  accessProfileRevision: Revision
  baseConfiguration: MachineBaseConfiguration
  archivedAt?: Instant
}

export type ConnectionChallenge =
  | { kind: 'host-trust'; host: string; algorithm: string; fingerprint: string; change: 'first-use' | 'changed-key' }
  | { kind: 'authentication'; authentication: { flowId?: string; flowState: string; carrierState: string; promptState: 'not-observed' | 'observed'; writableAttachment: boolean } }
  | { kind: 'reconnect'; reason: string }

export type MachineConnectionAction =
  | 'inspect-trust'
  | 'trust-fingerprint'
  | 'start-authentication'
  | 'retry-carrier'
  | 'start-new-flow'
  | 'cancel-session-wait'
  | 'open-machine-settings'

export type ConnectionPresentationState =
  | { state: 'disconnected'; reason: string; retryable: boolean }
  | { state: 'checking' }
  | { state: 'connecting' }
  | { state: 'ready'; observedAt: Instant; expiresAt: Instant }
  | { state: 'blocked'; challengeId: string; challengeRevision: Revision; challenge: ConnectionChallenge; reason: string; expiresAt: Instant }
  | { state: 'stale'; lastReadyAt: Instant; reason: string }
  | { state: 'disconnecting' }

export interface MachineConnectionPresentation {
  schemaVersion: 1
  id: string
  ownerPrincipalId: 'local-owner'
  machineId: MachineId
  machineLabel: string
  connectionIdentityDigest: Sha256
  freshness: 'current' | 'stale' | 'unknown'
  connection: ConnectionPresentationState
  waitingSessionCount: number
  actions: readonly MachineConnectionAction[]
  revision: Revision
  updatedAt: Instant
}

export type ProjectionEvent =
  | {
      schemaVersion: 1
      cursor: Cursor
      projection: 'machine-connection'
      id: string
      revision: Revision
      change: 'upsert'
      value: MachineConnectionPresentation
    }
  | {
      schemaVersion: 1
      cursor: Cursor
      projection: 'machine-connection'
      id: string
      revision: Revision
      change: 'remove'
    }

export interface SnapshotProjection {
  schemaVersion: 1
  feedId: 'slop'
  asOfCursor: Cursor
  snapshotToken: string
  machineConnections: readonly MachineConnectionPresentation[]
}

export interface SnapshotQuery {
  machineId?: MachineId
  pageSize?: number
  snapshotToken?: string
  pageCursor?: string
}

export interface RemoteFailure {
  code: 'UNAVAILABLE' | 'AUTH_REQUIRED' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'BOUNDS' | 'STALE' | 'RESYNC_REQUIRED' | 'APPROVAL_REQUIRED' | 'FAILED' | 'ABORTED'
  message: string
  retryable: boolean
  fields?: Readonly<Record<string, string>>
  currentRevision?: Revision
}

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }
