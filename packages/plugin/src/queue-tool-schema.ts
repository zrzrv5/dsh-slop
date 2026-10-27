import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type InferValue,
  type ParameterSchemaSpec,
  type ValueSchemaSpec,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
} from '@deepseek-ai/dsh-tools'

export const MAX_QUEUE_TOOL_BYTES = 256 * 1024

function objectSchema<const Properties extends ParameterSchemaSpec>(
  properties: Properties,
): { readonly type: 'object'; readonly properties: Properties; readonly additionalProperties: false }
function objectSchema<const Properties extends ParameterSchemaSpec, const AdditionalProperties extends boolean>(
  properties: Properties,
  additionalProperties: AdditionalProperties,
): { readonly type: 'object'; readonly properties: Properties; readonly additionalProperties: AdditionalProperties }
function objectSchema(
  properties: ParameterSchemaSpec,
  additionalProperties = false,
): ValueSchemaSpec {
  return { type: 'object', properties, additionalProperties }
}

function required<const Schema extends ValueSchemaSpec>(
  schema: Schema,
): Schema & { readonly required: true } {
  return { ...schema, required: true }
}

const stringSchema = { type: 'string' } satisfies ValueSchemaSpec
const integerSchema = { type: 'integer' } satisfies ValueSchemaSpec
const numberSchema = { type: 'number' } satisfies ValueSchemaSpec
const stateSchema = {
  type: 'string',
  enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'],
} satisfies ValueSchemaSpec
const deliverySchema = { type: 'string', enum: ['wake', 'notify'] } satisfies ValueSchemaSpec
const conditionSchema = {
  type: 'string',
  enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'any-state-change'],
} satisfies ValueSchemaSpec

export const queueTargetValueSchema = {
  oneOf: [
    objectSchema({ kind: required({ type: 'string', const: 'local' }) }),
    objectSchema({
      kind: required({ type: 'string', const: 'machine' }),
      machineId: required(stringSchema),
    }),
  ],
} satisfies ValueSchemaSpec

const processHandleSchema = objectSchema({
  pid: required(integerSchema),
  startToken: required({ type: 'string', description: 'Trimmed output of LC_ALL=C ps -p <pid> -o lstart=, captured for the already-launched process. If metadata collection fails, query that same PID; do not launch the task again.' }),
  launchedAt: required(stringSchema),
  exitCodePath: required(stringSchema),
  stdoutPath: required(stringSchema),
  stderrPath: required(stringSchema),
})

export const queueObserverValueSchema = {
  oneOf: [
    objectSchema({
      kind: required({ type: 'string', const: 'slurm' }),
      jobId: required(stringSchema),
    }),
    objectSchema({
      kind: required({ type: 'string', const: 'pbs' }),
      jobId: required(stringSchema),
    }),
    objectSchema({
      kind: required({ type: 'string', const: 'process' }),
      handle: required(processHandleSchema),
    }),
  ],
} satisfies ValueSchemaSpec

export const monitoringHintsValueSchema = objectSchema({
  expectedDurationSeconds: integerSchema,
  earliestCheckAfterSeconds: integerSchema,
  preferredIntervalSeconds: integerSchema,
  maximumIntervalSeconds: integerSchema,
  userIntervalSeconds: integerSchema,
})

export const triggerConditionsValueSchema = {
  type: 'array',
  items: conditionSchema,
} satisfies ValueSchemaSpec

const sessionTargetSchema = objectSchema({
  sessionId: required(stringSchema),
  cwd: required(stringSchema),
  agentPreset: required(stringSchema),
})

const subscriptionSchema = objectSchema({
  target: required(sessionTargetSchema),
  delivery: required(deliverySchema),
  conditions: required(triggerConditionsValueSchema),
})

const attentionSchema = objectSchema({
  primary: required(sessionTargetSchema),
  primaryDelivery: required(deliverySchema),
  primaryConditions: required(triggerConditionsValueSchema),
  subscriptions: required({ type: 'array', items: subscriptionSchema }),
})

const observationSchema = objectSchema({
  queueItemId: required(stringSchema),
  state: required(stateSchema),
  observedAt: required(stringSchema),
  evidence: required(stringSchema),
  elapsedSeconds: numberSchema,
  expectedRemainingSeconds: numberSchema,
  recommendedCheckAfterSeconds: integerSchema,
  recommendationReason: stringSchema,
  walltimeSeconds: numberSchema,
  walltimeRemainingSeconds: numberSchema,
  startedAt: stringSchema,
  phase: stringSchema,
  source: { type: 'string', enum: ['code', 'agent-fallback', 'webhook'] },
  attention: objectSchema({ code: required(stringSchema), message: required(stringSchema) }),
})

const itemSchema = objectSchema({
  id: required(stringSchema),
  label: required(stringSchema),
  purpose: { type: 'string', enum: ['monitor', 'continue'] },
  continuation: stringSchema,
  verificationPending: { type: 'boolean' },
  notes: stringSchema,
  tags: required({ type: 'array', items: stringSchema }),
  target: required(queueTargetValueSchema),
  observer: required(queueObserverValueSchema),
  state: required(stateSchema),
  monitoring: required(monitoringHintsValueSchema),
  attention: required(attentionSchema),
  revision: required(integerSchema),
  createdAt: required(stringSchema),
  updatedAt: required(stringSchema),
  nextCheckAt: stringSchema,
  consecutiveUnchangedChecks: required(integerSchema),
  consecutiveFailures: required(integerSchema),
  lastCheckError: objectSchema({
    at: required(stringSchema),
    message: required(stringSchema),
  }),
  lastObservation: observationSchema,
  startedAt: stringSchema,
  runningObservedAt: stringSchema,
  walltimeSeconds: numberSchema,
  phase: stringSchema,
  callback: objectSchema({ runId: required(stringSchema), attempt: required(integerSchema), sequence: required(integerSchema), terminalPending: required({ type: 'boolean' }) }),
})

