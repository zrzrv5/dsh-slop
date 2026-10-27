import { z } from 'zod'

export const queueItemIdSchema = z.string().min(1).max(128).brand<'QueueItemId'>()
export type QueueItemId = z.output<typeof queueItemIdSchema>

export const sessionIdSchema = z.string().min(1).max(256).brand<'QueueSessionId'>()
export type QueueSessionId = z.output<typeof sessionIdSchema>

export const machineIdSchema = z.string().min(1).max(128).brand<'QueueMachineId'>()
export type QueueMachineId = z.output<typeof machineIdSchema>

export const queueStateSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown',
])
export type QueueState = z.output<typeof queueStateSchema>

export const observerKindSchema = z.enum(['slurm', 'pbs', 'process'])
export type ObserverKind = z.output<typeof observerKindSchema>

export const queueTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('machine'), machineId: machineIdSchema }).strict(),
])
export type QueueTarget = z.output<typeof queueTargetSchema>
export type QueueTargetInput = z.input<typeof queueTargetSchema>

export const processHandleSchema = z.object({
  pid: z.number().int().positive().safe(),
  startToken: z.string().min(1).max(512),
  launchedAt: z.iso.datetime({ offset: true }),
  exitCodePath: z.string().min(1).max(8_192),
  stdoutPath: z.string().min(1).max(8_192),
  stderrPath: z.string().min(1).max(8_192),
}).strict()
export type ProcessHandle = z.output<typeof processHandleSchema>

export const queueObserverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slurm'), jobId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('pbs'), jobId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('process'), handle: processHandleSchema }).strict(),
])
export type QueueObserver = z.output<typeof queueObserverSchema>
export type QueueObserverInput = z.input<typeof queueObserverSchema>

const secondsSchema = z.number().int().positive().safe()

export const monitoringHintsSchema = z.object({
  expectedDurationSeconds: secondsSchema.optional(),
  earliestCheckAfterSeconds: secondsSchema.optional(),
  preferredIntervalSeconds: secondsSchema.optional(),
  maximumIntervalSeconds: secondsSchema.optional(),
  userIntervalSeconds: secondsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.preferredIntervalSeconds !== undefined
    && value.maximumIntervalSeconds !== undefined
    && value.preferredIntervalSeconds > value.maximumIntervalSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['preferredIntervalSeconds'],
      message: 'preferredIntervalSeconds cannot exceed maximumIntervalSeconds',
    })
  }
  if (
    value.userIntervalSeconds !== undefined
    && value.maximumIntervalSeconds !== undefined
    && value.userIntervalSeconds > value.maximumIntervalSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['userIntervalSeconds'],
      message: 'userIntervalSeconds cannot exceed maximumIntervalSeconds',
    })
  }
})
export type MonitoringHints = z.output<typeof monitoringHintsSchema>

export const triggerConditionSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown',
  'any-state-change',
])
export type TriggerCondition = z.output<typeof triggerConditionSchema>

export const deliveryModeSchema = z.enum(['wake', 'notify'])
export type DeliveryMode = z.output<typeof deliveryModeSchema>

export const queueSessionTargetSchema = z.object({
  sessionId: sessionIdSchema,
  cwd: z.string().min(1).max(8_192),
  agentPreset: z.string().min(1).max(512),
}).strict()
export type QueueSessionTarget = z.output<typeof queueSessionTargetSchema>

export const queueSubscriptionSchema = z.object({
  target: queueSessionTargetSchema,
  delivery: deliveryModeSchema,
  conditions: z.array(triggerConditionSchema).min(1).max(7),
}).strict()
export type QueueSubscription = z.output<typeof queueSubscriptionSchema>

export const queueAttentionSchema = z.object({
  primary: queueSessionTargetSchema,
  primaryDelivery: deliveryModeSchema,
  primaryConditions: z.array(triggerConditionSchema).min(1).max(7),
  subscriptions: z.array(queueSubscriptionSchema),
}).strict()
export type QueueAttention = z.output<typeof queueAttentionSchema>

