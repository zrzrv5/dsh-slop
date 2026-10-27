import { z } from 'zod'
import {
  accessChallengeIdSchema,
  authFlowIdSchema,
  decimalStringSchema,
  instantSchema,
  machineIdSchema,
  nonEmptyTextSchema,
  revisionSchema,
  sha256Schema,
} from '../primitives.ts'
import { schemaVersionSchema } from './common.ts'
import { localOwnerPrincipalIdSchema } from './inventory.ts'

export const machineConnectionActionSchema = z.enum([
  'inspect-trust',
  'trust-fingerprint',
  'start-authentication',
  'retry-carrier',
  'start-new-flow',
  'cancel-session-wait',
  'open-machine-settings',
])

const authenticationPresentationSchema = z.object({
  flowId: authFlowIdSchema.optional(),
  flowState: z.enum([
    'not-started',
    'created',
    'waiting-attachment',
    'interactive',
    'verifying',
    'ready',
    'failed',
    'expired',
    'cancelled',
  ]),
  carrierState: z.enum(['not-started', 'connecting', 'attached', 'detached', 'rejected', 'unavailable']),
  promptState: z.enum(['not-observed', 'observed']),
  writableAttachment: z.boolean(),
}).strict()

const challengePresentationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host-trust'),
    host: nonEmptyTextSchema.max(253),
    algorithm: nonEmptyTextSchema.max(128),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/).max(256),
    change: z.enum(['first-use', 'changed-key']),
  }).strict(),
  z.object({ kind: z.literal('authentication'), authentication: authenticationPresentationSchema }).strict(),
  z.object({ kind: z.literal('reconnect'), reason: nonEmptyTextSchema.max(1_024) }).strict(),
])

const connectionPresentationStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disconnected'), reason: nonEmptyTextSchema.max(1_024), retryable: z.boolean() }).strict(),
  z.object({ state: z.literal('checking') }).strict(),
  z.object({ state: z.literal('connecting') }).strict(),
  z.object({ state: z.literal('ready'), observedAt: instantSchema, expiresAt: instantSchema }).strict(),
  z.object({
    state: z.literal('blocked'),
    challengeId: accessChallengeIdSchema,
    challengeRevision: revisionSchema,
    challenge: challengePresentationSchema,
    reason: nonEmptyTextSchema.max(1_024),
    expiresAt: instantSchema,
  }).strict(),
  z.object({ state: z.literal('stale'), lastReadyAt: instantSchema, reason: nonEmptyTextSchema.max(1_024) }).strict(),
  z.object({ state: z.literal('disconnecting') }).strict(),
])

/** Safe Machine access projection. It cannot contain prompt or terminal bytes. */
export const machineConnectionPresentationSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: z.string().min(1).max(512),
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  machineId: machineIdSchema,
  machineLabel: nonEmptyTextSchema.max(256),
  connectionIdentityDigest: sha256Schema,
  freshness: z.enum(['current', 'stale', 'unknown']),
  connection: connectionPresentationStateSchema,
  waitingSessionCount: z.number().int().nonnegative().max(10_000),
  actions: z.array(machineConnectionActionSchema).max(8),
  revision: revisionSchema,
  updatedAt: instantSchema,
}).strict()

export const machineConnectionPresentationEventSchema = z.discriminatedUnion('change', [
  z.object({
    schemaVersion: schemaVersionSchema,
    cursor: decimalStringSchema,
    projection: z.literal('machine-connection'),
    id: z.string().min(1).max(512),
    revision: revisionSchema,
    change: z.literal('upsert'),
    value: machineConnectionPresentationSchema,
  }).strict(),
  z.object({
    schemaVersion: schemaVersionSchema,
    cursor: decimalStringSchema,
    projection: z.literal('machine-connection'),
    id: z.string().min(1).max(512),
    revision: revisionSchema,
    change: z.literal('remove'),
  }).strict(),
]).superRefine((event, context) => {
  if (event.change === 'upsert' && (event.value.id !== event.id || event.value.revision !== event.revision)) {
    context.addIssue({
      code: 'custom',
      message: 'projection value identity and revision must match its event envelope',
      path: ['value'],
    })
  }
})

export const projectionEventSchema = machineConnectionPresentationEventSchema

export type MachineConnectionPresentation = z.output<typeof machineConnectionPresentationSchema>
export type MachineConnectionPresentationEvent = z.output<typeof machineConnectionPresentationEventSchema>
export type ProjectionEvent = z.output<typeof projectionEventSchema>
