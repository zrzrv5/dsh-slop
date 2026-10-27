import { z } from 'zod'
import {
  accessChallengeIdSchema,
  agentIdSchema,
  authAttachmentLeaseIdSchema,
  authFlowIdSchema,
  connectionObservationIdSchema,
  connectionWaiterIdSchema,
  instantSchema,
  machineIdSchema,
  nonEmptyTextSchema,
  revisionSchema,
  sessionIdSchema,
} from './primitives.ts'
import {
  accessChallengeRequirementSchema,
  connectionPurposeSchema,
  type AccessChallenge,
  type AuthAttachmentLease,
  type AuthFlow,
  type AuthPromptObservation,
  type ConnectionLease,
  type ConnectionObservation,
  type HostTrustDecision,
  type PendingConnectionWaiter,
} from './domain/access.ts'
import type { MachineConnectionPresentation } from './domain/presentation.ts'

/** Internal host context for one connection request. The caller cannot select a principal. */
export const requireConnectionRequestSchema = z.object({
  toolCallId: z.string().min(1).max(512),
  sessionId: sessionIdSchema,
  agentId: agentIdSchema,
  machineId: machineIdSchema,
  expectedMachineRevision: revisionSchema,
  expectedAccessProfileRevision: revisionSchema,
  generation: revisionSchema,
  purpose: connectionPurposeSchema,
  minimumRemainingSeconds: z.number().int().nonnegative().max(3_600).optional(),
  requirement: accessChallengeRequirementSchema,
}).strict()

export const readyConnectionObservationRequestSchema = z.object({
  machineId: machineIdSchema,
  expectedMachineRevision: revisionSchema,
  expectedAccessProfileRevision: revisionSchema,
  generation: revisionSchema,
  connectedAt: instantSchema.optional(),
  expiresAt: instantSchema,
}).strict()

export const disconnectedConnectionObservationRequestSchema = z.object({
  machineId: machineIdSchema,
  expectedMachineRevision: revisionSchema,
  expectedAccessProfileRevision: revisionSchema,
  generation: revisionSchema,
  reason: nonEmptyTextSchema.max(1_024),
  retryable: z.boolean(),
}).strict()

export const resolveAccessChallengeRequestSchema = z.object({
  challengeId: accessChallengeIdSchema,
  expectedChallengeRevision: revisionSchema,
  readyObservationId: connectionObservationIdSchema,
}).strict()

export const replaceConnectionRequirementRequestSchema = z.object({
  challengeId: accessChallengeIdSchema,
  expectedChallengeRevision: revisionSchema,
  requirement: accessChallengeRequirementSchema,
}).strict()

export const cancelConnectionWaiterRequestSchema = z.object({
  waiterId: connectionWaiterIdSchema,
}).strict()

export const recordHostTrustDecisionRequestSchema = z.object({
  challengeId: accessChallengeIdSchema,
  expectedChallengeRevision: revisionSchema,
  decision: z.enum(['trust-once', 'trust-and-pin', 'reject']),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/).max(256),
}).strict()

export const startAuthFlowRequestSchema = z.object({
  challengeId: accessChallengeIdSchema,
  expectedChallengeRevision: revisionSchema,
}).strict()

export const acquireAuthAttachmentRequestSchema = z.object({
  authFlowId: authFlowIdSchema,
  attachmentId: z.string().min(1).max(512),
}).strict()

export const releaseAuthAttachmentRequestSchema = z.object({
  leaseId: authAttachmentLeaseIdSchema,
}).strict()

export const observeAuthPromptRequestSchema = z.discriminatedUnion('state', [
  z.object({ authFlowId: authFlowIdSchema, state: z.literal('not-observed') }).strict(),
  z.object({
    authFlowId: authFlowIdSchema,
    state: z.literal('observed'),
    promptKind: z.enum(['password', 'passphrase', 'otp', 'confirmation', 'unknown']),
  }).strict(),
])

export interface AccessCoordinatorOptions {
  readonly now?: () => Date
  readonly challengeTtlMs?: number
  readonly waiterTtlMs?: number
  readonly connectionLeaseTtlMs?: number
  readonly authFlowTtlMs?: number
  readonly attachmentLeaseTtlMs?: number
}

export type RequireConnectionResult =
  | {
      readonly kind: 'ready'
      readonly observation: ConnectionObservation & { readonly state: 'ready' }
      readonly lease: ConnectionLease
      readonly presentation: MachineConnectionPresentation
    }
  | {
      readonly kind: 'blocked'
      readonly challenge: AccessChallenge
      readonly waiter: PendingConnectionWaiter
      readonly presentation: MachineConnectionPresentation
    }

export interface ResolveAccessChallengeResult {
  readonly kind: 'resolved'
  readonly challenge: AccessChallenge
  readonly observation: ConnectionObservation & { readonly state: 'ready' }
  readonly leases: readonly ConnectionLease[]
  readonly skippedWaiterIds: readonly PendingConnectionWaiter['id'][]
  readonly presentation: MachineConnectionPresentation
}

export interface ReplaceConnectionRequirementResult {
  readonly challenge: AccessChallenge
  readonly presentation: MachineConnectionPresentation
}

export interface HostTrustDecisionResult {
  readonly decision: HostTrustDecision
  readonly challenge: AccessChallenge
  readonly presentation: MachineConnectionPresentation
}

export interface AuthFlowResult {
  readonly flow: AuthFlow
  readonly challenge: AccessChallenge
  readonly presentation: MachineConnectionPresentation
}

export interface AuthAttachmentResult {
  readonly lease: AuthAttachmentLease
  readonly presentation: MachineConnectionPresentation
}

export interface AuthPromptResult {
  readonly observation: AuthPromptObservation
  readonly presentation?: MachineConnectionPresentation
}

export class AccessCoordinatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessCoordinatorError'
  }
}

export class AccessNotFoundError extends AccessCoordinatorError {
  constructor(message: string) {
    super(message)
    this.name = 'AccessNotFoundError'
  }
}

export class AccessConflictError extends AccessCoordinatorError {
  constructor(message: string) {
    super(message)
    this.name = 'AccessConflictError'
  }
}

export class AccessOrderingError extends AccessCoordinatorError {
  constructor(message: string) {
    super(message)
    this.name = 'AccessOrderingError'
  }
}

export class AuthAttachmentConflictError extends AccessCoordinatorError {
  constructor(message: string) {
    super(message)
    this.name = 'AuthAttachmentConflictError'
  }
}

export type RequireConnectionRequest = z.output<typeof requireConnectionRequestSchema>
export type ReadyConnectionObservationRequest = z.output<typeof readyConnectionObservationRequestSchema>
export type DisconnectedConnectionObservationRequest = z.output<typeof disconnectedConnectionObservationRequestSchema>
export type ResolveAccessChallengeRequest = z.output<typeof resolveAccessChallengeRequestSchema>
export type ReplaceConnectionRequirementRequest = z.output<typeof replaceConnectionRequirementRequestSchema>
export type CancelConnectionWaiterRequest = z.output<typeof cancelConnectionWaiterRequestSchema>
export type RecordHostTrustDecisionRequest = z.output<typeof recordHostTrustDecisionRequestSchema>
export type StartAuthFlowRequest = z.output<typeof startAuthFlowRequestSchema>
export type AcquireAuthAttachmentRequest = z.output<typeof acquireAuthAttachmentRequestSchema>
export type ReleaseAuthAttachmentRequest = z.output<typeof releaseAuthAttachmentRequestSchema>
export type ObserveAuthPromptRequest = z.output<typeof observeAuthPromptRequestSchema>