export const queueObservationSchema = z.object({
  queueItemId: queueItemIdSchema,
  state: queueStateSchema,
  observedAt: z.iso.datetime({ offset: true }),
  evidence: z.string().min(1).max(128_000),
  elapsedSeconds: z.number().nonnegative().safe().optional(),
  expectedRemainingSeconds: z.number().nonnegative().safe().optional(),
  recommendedCheckAfterSeconds: secondsSchema.optional(),
  recommendationReason: z.string().min(1).max(4_096).optional(),
  walltimeSeconds: z.number().nonnegative().safe().optional(),
  walltimeRemainingSeconds: z.number().nonnegative().safe().optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  phase: z.string().min(1).max(128).optional(),
  source: z.enum(['code', 'agent-fallback', 'webhook']).default('agent-fallback'),
  attention: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4_096),
  }).strict().optional(),
}).strict()
export type QueueObservation = z.output<typeof queueObservationSchema>

export const queuePurposeSchema = z.enum(['monitor', 'continue'])
export const queueTrackingSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('monitor') }).strict(),
  z.object({ purpose: z.literal('continue'), continuation: z.string().trim().min(1).max(4_096) }).strict(),
])
export type QueueTracking = z.output<typeof queueTrackingSchema>
export function trackingPolicy(input: unknown) {
  const tracking = queueTrackingSchema.parse(input)
  return { ...tracking, primaryDelivery: tracking.purpose === 'continue' ? 'wake' as const : 'notify' as const,
    primaryConditions: tracking.purpose === 'continue' ? ['completed', 'failed', 'cancelled'] as const : ['any-state-change'] as const }
}

