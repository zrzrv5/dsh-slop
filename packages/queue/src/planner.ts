import {
  targetKey,
  type ObserverKind,
  type QueueItem,
  type QueueItemId,
  type QueueObservation,
  type QueueTarget,
  workerObservationBatchSchema,
} from './types.ts'

export interface QueueBatchPlan {
  readonly target: QueueTarget
  readonly observerKind: ObserverKind
  readonly items: readonly QueueItem[]
}

export interface BatchPlannerOptions {
  readonly earlyPiggybackWindowSeconds: number
  readonly maximumEarlyFraction: number
}

export const DEFAULT_BATCH_PLANNER_OPTIONS: BatchPlannerOptions = {
  earlyPiggybackWindowSeconds: 60,
  maximumEarlyFraction: 0.25,
}

function groupingKey(item: QueueItem): string {
  return [targetKey(item.target), item.observer.kind].join('\u0000')
}

function referenceIntervalSeconds(item: QueueItem): number {
  return item.monitoring.userIntervalSeconds
    ?? item.monitoring.preferredIntervalSeconds
    ?? 60
}

function canPiggyback(item: QueueItem, nowMs: number, options: BatchPlannerOptions): boolean {
  if (item.nextCheckAt === undefined) return false
  const earlyBySeconds = (Date.parse(item.nextCheckAt) - nowMs) / 1_000
  if (earlyBySeconds <= 0) return true
  const boundedWindow = Math.min(
    options.earlyPiggybackWindowSeconds,
    referenceIntervalSeconds(item) * options.maximumEarlyFraction,
  )
  return earlyBySeconds <= boundedWindow
}

/** Groups immediate work without postponing an overdue item to wait for its peers. */
export function planQueueBatches(
  candidates: readonly QueueItem[],
  now: Date,
  options: BatchPlannerOptions = DEFAULT_BATCH_PLANNER_OPTIONS,
): readonly QueueBatchPlan[] {
  if (!Number.isFinite(options.earlyPiggybackWindowSeconds) || options.earlyPiggybackWindowSeconds < 0) {
    throw new Error('earlyPiggybackWindowSeconds must be nonnegative')
  }
  if (!Number.isFinite(options.maximumEarlyFraction) || options.maximumEarlyFraction < 0 || options.maximumEarlyFraction > 1) {
    throw new Error('maximumEarlyFraction must be between zero and one')
  }
  const nowMs = now.getTime()
  const grouped = new Map<string, QueueItem[]>()
  for (const item of candidates) {
    if (item.nextCheckAt === undefined || !canPiggyback(item, nowMs, options)) continue
    const key = groupingKey(item)
    const group = grouped.get(key)
    if (group === undefined) grouped.set(key, [item])
    else group.push(item)
  }
  const plans: QueueBatchPlan[] = []
  for (const items of grouped.values()) {
    if (!items.some((item) => item.nextCheckAt !== undefined && Date.parse(item.nextCheckAt) <= nowMs)) continue
    items.sort((left, right) => {
      const leftTime = left.nextCheckAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.nextCheckAt)
      const rightTime = right.nextCheckAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.nextCheckAt)
      return leftTime - rightTime || left.id.localeCompare(right.id)
    })
    const first = items[0]
    if (first === undefined) continue
    plans.push({ target: first.target, observerKind: first.observer.kind, items })
  }
  plans.sort((left, right) => {
    const leftAt = left.items[0]?.nextCheckAt
    const rightAt = right.items[0]?.nextCheckAt
    return Date.parse(leftAt ?? '9999-12-31T23:59:59.999Z') - Date.parse(rightAt ?? '9999-12-31T23:59:59.999Z')
  })
  return plans
}

export interface ValidatedObservationBatch {
  readonly observations: ReadonlyMap<QueueItemId, QueueObservation>
  readonly missing: readonly QueueItemId[]
}

export class QueueWorkerContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueueWorkerContractError'
  }
}

/** Rejects fabricated and duplicate IDs while isolating omissions to the missing items. */
export function validateObservationBatch(
  value: unknown,
  requestedIds: readonly QueueItemId[],
): ValidatedObservationBatch {
  const parsed = workerObservationBatchSchema.safeParse(value)
  if (!parsed.success) throw new QueueWorkerContractError(`query worker returned invalid observations: ${parsed.error.message}`)
  const requested = new Set(requestedIds)
  const observations = new Map<QueueItemId, QueueObservation>()
  for (const observation of parsed.data.observations) {
    if (!requested.has(observation.queueItemId)) {
      throw new QueueWorkerContractError(`query worker returned unrequested queue item '${observation.queueItemId}'`)
    }
    if (observations.has(observation.queueItemId)) {
      throw new QueueWorkerContractError(`query worker returned queue item '${observation.queueItemId}' more than once`)
    }
    observations.set(observation.queueItemId, observation)
  }
  return {
    observations,
    missing: requestedIds.filter((id) => !observations.has(id)),
  }
}
