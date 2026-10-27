import { z } from 'zod'
import {
  accessChallengeIdSchema,
  accessProfileIdSchema,
  agentIdSchema,
  authAttachmentLeaseIdSchema,
  authFlowIdSchema,
  connectionLeaseIdSchema,
  connectionObservationIdSchema,
  connectionWaiterIdSchema,
  instantSchema,
  machineIdSchema,
  nonEmptyTextSchema,
  revisionSchema,
  sessionIdSchema,
  sha256Schema,
} from '../primitives.ts'
import { schemaVersionSchema } from './common.ts'
import { localOwnerPrincipalIdSchema } from './inventory.ts'

/** Generic remote shell access bound into a waiter and resulting connection lease. */
export const connectionPurposeSchema = z.enum(['remote-read', 'file-transfer'])

const connectionObservationBase = {
  schemaVersion: schemaVersionSchema,
  id: connectionObservationIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  machineId: machineIdSchema,
  machineRevision: revisionSchema,
  accessProfileId: accessProfileIdSchema,
  accessProfileRevision: revisionSchema,
  connectionIdentityDigest: sha256Schema,
  generation: revisionSchema,
  observedAt: instantSchema,
}

/** One time-bounded connection fact. It is neither durable Machine state nor authority. */
export const connectionObservationSchema = z.discriminatedUnion('state', [
  z.object({ ...connectionObservationBase, state: z.literal('disconnected'), reason: nonEmptyTextSchema.max(1_024), retryable: z.boolean() }).strict(),
  z.object({ ...connectionObservationBase, state: z.literal('checking') }).strict(),
  z.object({ ...connectionObservationBase, state: z.literal('connecting') }).strict(),
  z.object({ ...connectionObservationBase, state: z.literal('ready'), connectedAt: instantSchema, expiresAt: instantSchema }).strict(),
  z.object({
    ...connectionObservationBase,
    state: z.literal('blocked'),
    challengeId: accessChallengeIdSchema,
    challengeRevision: revisionSchema,
  }).strict(),
  z.object({ ...connectionObservationBase, state: z.literal('stale'), lastReadyAt: instantSchema, reason: nonEmptyTextSchema.max(1_024) }).strict(),
  z.object({ ...connectionObservationBase, state: z.literal('disconnecting') }).strict(),
])

/** Exact user action currently preventing a connection from advancing. */
export const accessChallengeRequirementSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host-trust'),
    host: nonEmptyTextSchema.max(253),
    algorithm: nonEmptyTextSchema.max(128),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/).max(256),
    source: z.enum(['configured', 'user-known-hosts', 'observed']),
    change: z.enum(['first-use', 'changed-key']),
  }).strict(),
  z.object({
    kind: z.literal('authentication'),
    authFlowId: authFlowIdSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('reconnect'),
    lastObservationId: connectionObservationIdSchema,
    reason: nonEmptyTextSchema.max(1_024),
  }).strict(),
])

const challengeLifecycleSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }).strict(),
  z.object({ state: z.literal('resolved'), settledAt: instantSchema }).strict(),
  z.object({ state: z.literal('cancelled'), settledAt: instantSchema, reason: nonEmptyTextSchema.max(1_024).optional() }).strict(),
  z.object({ state: z.literal('expired'), settledAt: instantSchema }).strict(),
])

/** Global connection-identity challenge shared by separately scoped waiters. */
export const accessChallengeSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: accessChallengeIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  machineId: machineIdSchema,
  accessProfileId: accessProfileIdSchema,
  connectionIdentityDigest: sha256Schema,
  generation: revisionSchema,
  revision: revisionSchema,
  requirement: accessChallengeRequirementSchema,
  lifecycle: challengeLifecycleSchema,
  waiterIds: z.array(connectionWaiterIdSchema).max(10_000),
  createdAt: instantSchema,
  expiresAt: instantSchema,
}).strict().superRefine((challenge, context) => {
  if (new Set(challenge.waiterIds).size !== challenge.waiterIds.length) {
    context.addIssue({ code: 'custom', message: 'challenge waiter ids must be unique', path: ['waiterIds'] })
  }
})

const authFlowBase = {
  schemaVersion: schemaVersionSchema,
  id: authFlowIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  challengeId: accessChallengeIdSchema,
  machineId: machineIdSchema,
  connectionIdentityDigest: sha256Schema,
  revision: revisionSchema,
  createdAt: instantSchema,
  expiresAt: instantSchema,
}

/** Protected authentication lifecycle. Prompt text and terminal bytes have no fields. */
export const authFlowSchema = z.discriminatedUnion('state', [
  z.object({ ...authFlowBase, state: z.literal('created') }).strict(),
  z.object({ ...authFlowBase, state: z.literal('waiting-attachment') }).strict(),
  z.object({ ...authFlowBase, state: z.literal('interactive') }).strict(),
  z.object({ ...authFlowBase, state: z.literal('verifying') }).strict(),
  z.object({ ...authFlowBase, state: z.literal('ready'), settledAt: instantSchema }).strict(),
  z.object({ ...authFlowBase, state: z.literal('failed'), settledAt: instantSchema, reason: nonEmptyTextSchema.max(1_024), retryable: z.boolean() }).strict(),
  z.object({ ...authFlowBase, state: z.literal('expired'), settledAt: instantSchema }).strict(),
  z.object({ ...authFlowBase, state: z.literal('cancelled'), settledAt: instantSchema, reason: nonEmptyTextSchema.max(1_024).optional() }).strict(),
])