export const queueItemSchema = z.object({
  id: queueItemIdSchema,
  label: z.string().min(1).max(1_024),
  verificationPending: z.boolean().optional(),
  purpose: queuePurposeSchema.optional(),
  continuation: z.string().trim().min(1).max(4_096).optional(),
  notes: z.string().max(32_768).optional(),
  tags: z.array(z.string().min(1).max(128)).max(128),
  target: queueTargetSchema,
  observer: queueObserverSchema,
  state: queueStateSchema,
  monitoring: monitoringHintsSchema,
  attention: queueAttentionSchema,
  revision: z.number().int().positive().safe(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  nextCheckAt: z.iso.datetime({ offset: true }).optional(),
  consecutiveUnchangedChecks: z.number().int().nonnegative().safe(),
  consecutiveFailures: z.number().int().nonnegative().safe(),
  lastCheckError: z.object({
    at: z.iso.datetime({ offset: true }),
    message: z.string().min(1).max(8_192),
  }).strict().optional(),
  lastObservation: queueObservationSchema.optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  runningObservedAt: z.iso.datetime({ offset: true }).optional(),
  walltimeSeconds: z.number().nonnegative().safe().optional(),
  phase: z.string().min(1).max(128).optional(),
  callback: z.object({
    runId: z.string().uuid(),
    attempt: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    terminalPending: z.boolean(),
  }).strict().optional(),
}).strict()
export type QueueItem = z.output<typeof queueItemSchema>

export const deliveryTriggerSchema = z.object({
  triggerKey: z.string().min(1).max(512),
  queueItemId: queueItemIdSchema,
  label: z.string().min(1).max(1_024),
  previousState: queueStateSchema,
  state: queueStateSchema,
  observedAt: z.iso.datetime({ offset: true }),
  evidence: z.string().min(1).max(128_000),
  event: z.enum(['state-change', 'monitor-degraded', 'monitor-recovered', 'action-required']).default('state-change'),
}).strict()
export type DeliveryTrigger = z.output<typeof deliveryTriggerSchema>

export const deliveryRecordSchema = z.object({
  shutdownMessageId: z.string().optional(),
  target: queueSessionTargetSchema,
  trigger: deliveryTriggerSchema,
  delivery: deliveryModeSchema,
  state: z.enum(['pending', 'delivered']),
  dispatchId: z.string().uuid().optional(),
  receipt: z.enum(['enqueued', 'consumed', 'discarded']).optional(),
  attempts: z.number().int().nonnegative().safe(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  deliveredAt: z.iso.datetime({ offset: true }).optional(),
  lastError: z.string().min(1).max(8_192).optional(),
  nextAttemptAt: z.iso.datetime({ offset: true }).optional(),
}).strict()
export type DeliveryRecord = z.output<typeof deliveryRecordSchema>

export const workerObservationBatchSchema = z.object({
  observations: z.array(queueObservationSchema),
}).strict()
export type WorkerObservationBatch = z.output<typeof workerObservationBatchSchema>

export type QueueTrackInput = QueueTracking & {
  readonly id?: string
  readonly label: string
  readonly notes?: string
  readonly tags?: readonly string[]
  readonly target: QueueTargetInput
  readonly observer: QueueObserverInput
  readonly initialState?: QueueState
  readonly monitoring?: MonitoringHints
}

/** The host supplies this separately so model-authored input cannot choose the owning chat. */
export interface QueueTrackContext {
  readonly primary: {
    readonly sessionId: string
    readonly cwd: string
    readonly agentPreset: string
  }
  readonly now?: Date
}

export interface QueueListFilter {
  readonly states?: readonly QueueState[]
  readonly observerKinds?: readonly ObserverKind[]
  readonly target?: QueueTargetInput
  readonly tags?: readonly string[]
  readonly primarySessionId?: string
  readonly subscribedSessionId?: string
}

export interface QueueSubscriptionInput {
  readonly delivery: DeliveryMode
  readonly conditions: readonly TriggerCondition[]
}

/** The host injects the current Chat target; model-authored subscription input has no session selector. */
export interface QueueSubscriptionContext {
  readonly current: {
    readonly sessionId: string
    readonly cwd: string
    readonly agentPreset: string
  }
  readonly now?: Date
}

export interface QueueItemPatch {
  readonly purpose?: QueueTracking['purpose']
  readonly continuation?: string
  readonly label?: string
  readonly notes?: string | null
  readonly tags?: readonly string[]
  readonly monitoring?: MonitoringHints
  readonly nextCheckAt?: string | null
  readonly primaryDelivery?: DeliveryMode
  readonly primaryConditions?: readonly TriggerCondition[]
}

export interface QueryBatchItem {
  readonly id: QueueItemId
  readonly label: string
  readonly notes?: string
  readonly state: QueueState
  readonly observer: QueueObserver
  readonly createdAt: string
  readonly lastObservation?: QueueObservation
}

export interface QueueQueryRequest {
  readonly batchId: string
  /** Parent Chat used by the host when spawning the fresh query worker. */
  readonly parent: QueueSessionTarget
  readonly target: QueueTarget
  readonly observerKind: ObserverKind
  readonly items: readonly QueryBatchItem[]
  readonly prompt: string
}

export interface QueueProbeRequest {
  readonly batchId: string
  readonly target: QueueTarget
  readonly observerKind: ObserverKind
  readonly items: readonly QueryBatchItem[]
}

export const queueProbeIssueSchema = z.object({
  queueItemId: queueItemIdSchema,
  kind: z.enum(['fallback', 'retry', 'action-required']),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(8_192),
  evidence: z.string().max(128_000).optional(),
}).strict()
export type QueueProbeIssue = z.output<typeof queueProbeIssueSchema>

export const queueProbeBatchSchema = z.object({
  observations: z.array(queueObservationSchema),
  issues: z.array(queueProbeIssueSchema),
}).strict()
export type QueueProbeBatch = z.output<typeof queueProbeBatchSchema>

/** Deterministic, non-model observer. The host owns command execution and parsing. */
export interface QueueProbePort {
  probe(request: QueueProbeRequest): Promise<unknown>
}

/** Adapter port for one fresh, short-context query worker. The core validates its unknown response. */
export interface QueueQueryWorkerPort {
  query(request: QueueQueryRequest): Promise<unknown>
}

export interface QueueDeliveryRequest {
  readonly shutdownMessageId?: string
  readonly dispatchId?: string
  readonly target: QueueSessionTarget
  readonly delivery: DeliveryMode
  readonly triggers: readonly DeliveryTrigger[]
}

/** Adapter port for DSH task wakeups or passive notifications. */
export interface QueueChatDeliveryPort {
  deliver(request: QueueDeliveryRequest): Promise<void | { readonly state: 'enqueued' | 'consumed' | 'discarded' }>
}

export interface QueueTimerHandle {
  cancel(): void
}

export interface QueueTimerPort {
  schedule(at: Date, callback: () => void): QueueTimerHandle
}

export interface QueueClockPort {
  now(): Date
}

export const queueSettingsProfileSchema = z.enum(['normal', 'economy', 'custom'])
export type QueueSettingsProfile = z.output<typeof queueSettingsProfileSchema>

const configurableIntervalSchema = z.number().int().min(60).max(7 * 24 * 60 * 60).safe()

export const queueSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive().safe(),
  profile: queueSettingsProfileSchema,
  initialCheckSeconds: configurableIntervalSchema,
  automaticMinimumSeconds: configurableIntervalSchema,
  stableMinimumSeconds: configurableIntervalSchema,
  startupWindowSeconds: configurableIntervalSchema.default(600),
  startupIntervalSeconds: configurableIntervalSchema.default(60),
  walltimeDivisor: z.number().int().min(1).max(100).safe(),
  durationMaximumSeconds: configurableIntervalSchema,
  maximumDetectionDelaySeconds: configurableIntervalSchema,
  queuedMaximumSeconds: configurableIntervalSchema,
  fallbackEnabled: z.boolean(),
  defaultDelivery: deliveryModeSchema,
  defaultConditions: z.array(triggerConditionSchema).min(1).max(7),
  updatedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.startupIntervalSeconds > value.startupWindowSeconds) {
    context.addIssue({ code: 'custom', path: ['startupIntervalSeconds'], message: 'startup interval cannot exceed the startup window' })
  }
  if (value.automaticMinimumSeconds < value.initialCheckSeconds) {
    context.addIssue({ code: 'custom', path: ['automaticMinimumSeconds'], message: 'automatic minimum cannot be below initial check' })
  }
  if (value.stableMinimumSeconds < value.automaticMinimumSeconds) {
    context.addIssue({ code: 'custom', path: ['stableMinimumSeconds'], message: 'stable minimum cannot be below automatic minimum' })
  }
  if (value.durationMaximumSeconds < value.stableMinimumSeconds) {
    context.addIssue({ code: 'custom', path: ['durationMaximumSeconds'], message: 'duration maximum cannot be below stable minimum' })
  }
})
export type QueueSettings = z.output<typeof queueSettingsSchema>

