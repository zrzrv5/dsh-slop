import type {
  Cursor,
  MachineId,
  MachineProjection,
  ProjectionEvent,
  RemoteFailure,
  RemoteResult,
  Revision,
  SnapshotProjection,
  SnapshotQuery,
} from './types.ts'

export interface MachineArchiveRequest {
  readonly schemaVersion: 1
  readonly machineId: MachineId
  readonly expectedMachineRevision: Revision
  readonly expectedAccessProfileRevision: Revision
  readonly idempotencyKey: string
}

export interface SnapshotPage {
  readonly snapshot: SnapshotProjection
  readonly nextPageCursor?: string
  readonly complete: boolean
}

export interface AccessChallengeReference {
  readonly challengeId: string
  readonly expectedChallengeRevision: Revision
}

export type HostTrustDecision = 'trust-once' | 'trust-and-pin' | 'reject'

export interface HostTrustDecisionRequest extends AccessChallengeReference {
  readonly decision: HostTrustDecision
  readonly fingerprint: string
}

export interface HostTrustDecisionResponse {
  readonly challenge: { readonly id: string; readonly revision: Revision }
  readonly decision: { readonly decision: HostTrustDecision; readonly fingerprint: string }
}

export interface AuthFlowStartResponse {
  readonly scope: 'machine'
  readonly authFlowId: string
  readonly carrierFlowId: string
  readonly challenge: { readonly id: string; readonly revision: Revision }
  readonly expiresAt: string
}

export interface AuthFlowStatusResponse {
  readonly state: 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired'
  readonly resumed: boolean
}

export interface TransferProgressResponse {
  readonly callId: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly output: string
}

export interface AuthTerminalClient {
  open(
    carrierFlowId: string,
    onOutput: (text: string) => void,
    onState?: (state: 'connecting' | 'attached' | 'closed' | 'error') => void,
  ): { send(text: string): void; close(): void }
}

export interface EventFeedClient {
  subscribe(
    feedId: 'slop',
    asOfCursor: Cursor,
    snapshotToken: string,
    onEvent: (event: ProjectionEvent) => void,
    onState?: (state: 'subscribed' | 'resync-required' | 'offline') => void,
  ): () => void
}

/** Exact browser-only Machine transport, including ephemeral transfer progress. */
export interface SlopRemoteMap {
  readonly 'slop.snapshot': { readonly request: SnapshotQuery; readonly response: SnapshotPage }
  readonly 'slop.machine.list': {
    readonly request: { readonly search?: string; readonly includeArchived?: boolean }
    readonly response: readonly MachineProjection[]
  }
  readonly 'slop.machine.get': {
    readonly request: { readonly machineId: MachineId }
    readonly response: MachineProjection
  }
  readonly 'slop.machine.archive': { readonly request: MachineArchiveRequest; readonly response: MachineProjection }
  readonly 'slop.hostTrust.decide': {
    readonly request: HostTrustDecisionRequest
    readonly response: HostTrustDecisionResponse
  }
  readonly 'slop.authFlow.start': {
    readonly request: AccessChallengeReference
    readonly response: AuthFlowStartResponse
  }
  readonly 'slop.authFlow.status': {
    readonly request: { readonly authFlowId: string }
    readonly response: AuthFlowStatusResponse
  }
  readonly 'slop.authFlow.cancel': {
    readonly request: { readonly authFlowId: string }
    readonly response: { readonly cancelled: true }
  }
  readonly 'slop.transferProgress.get': {
    readonly request: { readonly callId: string }
    readonly response: TransferProgressResponse
  }
}

export type RemoteMethod = keyof SlopRemoteMap
export type RemoteRequest<M extends RemoteMethod> = SlopRemoteMap[M]['request']
export type RemoteResponse<M extends RemoteMethod> = SlopRemoteMap[M]['response']

export interface SlopRemoteClient {
  call<M extends RemoteMethod>(method: M, request: RemoteRequest<M>): Promise<RemoteResult<RemoteResponse<M>>>
  readonly events?: EventFeedClient
  readonly auth?: AuthTerminalClient
  connect?(): Promise<void>
  close?(): void
}

export type SlopRemoteFacade = {
  readonly [M in RemoteMethod]: (request: RemoteRequest<M>) => Promise<RemoteResult<RemoteResponse<M>>>
}

export function createRemoteFacade(client: SlopRemoteClient): SlopRemoteFacade {
  return new Proxy({}, {
    get: (_target, method: string) => (request: unknown) => client.call(method as RemoteMethod, request as never),
  }) as SlopRemoteFacade
}

export function isRemoteFailure(value: unknown): value is RemoteFailure {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && 'message' in value
    && 'retryable' in value
}