const runSchema = objectSchema({
  batches: required(integerSchema),
  observed: required(integerSchema),
  missing: required(integerSchema),
  contractFailures: required(integerSchema),
  deliveries: required(integerSchema),
})

const boundsSchema = objectSchema({
  schemaVersion: required({ type: 'integer', const: 1 }),
  ok: required({ type: 'boolean', const: false }),
  error: required(objectSchema({
    code: required({ type: 'string', const: 'BOUNDS' }),
    message: required(stringSchema),
    retryable: required({ type: 'boolean', const: true }),
  })),
})

const queueTrackSuccessSchema = objectSchema({
  schemaVersion: required({ type: 'integer', const: 1 }),
  ok: required({ type: 'boolean', const: true }),
  value: required(itemSchema),
})
export const queueListItemSchema = objectSchema({
  id: required(stringSchema),
  label: required(stringSchema),
  target: required(queueTargetValueSchema),
  observer: required({ oneOf: [
    objectSchema({ kind: required({ type: 'string', const: 'slurm' }), jobId: required(stringSchema) }),
    objectSchema({ kind: required({ type: 'string', const: 'pbs' }), jobId: required(stringSchema) }),
    objectSchema({ kind: required({ type: 'string', const: 'process' }), pid: required(integerSchema) }),
  ] }),
  state: required(stateSchema),
  purpose: itemSchema.properties.purpose,
  verificationPending: { type: 'boolean' },
  createdAt: required(stringSchema),
  updatedAt: required(stringSchema),
  nextCheckAt: stringSchema,
  phase: stringSchema,
  lastObservation: objectSchema({
    state: required(stateSchema),
    observedAt: required(stringSchema),
    source: observationSchema.properties.source,
    elapsedSeconds: numberSchema,
    walltimeSeconds: numberSchema,
    walltimeRemainingSeconds: numberSchema,
    attention: observationSchema.properties.attention,
  }),
  lastCheckError: itemSchema.properties.lastCheckError,
  textTruncated: { type: 'boolean' },
})

export const queueListSuccessSchema = objectSchema({
  schemaVersion: required({ type: 'integer', const: 1 }),
  ok: required({ type: 'boolean', const: true }),
  value: required({ type: 'array', items: queueListItemSchema }),
  page: required(objectSchema({
    total: required(integerSchema),
    offset: required(integerSchema),
    hasMore: required({ type: 'boolean' }),
    nextOffset: integerSchema,
    stateCounts: required(objectSchema({
      queued: required(integerSchema),
      running: required(integerSchema),
      completed: required(integerSchema),
      failed: required(integerSchema),
      cancelled: required(integerSchema),
      unknown: required(integerSchema),
    })),
  })),
})
const queueGetSuccessSchema = objectSchema({
  schemaVersion: required({ type: 'integer', const: 1 }),
  ok: required({ type: 'boolean', const: true }),
  value: required(objectSchema({
    item: required(itemSchema),
    observations: required({ type: 'array', items: observationSchema }),
  })),
})
const queueUpdateSuccessSchema = objectSchema({
  schemaVersion: required({ type: 'integer', const: 1 }),
  ok: required({ type: 'boolean', const: true }),
  value: required(objectSchema({
    item: required(itemSchema),
    run: runSchema,
    observations: required({ type: 'array', items: observationSchema }),
  })),
})

export const queueTrackOutputSchema = { oneOf: [queueTrackSuccessSchema, boundsSchema] } satisfies ValueSchemaSpec
export const queueListOutputSchema = { oneOf: [queueListSuccessSchema, boundsSchema] } satisfies ValueSchemaSpec
export const queueGetOutputSchema = { oneOf: [queueGetSuccessSchema, boundsSchema] } satisfies ValueSchemaSpec
export const queueUpdateOutputSchema = { oneOf: [queueUpdateSuccessSchema, boundsSchema] } satisfies ValueSchemaSpec

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('Queue result is not lossless JSON')
    return value
  }
  if (Array.isArray(value)) return value.map(item => toJsonValue(item))
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toJsonValue(item)
    }
    return result
  }
  throw new Error('Queue result is not lossless JSON')
}

function boundsResult(): InferValue<typeof boundsSchema> {
  return {
    schemaVersion: 1,
    ok: false,
    error: {
      code: 'BOUNDS',
      message: 'The Queue result exceeds 256 KiB. Narrow the filters or observation limit.',
      retryable: true,
    },
  }
}

export function canonicalQueueOutput<const Schema extends ValueSchemaSpec>(
  schema: Schema,
  value: unknown,
): InferValue<Schema> {
  const parsed = toJsonValue(value)
  const bounded = Buffer.byteLength(JSON.stringify(parsed), 'utf8') <= MAX_QUEUE_TOOL_BYTES
    ? parsed
    : boundsResult()
  const violations = validateJsonSchemaValue(valueSchemaSpecToJsonSchema(schema), bounded)
  if (violations.length > 0) throw new Error(`Queue tool produced an invalid result: ${violations.join('; ')}`)
  return bounded as InferValue<Schema>
}

export function queueJsonOutput<const Schema extends ValueSchemaSpec>(schema: Schema): {
  readonly schema: Schema
  readonly render: (args: unknown, value: InferValue<Schema>) => { readonly type: 'text'; readonly text: string }[]
} {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}
