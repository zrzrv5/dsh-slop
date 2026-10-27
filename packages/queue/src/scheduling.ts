import {
  defaultQueueSettings,
  isTerminalState,
  type MonitoringHints,
  type QueueItem,
  type QueueObservation,
  type QueueSettings,
  type QueueState,
} from './types.ts'

const HARD_MINIMUM_SECONDS = 60
const DEFAULT_UNKNOWN_DURATION_SECONDS = 15 * 60
const QUEUED_INTERVALS_SECONDS = [120, 300, 900, 1_800, 3_600] as const
const FAILURE_INTERVALS_SECONDS = [120, 300, 900, 1_800] as const

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString()
}

function itemMaximum(hints: MonitoringHints, settings: QueueSettings): number {
  return Math.min(hints.maximumIntervalSeconds ?? Number.POSITIVE_INFINITY, settings.maximumDetectionDelaySeconds)
}

function clampSeconds(value: number, hints: MonitoringHints, settings: QueueSettings): number {
  return Math.max(HARD_MINIMUM_SECONDS, Math.min(itemMaximum(hints, settings), Math.round(value)))
}

function effectiveSettings(settings?: QueueSettings): QueueSettings {
  return settings ?? defaultQueueSettings(new Date(0))
}

/** A newly submitted item gets a deterministic check after one minute unless the user chose a later time. */
export function initialNextCheckAt(
  createdAt: Date,
  state: QueueState,
  hints: MonitoringHints,
  settingsInput?: QueueSettings,
): string | undefined {
  if (isTerminalState(state)) return undefined
  const settings = effectiveSettings(settingsInput)
  const seconds = hints.userIntervalSeconds
    ?? Math.max(settings.initialCheckSeconds, hints.earliestCheckAfterSeconds ?? 0)
  return addSeconds(createdAt, clampSeconds(seconds, hints, settings))
}

function timingBasisSeconds(item: QueueItem, observation: QueueObservation): number | undefined {
  const expected = item.monitoring.expectedDurationSeconds
  const walltime = observation.walltimeSeconds ?? item.walltimeSeconds
  if (expected !== undefined && walltime !== undefined) return Math.min(expected, walltime)
  return expected ?? walltime
}

function expectedRemainingSeconds(item: QueueItem, observation: QueueObservation): number | undefined {
  const basis = timingBasisSeconds(item, observation)
  if (basis === undefined) return observation.expectedRemainingSeconds ?? observation.walltimeRemainingSeconds
  const startedAt = observation.startedAt ?? item.startedAt
  const elapsed = observation.elapsedSeconds
    ?? (startedAt === undefined ? undefined : Math.max(0, (Date.parse(observation.observedAt) - Date.parse(startedAt)) / 1_000))
  if (elapsed === undefined) return observation.expectedRemainingSeconds ?? observation.walltimeRemainingSeconds
  return Math.min(observation.expectedRemainingSeconds ?? Number.POSITIVE_INFINITY, observation.walltimeRemainingSeconds ?? Number.POSITIVE_INFINITY, Math.max(0, basis - elapsed))
}

/** Submission age is never execution age. Unknown starts use a conservative observation window. */
export function runningAgeSeconds(item: QueueItem, observation: QueueObservation, now: Date): number {
  const startedAt = observation.startedAt ?? item.startedAt
  if (startedAt !== undefined) return Math.max(0, (now.getTime() - Date.parse(startedAt)) / 1_000)
  if (observation.elapsedSeconds !== undefined) return observation.elapsedSeconds + Math.max(0, (now.getTime() - Date.parse(observation.observedAt)) / 1_000)
  return item.runningObservedAt === undefined ? 0 : Math.max(0, (now.getTime() - Date.parse(item.runningObservedAt)) / 1_000)
}