export interface QueueSettingsPatch {
  readonly profile?: QueueSettingsProfile
  readonly initialCheckSeconds?: number
  readonly automaticMinimumSeconds?: number
  readonly stableMinimumSeconds?: number
  readonly startupWindowSeconds?: number
  readonly startupIntervalSeconds?: number
  readonly walltimeDivisor?: number
  readonly durationMaximumSeconds?: number
  readonly maximumDetectionDelaySeconds?: number
  readonly queuedMaximumSeconds?: number
  readonly fallbackEnabled?: boolean
  readonly defaultDelivery?: DeliveryMode
  readonly defaultConditions?: readonly TriggerCondition[]
}

export const NORMAL_QUEUE_SETTINGS = Object.freeze({
  initialCheckSeconds: 60,
  automaticMinimumSeconds: 120,
  stableMinimumSeconds: 300,
  startupWindowSeconds: 600,
  startupIntervalSeconds: 60,
  walltimeDivisor: 4,
  durationMaximumSeconds: 43_200,
  maximumDetectionDelaySeconds: 7_200,
  queuedMaximumSeconds: 3_600,
  fallbackEnabled: true,
  defaultDelivery: 'notify' as const,
  defaultConditions: ['any-state-change'] as const,
})

export const ECONOMY_QUEUE_SETTINGS = Object.freeze({
  ...NORMAL_QUEUE_SETTINGS,
  maximumDetectionDelaySeconds: 43_200,
})

export function defaultQueueSettings(now = new Date()): QueueSettings {
  return queueSettingsSchema.parse({
    schemaVersion: 1,
    revision: 1,
    profile: 'normal',
    ...NORMAL_QUEUE_SETTINGS,
    updatedAt: now.toISOString(),
  })
}

export function targetKey(target: QueueTarget): string {
  return target.kind === 'local' ? 'local' : `machine:${target.machineId}`
}

export function isTerminalState(state: QueueState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}