const carrierBase = {
  schemaVersion: schemaVersionSchema,
  authFlowId: authFlowIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  revision: revisionSchema,
  observedAt: instantSchema,
}

/** Browser carrier state, independent of the SSH authentication outcome. */
export const authCarrierObservationSchema = z.discriminatedUnion('state', [
  z.object({ ...carrierBase, state: z.literal('connecting') }).strict(),
  z.object({ ...carrierBase, state: z.literal('attached'), attachmentId: z.string().min(1).max(512) }).strict(),
  z.object({ ...carrierBase, state: z.literal('detached'), closeCode: z.number().int().min(0).max(65_535), reason: z.string().max(1_024) }).strict(),
  z.object({ ...carrierBase, state: z.literal('rejected'), reason: nonEmptyTextSchema.max(1_024) }).strict(),
  z.object({ ...carrierBase, state: z.literal('unavailable'), reason: nonEmptyTextSchema.max(1_024), retryable: z.boolean() }).strict(),
])

/** Redacted prompt observation. It records prompt class, never prompt content. */
export const authPromptObservationSchema = z.discriminatedUnion('state', [
  z.object({
    schemaVersion: schemaVersionSchema,
    authFlowId: authFlowIdSchema,
    state: z.literal('not-observed'),
    observedAt: instantSchema,
  }).strict(),
  z.object({
    schemaVersion: schemaVersionSchema,
    authFlowId: authFlowIdSchema,
    state: z.literal('observed'),
    promptKind: z.enum(['password', 'passphrase', 'otp', 'confirmation', 'unknown']),
    observedAt: instantSchema,
  }).strict(),
])

const attachmentLeaseBase = {
  schemaVersion: schemaVersionSchema,
  id: authAttachmentLeaseIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  authFlowId: authFlowIdSchema,
  attachmentId: z.string().min(1).max(512),
  mode: z.literal('write'),
  acquiredAt: instantSchema,
  expiresAt: instantSchema,
}

/** Temporary single-writer right for one protected browser attachment. */
export const authAttachmentLeaseSchema = z.discriminatedUnion('state', [
  z.object({ ...attachmentLeaseBase, state: z.literal('active') }).strict(),
  z.object({ ...attachmentLeaseBase, state: z.literal('released'), settledAt: instantSchema }).strict(),
  z.object({ ...attachmentLeaseBase, state: z.literal('revoked'), settledAt: instantSchema, reason: nonEmptyTextSchema.max(1_024) }).strict(),
  z.object({ ...attachmentLeaseBase, state: z.literal('expired'), settledAt: instantSchema }).strict(),
])

/** One pending model-tool call waiting on a shared access challenge. */
export const pendingConnectionWaiterSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: connectionWaiterIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  challengeId: accessChallengeIdSchema,
  toolCallId: z.string().min(1).max(512),
  sessionId: sessionIdSchema,
  agentId: agentIdSchema,
  machineId: machineIdSchema,
  connectionIdentityDigest: sha256Schema,
  purpose: connectionPurposeSchema,
  dependencyRevisions: z.record(z.string().min(1).max(512), revisionSchema),
  createdAt: instantSchema,
  expiresAt: instantSchema,
}).strict()

/** Purpose-bound right to use one ready connection. */
export const connectionLeaseSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: connectionLeaseIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  waiterId: connectionWaiterIdSchema.optional(),
  sessionId: sessionIdSchema,
  agentId: agentIdSchema,
  machineId: machineIdSchema,
  machineRevision: revisionSchema,
  accessProfileId: accessProfileIdSchema,
  accessProfileRevision: revisionSchema,
  connectionIdentityDigest: sha256Schema,
  purpose: connectionPurposeSchema,
  acquiredAt: instantSchema,
  expiresAt: instantSchema,
}).strict()

/** Fingerprint-bound trust decision, separate from credentials and execution approval. */
export const hostTrustDecisionSchema = z.object({
  schemaVersion: schemaVersionSchema,
  challengeId: accessChallengeIdSchema,
  challengeRevision: revisionSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  decision: z.enum(['trust-once', 'trust-and-pin', 'reject']),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/).max(256),
  decidedAt: instantSchema,
}).strict()

export type ConnectionObservation = z.output<typeof connectionObservationSchema>
export type AccessChallenge = z.output<typeof accessChallengeSchema>
export type AuthFlow = z.output<typeof authFlowSchema>
export type AuthCarrierObservation = z.output<typeof authCarrierObservationSchema>
export type AuthPromptObservation = z.output<typeof authPromptObservationSchema>
export type AuthAttachmentLease = z.output<typeof authAttachmentLeaseSchema>
export type PendingConnectionWaiter = z.output<typeof pendingConnectionWaiterSchema>
export type ConnectionLease = z.output<typeof connectionLeaseSchema>
export type HostTrustDecision = z.output<typeof hostTrustDecisionSchema>