function stableRunningSeconds(item: QueueItem, observation: QueueObservation, settings: QueueSettings): number {
  const basis = timingBasisSeconds(item, observation)
  const duration = basis === undefined
    ? Math.max(settings.stableMinimumSeconds, DEFAULT_UNKNOWN_DURATION_SECONDS)
    : Math.max(
        settings.stableMinimumSeconds,
        Math.min(basis / settings.walltimeDivisor, settings.durationMaximumSeconds),
      )
  const remaining = expectedRemainingSeconds(item, observation)
  const nearEnd = remaining === undefined
    ? duration
    : Math.max(settings.automaticMinimumSeconds, Math.min(remaining / 4, duration))
  return Math.min(duration, nearEnd, settings.maximumDetectionDelaySeconds)
}

/** Computes the state-aware cadence after one successful deterministic or fallback observation. */
export function nextCheckAfterObservation(
  previous: QueueItem,
  observation: QueueObservation,
  now: Date,
  settingsInput?: QueueSettings,
): string | undefined {
  const settings = effectiveSettings(settingsInput)
  if (isTerminalState(observation.state)) {
    return observation.source === 'webhook' || (previous.callback?.terminalPending === true && observation.source !== 'code')
      ? addSeconds(now, settings.automaticMinimumSeconds)
      : undefined
  }
  if (previous.monitoring.userIntervalSeconds !== undefined) {
    return addSeconds(now, clampSeconds(previous.monitoring.userIntervalSeconds, previous.monitoring, settings))
  }

  let seconds: number
  if (observation.state === 'running' && runningAgeSeconds(previous, observation, now) < settings.startupWindowSeconds) {
    seconds = settings.startupIntervalSeconds
  } else if (observation.state !== previous.state) {
    seconds = settings.automaticMinimumSeconds
  } else if (observation.state === 'queued') {
    const index = Math.min(previous.consecutiveUnchangedChecks, QUEUED_INTERVALS_SECONDS.length - 1)
    seconds = Math.min(QUEUED_INTERVALS_SECONDS[index] ?? settings.queuedMaximumSeconds, settings.queuedMaximumSeconds)
  } else if (observation.state === 'running') {
    seconds = stableRunningSeconds(previous, observation, settings)
  } else {
    seconds = settings.automaticMinimumSeconds
  }
  return addSeconds(now, clampSeconds(Math.min(seconds, previous.monitoring.preferredIntervalSeconds ?? Number.POSITIVE_INFINITY), previous.monitoring, settings))
}

/** Probe/transport failures use a fixed bounded ladder and do not invoke a model by themselves. */
export function nextCheckAfterFailure(
  item: QueueItem,
  now: Date,
  settingsInput?: QueueSettings,
): string {
  const settings = effectiveSettings(settingsInput)
  if (item.monitoring.userIntervalSeconds !== undefined) {
    return addSeconds(now, clampSeconds(item.monitoring.userIntervalSeconds, item.monitoring, settings))
  }
  const index = Math.min(item.consecutiveFailures, FAILURE_INTERVALS_SECONDS.length - 1)
  return addSeconds(now, clampSeconds(FAILURE_INTERVALS_SECONDS[index] ?? 1_800, item.monitoring, settings))
}

export function describeNextCheck(item: QueueItem, settingsInput?: QueueSettings): string {
  if (item.callback?.terminalPending) return 'webhook exit; awaiting scheduler verification'
  if (isTerminalState(item.state)) return 'terminal state; monitoring stopped'
  if (item.monitoring.userIntervalSeconds !== undefined) return 'per-item user interval'
  const settings = effectiveSettings(settingsInput)
  if (item.consecutiveFailures > 0) return `probe retry ${String(item.consecutiveFailures)} of 4`
  if (item.lastObservation === undefined) return 'initial post-submission check'
  if (item.state === 'queued') return `queued backoff capped at ${String(settings.queuedMaximumSeconds)} seconds`
  if (item.state === 'running' && item.lastObservation !== undefined && runningAgeSeconds(item, item.lastObservation, new Date()) < settings.startupWindowSeconds) return 'startup checks from actual execution time'
  if (item.state === 'running') return 'adaptive running checks; walltime is a limit, not progress'
  return 'automatic minimum cadence'
}
