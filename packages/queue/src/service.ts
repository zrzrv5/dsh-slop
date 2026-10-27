import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { queueCallbackEventSchema, type QueueCallbackEvent } from './callback.ts'
import { planQueueBatches, validateObservationBatch, type BatchPlannerOptions, type QueueBatchPlan } from './planner.ts'
import { buildQueueQueryPrompt } from './prompt.ts'
import { initialNextCheckAt, nextCheckAfterFailure, nextCheckAfterObservation } from './scheduling.ts'
import { QueueRevisionConflictError, type DeliveryResultUpdate, type QueueStore } from './store.ts'
import {
  queuePurposeSchema,
  trackingPolicy,
  ECONOMY_QUEUE_SETTINGS,
  NORMAL_QUEUE_SETTINGS,
  defaultQueueSettings,
  deliveryModeSchema,
  deliveryRecordSchema,
  isTerminalState,
  monitoringHintsSchema,
  observerKindSchema,
  queueAttentionSchema,
  queueItemIdSchema,
  queueItemSchema,
  queueObserverSchema,
  queueProbeBatchSchema,
  queueSettingsProfileSchema,
  queueSettingsSchema,
  queueSessionTargetSchema,
  queueStateSchema,
  queueSubscriptionSchema,
  queueTargetSchema,
  sessionIdSchema,
  targetKey,
  triggerConditionSchema,
  type DeliveryMode,
  type DeliveryRecord,
  type DeliveryTrigger,
  type QueueChatDeliveryPort,
  type QueueClockPort,
  type QueueItem,
  type QueueItemId,
  type QueueItemPatch,
  type QueueListFilter,
  type QueueObservation,
  type QueueProbePort,
  type QueueQueryRequest,
  type QueueQueryWorkerPort,
  type QueueSettings,
  type QueueSettingsPatch,
  type QueueSessionTarget,
  type QueueSubscription,
  type QueueSubscriptionContext,
  type QueueSubscriptionInput,
  type QueueTrackContext,
  type QueueTrackInput,
  type TriggerCondition,
} from './types.ts'

const trackInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(1_024),
  notes: z.string().max(32_768).optional(),
  tags: z.array(z.string().min(1).max(128)).max(128).optional(),
  target: queueTargetSchema,
  observer: queueObserverSchema,
  initialState: queueStateSchema.optional(),
  monitoring: monitoringHintsSchema.optional(),
  purpose: queuePurposeSchema,
  continuation: z.string().trim().min(1).max(4_096).optional(),
}).strict()

const subscriptionInputSchema = z.object({
  delivery: deliveryModeSchema,
  conditions: z.array(triggerConditionSchema).min(1).max(7),
}).strict()

const itemPatchSchema = z.object({
  purpose: queuePurposeSchema.optional(),
  continuation: z.string().trim().min(1).max(4_096).optional(),
  label: z.string().min(1).max(1_024).optional(),
  notes: z.string().max(32_768).nullable().optional(),
  tags: z.array(z.string().min(1).max(128)).max(128).optional(),
  monitoring: monitoringHintsSchema.optional(),
  nextCheckAt: z.iso.datetime({ offset: true }).nullable().optional(),
  primaryDelivery: deliveryModeSchema.optional(),
  primaryConditions: z.array(triggerConditionSchema).min(1).max(7).optional(),
}).strict()

const settingsPatchSchema = z.object({
  profile: queueSettingsProfileSchema.optional(),
  initialCheckSeconds: z.number().int().min(60).optional(),
  automaticMinimumSeconds: z.number().int().min(60).optional(),
  stableMinimumSeconds: z.number().int().min(60).optional(),
  startupWindowSeconds: z.number().int().min(60).optional(),
  startupIntervalSeconds: z.number().int().min(60).optional(),
  walltimeDivisor: z.number().int().min(1).max(100).optional(),
  durationMaximumSeconds: z.number().int().min(60).optional(),
  maximumDetectionDelaySeconds: z.number().int().min(60).optional(),
  queuedMaximumSeconds: z.number().int().min(60).optional(),
  fallbackEnabled: z.boolean().optional(),
  defaultDelivery: deliveryModeSchema.optional(),
  defaultConditions: z.array(triggerConditionSchema).min(1).max(7).optional(),
}).strict()

export interface QueueServiceOptions {
  readonly store: QueueStore
  readonly probe?: QueueProbePort
  readonly queryWorker?: QueueQueryWorkerPort
  readonly chatDelivery: QueueChatDeliveryPort
  readonly clock?: QueueClockPort
  readonly batchPlanner?: Partial<BatchPlannerOptions>
  readonly deliveryRetry?: {
    readonly baseSeconds?: number
    readonly maximumSeconds?: number
  }
}

export interface QueueRunResult {
  readonly batches: number
  readonly observed: number
  readonly missing: number
  readonly contractFailures: number
  readonly deliveries: number
}

interface BatchRunResult {
  readonly observed: number
  readonly missing: number
  readonly contractFailures: number
}

export class QueueItemNotFoundError extends Error {
  constructor(readonly queueItemId: QueueItemId) {
    super(`queue item '${queueItemId}' does not exist`)
    this.name = 'QueueItemNotFoundError'
  }
}

const systemClock: QueueClockPort = { now: () => new Date() }

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function uniqueConditions(values: readonly TriggerCondition[]): TriggerCondition[] {
  return [...new Set(values)]
}

function normalizeSubscription(input: QueueSubscriptionInput, target: QueueSessionTarget): QueueSubscription {
  const parsed = subscriptionInputSchema.parse(input)
  return queueSubscriptionSchema.parse({
    target,
    delivery: parsed.delivery,
    conditions: uniqueConditions(parsed.conditions),
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 8_192)
  return String(error).slice(0, 8_192)
}

/** Queue orchestration. It owns no shell, model, subagent, or chat runtime. */
export class QueueService {
  private readonly clock: QueueClockPort
  private readonly batchPlanner: BatchPlannerOptions
  private readonly deliveryRetryBaseSeconds: number
  private readonly deliveryRetryMaximumSeconds: number
  private activeRun: Promise<QueueRunResult> | undefined
  private readonly manualChecks = new Map<string, Promise<QueueItem>>()
  private closed = false
  private activeDeliveryFlush: Promise<number> | undefined

  constructor(private readonly options: QueueServiceOptions) {
    this.clock = options.clock ?? systemClock
    this.batchPlanner = {
      earlyPiggybackWindowSeconds: options.batchPlanner?.earlyPiggybackWindowSeconds ?? 60,
      maximumEarlyFraction: options.batchPlanner?.maximumEarlyFraction ?? 0.25,
    }
    this.deliveryRetryBaseSeconds = options.deliveryRetry?.baseSeconds ?? 30
    this.deliveryRetryMaximumSeconds = options.deliveryRetry?.maximumSeconds ?? 3_600
    if (!Number.isFinite(this.deliveryRetryBaseSeconds) || this.deliveryRetryBaseSeconds <= 0) {
      throw new Error('delivery retry baseSeconds must be positive')
    }
    if (
      !Number.isFinite(this.deliveryRetryMaximumSeconds)
      || this.deliveryRetryMaximumSeconds < this.deliveryRetryBaseSeconds
    ) {
      throw new Error('delivery retry maximumSeconds must be at least baseSeconds')
    }
  }

  async initialize(): Promise<void> {
    await this.options.store.initialize()
    if (await this.options.store.getSettings() === undefined) {
      try {
        await this.options.store.insertSettings(defaultQueueSettings(this.clock.now()))
      } catch (error) {
        if (await this.options.store.getSettings() === undefined) throw error
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([this.activeRun, this.activeDeliveryFlush, ...this.manualChecks.values()])
    await this.options.store.close()
  }

  async track(input: QueueTrackInput, context: QueueTrackContext): Promise<QueueItem> {
    const result = trackInputSchema.safeParse(input)
    if (!result.success) throw new Error('Queue registration requires purpose monitor or continue; continue also requires continuation describing the authorized next step and result location. Correct only the registration parameters; do not resubmit the external job.', { cause: result.error })
    const parsed = result.data
    const policy = trackingPolicy({ purpose: parsed.purpose, ...(parsed.continuation === undefined ? {} : { continuation: parsed.continuation }) })
    const now = context.now ?? new Date()
    const createdAt = now.toISOString()
    const state = parsed.initialState ?? 'queued'
    const monitoring = monitoringHintsSchema.parse(parsed.monitoring ?? {})
    const settings = await this.settings()
    const nextCheckAt = policy.purpose === 'continue' && isTerminalState(state) ? now.toISOString() : initialNextCheckAt(now, state, monitoring, settings)
    const item = queueItemSchema.parse({
      id: queueItemIdSchema.parse(parsed.id ?? randomUUID()),
      label: parsed.label,
      purpose: policy.purpose,
      verificationPending: policy.purpose === 'continue' && isTerminalState(state),
      ...(policy.purpose === 'continue' ? { continuation: policy.continuation } : {}),
      ...(parsed.notes === undefined ? {} : { notes: parsed.notes }),
      tags: uniqueStrings(parsed.tags ?? []),
      target: parsed.target,
      observer: parsed.observer,
      state,
      monitoring,
      attention: queueAttentionSchema.parse({
        primary: queueSessionTargetSchema.parse(context.primary),
        primaryDelivery: policy.primaryDelivery,
        primaryConditions: policy.primaryConditions,
        subscriptions: [],
      }),
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
      consecutiveUnchangedChecks: 0,
      consecutiveFailures: 0,
    })
    await this.options.store.insertItem(item)
    return item
  }

  async get(id: string): Promise<QueueItem | undefined> {
    return await this.options.store.getItem(queueItemIdSchema.parse(id))
  }

  /** Reads the global ledger. The caller does not become a subscriber. */
  async list(filter: QueueListFilter = {}): Promise<readonly QueueItem[]> {
    const states = filter.states === undefined ? undefined : new Set(filter.states.map((state) => queueStateSchema.parse(state)))
    const observerKinds = filter.observerKinds === undefined
      ? undefined
      : new Set(filter.observerKinds.map((kind) => observerKindSchema.parse(kind)))
    const requestedTarget = filter.target === undefined ? undefined : queueTargetSchema.parse(filter.target)
    const tags = filter.tags === undefined ? undefined : uniqueStrings(filter.tags)
    const primary = filter.primarySessionId === undefined ? undefined : sessionIdSchema.parse(filter.primarySessionId)
    const subscribed = filter.subscribedSessionId === undefined ? undefined : sessionIdSchema.parse(filter.subscribedSessionId)
    return (await this.options.store.listItems()).filter((item) => {
      if (states !== undefined && !states.has(item.state)) return false
      if (observerKinds !== undefined && !observerKinds.has(item.observer.kind)) return false
      if (requestedTarget !== undefined && targetKey(requestedTarget) !== targetKey(item.target)) return false
      if (tags !== undefined && !tags.every((tag) => item.tags.includes(tag))) return false
      if (primary !== undefined && item.attention.primary.sessionId !== primary) return false
      if (subscribed !== undefined && !item.attention.subscriptions.some((entry) => entry.target.sessionId === subscribed)) return false
      return true
    })
  }

  async observations(id: string): Promise<readonly QueueObservation[]> {
    return await this.options.store.listObservations(queueItemIdSchema.parse(id))
  }

  /** Called only after the ingress adapter has authenticated and bound the execution. */
  async receiveCallback(id: string, input: QueueCallbackEvent): Promise<'accepted' | 'ignored'> {
    const event = queueCallbackEventSchema.parse(input)
    const now = this.clock.now()
    if (Date.parse(event.occurredAt) > now.getTime() + 300_000 || Date.parse(event.startedAt) > Date.parse(event.occurredAt)) throw new Error('Invalid callback event time')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const item = await this.requireItem(queueItemIdSchema.parse(id))
      const jobId = item.observer.kind === 'process' ? String(item.observer.handle.pid) : item.observer.jobId
      if (event.jobId !== jobId) throw new Error('Callback does not match the registered job')
      const cursor = item.callback
      if (cursor !== undefined && cursor.runId !== event.runId) throw new Error('Callback execution changed')
      if (cursor !== undefined && (event.attempt < cursor.attempt || (event.attempt === cursor.attempt && event.sequence <= cursor.sequence))) return 'ignored'
      const newAttempt = cursor !== undefined && event.attempt > cursor.attempt
      if (!newAttempt && isTerminalState(item.state) && (event.kind !== 'exited' || item.lastObservation?.source === 'code')) return 'ignored'
      if (!newAttempt && item.lastObservation?.source === 'code' && Date.parse(event.occurredAt) < Date.parse(item.lastObservation.observedAt)) return 'ignored'
      const observation: QueueObservation = {
        queueItemId: item.id,
        state: event.kind === 'exited' ? event.exitCode === 0 ? 'completed' : 'failed' : 'running',
        observedAt: now.toISOString(),
        startedAt: event.startedAt,
      elapsedSeconds: Math.max(0, Math.floor((Date.parse(event.occurredAt) - Date.parse(event.startedAt)) / 1_000)),
        evidence: JSON.stringify(event),
        source: 'webhook',
        ...(item.walltimeSeconds === undefined ? {} : { walltimeSeconds: item.walltimeSeconds }),
        ...(event.kind === 'phase' ? { phase: event.phase } : {}),
      }
      const withCursor: QueueItem = {
        ...item,
        ...(newAttempt ? { startedAt: event.startedAt, phase: undefined, runningObservedAt: now.toISOString() } : {}),
        callback: { runId: event.runId, attempt: event.attempt, sequence: event.sequence, terminalPending: event.kind === 'exited' },
      }
      if (await this.recordObservation(withCursor, observation, now, await this.settings())) return 'accepted'
    }
    throw new Error('Queue item changed while accepting callback; retry')
  }

  async settings(): Promise<QueueSettings> {
    const settings = await this.options.store.getSettings()
    if (settings === undefined) throw new Error('Queue settings are not initialized')
    return settings
  }

  async updateSettings(patch: QueueSettingsPatch, expectedRevision?: number, now = this.clock.now()): Promise<QueueSettings> {
    const parsed = settingsPatchSchema.parse(patch)
    const current = await this.settings()
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`Queue settings changed from revision ${String(expectedRevision)}`)
    }
    const profile = parsed.profile ?? current.profile
    const selectedPreset = parsed.profile === 'normal'
      ? NORMAL_QUEUE_SETTINGS
      : parsed.profile === 'economy'
        ? ECONOMY_QUEUE_SETTINGS
        : undefined
    const preset = selectedPreset === undefined ? {} : {
      initialCheckSeconds: selectedPreset.initialCheckSeconds,
      automaticMinimumSeconds: selectedPreset.automaticMinimumSeconds,
      stableMinimumSeconds: selectedPreset.stableMinimumSeconds,
      startupWindowSeconds: selectedPreset.startupWindowSeconds,
      startupIntervalSeconds: selectedPreset.startupIntervalSeconds,
      walltimeDivisor: selectedPreset.walltimeDivisor,
      durationMaximumSeconds: selectedPreset.durationMaximumSeconds,
      maximumDetectionDelaySeconds: selectedPreset.maximumDetectionDelaySeconds,
      queuedMaximumSeconds: selectedPreset.queuedMaximumSeconds,
    }
    const next = queueSettingsSchema.parse({
      ...current,
      ...preset,
      ...parsed,
      profile,
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    })
    const result = await this.options.store.replaceSettings(next, current.revision)
    if (result === 'revision-conflict') throw new Error(`Queue settings changed from revision ${String(current.revision)}`)
    await this.rescheduleInheritedItems(next, now)
    return next
  }

  async update(id: string, patch: QueueItemPatch, expectedRevision?: number, now = new Date()): Promise<QueueItem> {
    const queueItemId = queueItemIdSchema.parse(id)
    const current = await this.requireItem(queueItemId)
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new QueueRevisionConflictError(queueItemId, expectedRevision)
    }
    const parsed = itemPatchSchema.parse(patch)
    const purpose = parsed.purpose ?? current.purpose
    const continuation = parsed.continuation ?? current.continuation
    const policy = purpose === undefined ? undefined : trackingPolicy({ purpose, ...(purpose === 'continue' ? { continuation } : {}) })
    if (policy !== undefined && (parsed.primaryDelivery !== undefined || parsed.primaryConditions !== undefined)) throw new Error('Change purpose and continuation instead of primary delivery for this Queue item.')
    const notes = parsed.notes === undefined ? current.notes : parsed.notes ?? undefined
    let nextCheckAt = parsed.nextCheckAt === undefined ? current.nextCheckAt : parsed.nextCheckAt ?? undefined
    if (parsed.monitoring !== undefined && parsed.nextCheckAt === undefined && !isTerminalState(current.state)) {
      const schedulingItem = queueItemSchema.parse({ ...current, monitoring: parsed.monitoring })
      const settings = await this.settings()
      nextCheckAt = current.lastObservation === undefined
        ? initialNextCheckAt(now, current.state, parsed.monitoring, settings)
        : nextCheckAfterObservation(schedulingItem, current.lastObservation, now, settings)
    }
    const needsVerification = policy?.purpose === 'continue' && current.purpose !== 'continue' && isTerminalState(current.state)
    if (needsVerification) nextCheckAt = now.toISOString()
    const next = queueItemSchema.parse({
      ...current,
      ...(needsVerification ? { verificationPending: true } : {}),
      ...(policy === undefined ? {} : { purpose: policy.purpose, continuation: policy.purpose === 'continue' ? policy.continuation : undefined }),
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
      ...(notes === undefined ? { notes: undefined } : { notes }),
      ...(parsed.tags === undefined ? {} : { tags: uniqueStrings(parsed.tags) }),
      ...(parsed.monitoring === undefined ? {} : { monitoring: parsed.monitoring }),
      ...(nextCheckAt === undefined ? { nextCheckAt: undefined } : { nextCheckAt }),
      attention: {
        ...current.attention,
        primaryDelivery: policy?.primaryDelivery ?? parsed.primaryDelivery ?? current.attention.primaryDelivery,
        primaryConditions: policy?.primaryConditions ?? (parsed.primaryConditions === undefined
          ? current.attention.primaryConditions
          : uniqueConditions(parsed.primaryConditions)),
        subscriptions: current.attention.subscriptions,
      },
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    })
    const result = await this.options.store.replaceItem(next, current.revision)
    if (result === 'revision-conflict') throw new QueueRevisionConflictError(queueItemId, current.revision)
    return next
  }

  async subscribe(id: string, input: QueueSubscriptionInput, context: QueueSubscriptionContext): Promise<QueueItem> {
    const queueItemId = queueItemIdSchema.parse(id)
    const current = await this.requireItem(queueItemId)
    const target = queueSessionTargetSchema.parse(context.current)
    const subscription = normalizeSubscription(input, target)
    if (subscription.target.sessionId === current.attention.primary.sessionId) {
      return await this.update(id, {
        primaryDelivery: subscription.delivery,
        primaryConditions: subscription.conditions,
      }, current.revision, context.now ?? new Date())
    }
    const subscriptions = [
      ...current.attention.subscriptions.filter((entry) => entry.target.sessionId !== subscription.target.sessionId),
      subscription,
    ]
    return await this.replaceSubscriptions(current, subscriptions, context.now ?? new Date())
  }

  async unsubscribe(id: string, context: QueueSubscriptionContext): Promise<QueueItem> {
    const queueItemId = queueItemIdSchema.parse(id)
    const target = queueSessionTargetSchema.parse(context.current)
    const current = await this.requireItem(queueItemId)
    if (target.sessionId === current.attention.primary.sessionId) throw new Error('the primary session cannot unsubscribe from ownership')
    return await this.replaceSubscriptions(
      current,
      current.attention.subscriptions.filter((entry) => entry.target.sessionId !== target.sessionId),
      context.now ?? new Date(),
    )
  }

  /** An explicit UI refresh probes only this item, without fallback Agents or wake delivery. */
  async probeNow(id: string): Promise<QueueItem> {
    const existing = this.manualChecks.get(id)
    if (existing !== undefined) return await existing
    const checking = this.executeManualCheck(id)
    this.manualChecks.set(id, checking)
    try {
      return await checking
    } finally {
      if (this.manualChecks.get(id) === checking) this.manualChecks.delete(id)
    }
  }

  private async executeManualCheck(id: string): Promise<QueueItem> {
    if (this.options.probe === undefined) throw new Error('Deterministic Queue probing is unavailable')
    while (this.activeRun !== undefined) await this.activeRun.catch(() => {})
    const running = (async (): Promise<QueueRunResult> => {
      const item = await this.requireItem(queueItemIdSchema.parse(id))
      const settings = { ...await this.settings(), fallbackEnabled: false }
      const result = await this.runBatch({ target: item.target, observerKind: item.observer.kind, items: [item] }, settings, true)
      return { ...result, batches: 1, deliveries: 0 }
    })()
    this.activeRun = running
    try {
      await running
    } finally {
      if (this.activeRun === running) this.activeRun = undefined
    }
    return await this.requireItem(queueItemIdSchema.parse(id))
  }

  async runDue(now = new Date()): Promise<QueueRunResult> {
    if (this.activeRun !== undefined) return await this.activeRun
    const running = this.executeDue(now)
    this.activeRun = running
    try {
      return await running
    } finally {
      if (this.activeRun === running) this.activeRun = undefined
    }
  }

  checkpointShutdown(pending: readonly { dispatchId: string; messageId: string }[]): void {
    if (!this.closed) this.options.store.checkpointShutdown(pending)
  }

  async flushPendingDeliveries(now = new Date()): Promise<number> {
    if (this.activeDeliveryFlush !== undefined) return await this.activeDeliveryFlush
    const running = this.executePendingDeliveries(now)
    this.activeDeliveryFlush = running
    try {
      return await running
    } finally {
      if (this.activeDeliveryFlush === running) this.activeDeliveryFlush = undefined
    }
  }

  private async executePendingDeliveries(now: Date): Promise<number> {
    if (this.closed) return 0
    const pending = await this.options.store.listPendingDeliveries(now.toISOString())
    const bySession = new Map<string, { target: QueueSessionTarget; records: DeliveryRecord[] }>()
    for (const record of pending) {
      const key = record.dispatchId ?? record.target.sessionId
      const group = bySession.get(key)
      if (group === undefined) bySession.set(key, { target: record.target, records: [record] })
      else group.records.push(record)
    }
    let delivered = 0
    for (const { target, records } of bySession.values()) {
      if (this.closed) break
      const delivery: DeliveryMode = records.some((record) => record.delivery === 'wake') ? 'wake' : 'notify'
      const triggers = records.map((record) => record.trigger)
      try {
        const dispatchId = records[0]?.dispatchId ?? randomUUID()
        await this.options.store.prepareDelivery(records, dispatchId)
        const receipt = await this.options.chatDelivery.deliver({ target, delivery, triggers, dispatchId, ...(records[0]?.shutdownMessageId === undefined ? {} : { shutdownMessageId: records[0].shutdownMessageId }) })
        if (receipt?.state === 'enqueued') {
          await this.options.store.markDeliveries(records.map(record => ({ kind: 'waiting', target: record.target, triggerKey: record.trigger.triggerKey, at: now.toISOString(), nextAttemptAt: new Date(now.getTime() + 30_000).toISOString() })))
          continue
        }
        const receiptState = receipt?.state
        const deliveredAt = now.toISOString()
        const updates: DeliveryResultUpdate[] = records.map((record) => ({
          kind: 'delivered',
          ...(receiptState === undefined ? {} : { receipt: receiptState }),
          target: record.target,
          triggerKey: record.trigger.triggerKey,
          deliveredAt,
        }))
        await this.options.store.markDeliveries(updates)
        delivered += records.length
      } catch (error) {
        const message = errorMessage(error)
        const updates: DeliveryResultUpdate[] = records.map((record) => ({
          kind: 'retry',
          target: record.target,
          triggerKey: record.trigger.triggerKey,
          attemptedAt: now.toISOString(),
          error: message,
          nextAttemptAt: this.deliveryRetryAt(record, now),
        }))
        await this.options.store.markDeliveries(updates)
      }
    }
    return delivered
  }

  async deliveries(id: string): Promise<readonly DeliveryRecord[]> { return this.options.store.listDeliveries(queueItemIdSchema.parse(id)) }

  async earliestNextCheckAt(): Promise<string | undefined> {
    return await this.options.store.earliestNextCheckAt()
  }

  async earliestWorkAt(): Promise<string | undefined> {
    const [check, delivery] = await Promise.all([
      this.options.store.earliestNextCheckAt(),
      this.options.store.earliestPendingDeliveryAt(),
    ])
    if (check === undefined) return delivery
    if (delivery === undefined) return check
    return Date.parse(check) <= Date.parse(delivery) ? check : delivery
  }

  private async executeDue(now: Date): Promise<QueueRunResult> {
    const settings = await this.settings()
    const cutoff = new Date(now.getTime() + this.batchPlanner.earlyPiggybackWindowSeconds * 1_000).toISOString()
    const candidates = await this.options.store.listDue(cutoff)
    const batches = planQueueBatches(candidates, now, this.batchPlanner)
    const results = await Promise.all(batches.map(async (batch) => await this.runBatch(batch, settings)))
    const deliveries = await this.flushPendingDeliveries(this.clock.now())
    return {
      batches: batches.length,
      observed: results.reduce((sum, result) => sum + result.observed, 0),
      missing: results.reduce((sum, result) => sum + result.missing, 0),
      contractFailures: results.reduce((sum, result) => sum + result.contractFailures, 0),
      deliveries,
    }
  }

  private async runBatch(batch: QueueBatchPlan, settings: QueueSettings, passive = false): Promise<BatchRunResult> {
    if (this.options.probe === undefined) {
      return await this.runFallbackItems(batch.items, batch, settings)
    }
    const probeRequest = {
      batchId: randomUUID(),
      target: batch.target,
      observerKind: batch.observerKind,
      items: batch.items.map((item) => ({
        id: item.id,
        label: item.label,
        ...(item.notes === undefined ? {} : { notes: item.notes }),
        state: item.state,
        observer: item.observer,
        createdAt: item.createdAt,
        ...(item.lastObservation === undefined ? {} : { lastObservation: item.lastObservation }),
      })),
    }
    let raw: unknown
    try {
      raw = await this.options.probe.probe(probeRequest)
    } catch (error) {
      await Promise.all(batch.items.map(async (item) => await this.recordFailure(item, this.clock.now(), errorMessage(error), settings)))
      return { observed: 0, missing: batch.items.length, contractFailures: batch.items.length }
    }
    const parsedProbe = queueProbeBatchSchema.safeParse(raw)
    if (!parsedProbe.success) {
      const message = `Queue probe returned invalid output: ${parsedProbe.error.message}`
      await Promise.all(batch.items.map(async (item) => await this.recordFailure(item, this.clock.now(), message, settings)))
      return { observed: 0, missing: batch.items.length, contractFailures: batch.items.length }
    }
    const requestedIds = new Set(batch.items.map((item) => item.id))
    const issueIds = new Set<QueueItemId>()
    const invalidIssue = parsedProbe.data.issues.find((issue) => {
      if (!requestedIds.has(issue.queueItemId) || issueIds.has(issue.queueItemId)) return true
      issueIds.add(issue.queueItemId)
      return false
    })
    const observationIds = new Set(parsedProbe.data.observations.map((observation) => observation.queueItemId))
    if (invalidIssue !== undefined || [...issueIds].some((id) => observationIds.has(id))) {
      const message = invalidIssue === undefined
        ? 'Queue probe returned both an observation and an issue for one item'
        : 'Queue probe returned a duplicate or unrequested issue'
      await Promise.all(batch.items.map(async (item) => await this.recordFailure(item, this.clock.now(), message, settings)))
      return { observed: 0, missing: batch.items.length, contractFailures: batch.items.length }
    }
    let validated: ReturnType<typeof validateObservationBatch>
    try {
      validated = validateObservationBatch(
        { observations: parsedProbe.data.observations },
        batch.items.map((item) => item.id),
      )
    } catch (error) {
      await Promise.all(batch.items.map(async (item) => await this.recordFailure(item, this.clock.now(), errorMessage(error), settings)))
      return { observed: 0, missing: batch.items.length, contractFailures: batch.items.length }
    }
    let observed = 0
    let contractFailures = 0
    const handled = new Set<QueueItemId>()
    for (const item of batch.items) {
      const reported = validated.observations.get(item.id)
      if (reported === undefined) continue
      const observation: QueueObservation = { ...reported, source: 'code' }
      handled.add(item.id)
      if (item.lastObservation !== undefined && Date.parse(observation.observedAt) < Date.parse(item.lastObservation.observedAt)) {
        await this.recordFailure(item, this.clock.now(), 'Queue probe returned an observation older than the stored observation', settings)
        contractFailures += 1
        continue
      }
      if (await this.recordObservation(item, observation, this.clock.now(), settings, passive)) observed += 1
    }

    const issues = new Map(parsedProbe.data.issues.map((issue) => [issue.queueItemId, issue]))
    const fallbackItems: QueueItem[] = []
    for (const item of batch.items) {
      if (handled.has(item.id)) continue
      const issue = issues.get(item.id)
      if (issue?.kind === 'fallback' && settings.fallbackEnabled && this.options.queryWorker !== undefined) {
        fallbackItems.push(item)
        continue
      }
      const message = issue === undefined
        ? 'Queue probe omitted this queue item without a classified issue'
        : `${issue.code}: ${issue.message}`
      await this.recordFailure(item, this.clock.now(), message, settings, issue?.kind === 'action-required' ? 'action-required' : undefined)
      if (issue === undefined) contractFailures += 1
    }
    if (fallbackItems.length > 0) {
      const fallback = await this.runFallbackItems(fallbackItems, batch, settings)
      observed += fallback.observed
      contractFailures += fallback.contractFailures
      for (const item of fallbackItems) handled.add(item.id)
    }
    return { observed, missing: batch.items.length - observed, contractFailures }
  }

  private async runFallbackItems(
    items: readonly QueueItem[],
    batch: Pick<QueueBatchPlan, 'target' | 'observerKind'>,
    settings: QueueSettings,
  ): Promise<BatchRunResult> {
    if (this.options.queryWorker === undefined) {
      await Promise.all(items.map(async (item) => await this.recordFailure(item, this.clock.now(), 'No Queue fallback worker is configured', settings)))
      return { observed: 0, missing: items.length, contractFailures: items.length }
    }
    const groups = new Map<string, QueueItem[]>()
    for (const item of items) {
      const parent = item.attention.primary
      const key = [parent.sessionId, parent.cwd, parent.agentPreset].join('\u0000')
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [item])
      else group.push(item)
    }
    let observed = 0
    let missing = 0
    let contractFailures = 0
    for (const group of groups.values()) {
      const parent = group[0]?.attention.primary
      if (parent === undefined) continue
      const requestWithoutPrompt = {
        batchId: randomUUID(),
        parent,
        target: batch.target,
        observerKind: batch.observerKind,
        items: group.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.notes === undefined ? {} : { notes: item.notes }),
          state: item.state,
          observer: item.observer,
          createdAt: item.createdAt,
          ...(item.lastObservation === undefined ? {} : { lastObservation: item.lastObservation }),
        })),
      } satisfies Omit<QueueQueryRequest, 'prompt'>
      const request: QueueQueryRequest = { ...requestWithoutPrompt, prompt: buildQueueQueryPrompt(requestWithoutPrompt) }
      let raw: unknown
      try {
        raw = await this.options.queryWorker.query(request)
      } catch (error) {
        await Promise.all(group.map(async (item) => await this.recordFailure(item, this.clock.now(), errorMessage(error), settings)))
        missing += group.length
        contractFailures += group.length
        continue
      }
      let validated: ReturnType<typeof validateObservationBatch>
      try {
        validated = validateObservationBatch(raw, group.map((item) => item.id))
      } catch (error) {
        await Promise.all(group.map(async (item) => await this.recordFailure(item, this.clock.now(), errorMessage(error), settings)))
        missing += group.length
        contractFailures += group.length
        continue
      }
      for (const item of group) {
        const reported = validated.observations.get(item.id)
        if (reported === undefined) {
          await this.recordFailure(item, this.clock.now(), 'Queue fallback worker omitted this queue item', settings)
          missing += 1
          continue
        }
        const observation: QueueObservation = { ...reported, source: 'agent-fallback' }
        if (item.lastObservation !== undefined && Date.parse(observation.observedAt) < Date.parse(item.lastObservation.observedAt)) {
          await this.recordFailure(item, this.clock.now(), 'Queue fallback worker returned an older observation', settings)
          missing += 1
          contractFailures += 1
          continue
        }
        if (await this.recordObservation(item, observation, this.clock.now(), settings)) observed += 1
      }
    }
    return { observed, missing, contractFailures }
  }

  private async recordObservation(item: QueueItem, observation: QueueObservation, now: Date, settings: QueueSettings, _passive = false): Promise<boolean> {
    const changed = item.state !== observation.state
    const confirmed = (item.verificationPending === true || item.callback?.terminalPending === true) && observation.source === 'code' && isTerminalState(observation.state)
    const verificationPending = item.purpose === 'continue' && isTerminalState(observation.state) && observation.source !== 'code'
    const calculated = verificationPending ? new Date(now.getTime() + 60_000).toISOString() : nextCheckAfterObservation(item, observation, now, settings)
    const nextCheckAt = observation.source === 'webhook' && item.nextCheckAt !== undefined && calculated !== undefined && Date.parse(item.nextCheckAt) < Date.parse(calculated) ? item.nextCheckAt : calculated
    const { lastCheckError: _lastCheckError, ...withoutCheckError } = item
    const next = queueItemSchema.parse({
      ...withoutCheckError,
      state: observation.state,
      verificationPending,
      revision: item.revision + 1,
      updatedAt: now.toISOString(),
      ...(nextCheckAt === undefined ? { nextCheckAt: undefined } : { nextCheckAt }),
      consecutiveUnchangedChecks: changed ? 0 : item.consecutiveUnchangedChecks + 1,
      consecutiveFailures: observation.source === 'webhook' ? item.consecutiveFailures : 0,
      ...(observation.source === 'webhook' && item.lastCheckError !== undefined ? { lastCheckError: item.lastCheckError } : {}),
      lastObservation: observation,
      startedAt: observation.state === 'queued' ? undefined : observation.startedAt ?? item.startedAt,
      walltimeSeconds: observation.walltimeSeconds ?? item.walltimeSeconds,
      runningObservedAt: observation.state === 'queued' ? undefined : item.runningObservedAt ?? (observation.state === 'running' ? now.toISOString() : undefined),
      phase: observation.phase ?? item.phase,
      ...(item.callback === undefined ? {} : { callback: { ...item.callback, terminalPending: observation.source === 'code' ? false : item.callback.terminalPending } }),
    })
    const deliveries = [
      ...((changed || confirmed) ? this.deliveryRecords(item, observation, next.revision, now, confirmed) : []),
      ...(observation.attention !== undefined
        && (item.lastObservation?.attention?.code !== observation.attention.code
          || item.lastObservation.attention.message !== observation.attention.message)
        ? this.operationalDeliveryRecords(item, 'action-required', observation.attention.message, next.revision, now)
        : []),
      ...(item.consecutiveFailures >= 3 && observation.source !== 'webhook'
        ? this.operationalDeliveryRecords(item, 'monitor-recovered', 'Deterministic Queue monitoring recovered.', next.revision, now)
        : []),
    ]
    const result = await this.options.store.commitObservation({
      expectedRevision: item.revision,
      item: next,
      observation,
      deliveries,
    })
    return result === 'updated'
  }

  private async recordFailure(
    item: QueueItem,
    now: Date,
    message: string,
    settings: QueueSettings,
    event?: 'action-required',
  ): Promise<void> {
    const nextCheckAt = isTerminalState(item.state) && !item.callback?.terminalPending && !item.verificationPending
      ? undefined
      : nextCheckAfterFailure(item, now, settings)
    const next = queueItemSchema.parse({
      ...item,
      revision: item.revision + 1,
      updatedAt: now.toISOString(),
      ...(nextCheckAt === undefined ? { nextCheckAt: undefined } : { nextCheckAt }),
      consecutiveFailures: item.consecutiveFailures + 1,
      lastCheckError: { at: now.toISOString(), message: message.slice(0, 8_192) },
    })
    const failures = item.consecutiveFailures + 1
    const alertEvent = event !== undefined && item.lastCheckError?.message !== message
      ? event
      : failures === 3
        ? 'monitor-degraded'
        : undefined
    const deliveries = alertEvent === undefined
      ? []
      : this.operationalDeliveryRecords(item, alertEvent, message, next.revision, now)
    await this.options.store.commitItemUpdate({ expectedRevision: item.revision, item: next, deliveries })
  }

  private deliveryRecords(item: QueueItem, observation: QueueObservation, revision: number, now: Date, confirmation = false): DeliveryRecord[] {
    const trigger: DeliveryTrigger = {
      triggerKey: `${item.id}:${String(revision)}:${observation.state}`,
      queueItemId: item.id,
      label: item.label,
      previousState: item.state,
      state: observation.state,
      observedAt: observation.observedAt,
      evidence: observation.evidence,
      event: 'state-change',
    }
    const recipients = new Map<string, { target: QueueSessionTarget; delivery: DeliveryMode }>()
    if (this.matches(item.attention.primaryConditions, observation.state)
      && (!confirmation || item.purpose === 'continue')
      && (item.purpose !== 'continue' || observation.source === 'code')) {
      recipients.set(item.attention.primary.sessionId, {
        target: item.attention.primary,
        delivery: item.attention.primaryDelivery,
      })
    }
    for (const subscription of item.attention.subscriptions) {
      if (confirmation || !this.matches(subscription.conditions, observation.state)) continue
      const previous = recipients.get(subscription.target.sessionId)
      recipients.set(subscription.target.sessionId, {
        target: subscription.target,
        delivery: previous?.delivery === 'wake' || subscription.delivery === 'wake' ? 'wake' : 'notify',
      })
    }
    return [...recipients.values()].map(({ target, delivery }) => deliveryRecordSchema.parse({
      target,
      trigger,
      delivery,
      state: 'pending',
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }))
  }

  private operationalDeliveryRecords(
    item: QueueItem,
    event: 'monitor-degraded' | 'monitor-recovered' | 'action-required',
    evidence: string,
    revision: number,
    now: Date,
  ): DeliveryRecord[] {
    const trigger: DeliveryTrigger = {
      triggerKey: `${item.id}:${String(revision)}:${event}`,
      queueItemId: item.id,
      label: item.label,
      previousState: item.state,
      state: item.state,
      observedAt: now.toISOString(),
      evidence: evidence.slice(0, 128_000),
      event,
    }
    return [deliveryRecordSchema.parse({
      target: item.attention.primary,
      trigger,
      delivery: 'notify',
      state: 'pending',
      attempts: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })]
  }

  private matches(conditions: readonly TriggerCondition[], state: QueueObservation['state']): boolean {
    return conditions.includes('any-state-change') || conditions.includes(state)
  }

  private async replaceSubscriptions(
    current: QueueItem,
    subscriptions: readonly QueueSubscription[],
    now: Date,
  ): Promise<QueueItem> {
    const next = queueItemSchema.parse({
      ...current,
      attention: { ...current.attention, subscriptions },
      revision: current.revision + 1,
      updatedAt: now.toISOString(),
    })
    const result = await this.options.store.replaceItem(next, current.revision)
    if (result === 'revision-conflict') throw new QueueRevisionConflictError(current.id, current.revision)
    return next
  }

  private deliveryRetryAt(record: DeliveryRecord, now: Date): string {
    const exponent = Math.min(record.attempts, 20)
    const seconds = Math.min(this.deliveryRetryMaximumSeconds, this.deliveryRetryBaseSeconds * 2 ** exponent)
    return new Date(now.getTime() + seconds * 1_000).toISOString()
  }

  private async rescheduleInheritedItems(settings: QueueSettings, now: Date): Promise<void> {
    const items = await this.options.store.listItems()
    for (const item of items) {
      if (item.monitoring.userIntervalSeconds !== undefined || isTerminalState(item.state)) continue
      const nextCheckAt = item.lastObservation === undefined
        ? initialNextCheckAt(now, item.state, item.monitoring, settings)
        : nextCheckAfterObservation(item, item.lastObservation, now, settings)
      const next = queueItemSchema.parse({
        ...item,
        revision: item.revision + 1,
        updatedAt: now.toISOString(),
        ...(nextCheckAt === undefined ? { nextCheckAt: undefined } : { nextCheckAt }),
      })
      await this.options.store.replaceItem(next, item.revision)
    }
  }

  private async requireItem(id: QueueItemId): Promise<QueueItem> {
    const item = await this.options.store.getItem(id)
    if (item === undefined) throw new QueueItemNotFoundError(id)
    return item
  }
}
