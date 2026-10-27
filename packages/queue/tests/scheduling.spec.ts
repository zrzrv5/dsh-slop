import { describe, expect, it } from 'vitest'
import { initialNextCheckAt, nextCheckAfterFailure, nextCheckAfterObservation } from '../src/scheduling.ts'
import { queueItemSchema, type QueueObservation } from '../src/types.ts'

const now = new Date('2026-09-01T12:00:00.000Z')

function runningItem(overrides: Record<string, unknown> = {}) {
  return queueItemSchema.parse({
    id: 'task',
    label: 'task',
    tags: [],
    target: { kind: 'local' },
    observer: { kind: 'slurm', jobId: '7' },
    state: 'running',
    monitoring: { maximumIntervalSeconds: 600 },
    attention: {
      primary: { sessionId: 'session', cwd: '/research', agentPreset: 'code' },
      primaryDelivery: 'wake',
      primaryConditions: ['completed'],
      subscriptions: [],
    },
    revision: 1,
    createdAt: '2026-09-01T11:00:00.000Z',
    updatedAt: '2026-09-01T11:59:00.000Z',
    nextCheckAt: now.toISOString(),
    consecutiveUnchangedChecks: 0,
    consecutiveFailures: 0,
    ...overrides,
  })
}

describe('adaptive scheduling', () => {
  it('honors a preferred cadence without extending a sooner near-end check', () => {
    const item = runningItem({ monitoring: { expectedDurationSeconds: 1800, preferredIntervalSeconds: 180, maximumIntervalSeconds: 300 } })
    const observation = { queueItemId: item.id, state: 'running' as const, observedAt: now.toISOString(), evidence: 'running', elapsedSeconds: 600, walltimeSeconds: 3600, expectedRemainingSeconds: 3000 }
    expect(nextCheckAfterObservation(item, observation, now)).toBe('2026-09-01T12:03:00.000Z')
    expect(nextCheckAfterObservation(item, { ...observation, elapsedSeconds: 1700, expectedRemainingSeconds: 1900 }, now)).toBe('2026-09-01T12:02:00.000Z')
  })
  it('respects the initial lower bound and stops terminal items', () => {
    expect(initialNextCheckAt(now, 'queued', {
      preferredIntervalSeconds: 30,
      earliestCheckAfterSeconds: 120,
    })).toBe('2026-09-01T12:02:00.000Z')
    expect(initialNextCheckAt(now, 'completed', { preferredIntervalSeconds: 30 })).toBeUndefined()
  })

  it('backs off unchanged tasks and resets shorter after a transition', () => {
    const item = runningItem({ runningObservedAt: '2026-09-01T11:00:00.000Z' })
    expect(nextCheckAfterObservation(item, {
      queueItemId: item.id,
      state: 'running',
      observedAt: now.toISOString(),
      evidence: 'still running',
    }, now)).toBe('2026-09-01T12:10:00.000Z')
    expect(nextCheckAfterObservation(item, {
      queueItemId: item.id,
      state: 'unknown',
      observedAt: now.toISOString(),
      evidence: 'scheduler temporarily unavailable',
    }, now)).toBe('2026-09-01T12:02:00.000Z')
  })

  it('shortens checks near expected completion', () => {
    const item = runningItem({ runningObservedAt: '2026-09-01T11:00:00.000Z' })
    expect(nextCheckAfterObservation(item, {
      queueItemId: item.id,
      state: 'running',
      observedAt: now.toISOString(),
      evidence: 'running near walltime',
      expectedRemainingSeconds: 9,
    }, now)).toBe('2026-09-01T12:02:00.000Z')
  })

  it('lets an explicit user interval override adaptive cadence', () => {
    const item = runningItem({
      monitoring: { preferredIntervalSeconds: 60, maximumIntervalSeconds: 600, userIntervalSeconds: 17 },
      consecutiveFailures: 4,
    })
    const observation: QueueObservation = {
      queueItemId: item.id,
      state: 'running',
      observedAt: now.toISOString(),
      evidence: 'running',
      recommendedCheckAfterSeconds: 300,
    }
    expect(nextCheckAfterObservation(item, observation, now)).toBe('2026-09-01T12:01:00.000Z')
    expect(nextCheckAfterFailure(item, now)).toBe('2026-09-01T12:01:00.000Z')
  })

  it('backs off failures but clamps them to the item maximum', () => {
    const item = runningItem({ monitoring: { preferredIntervalSeconds: 60, maximumIntervalSeconds: 100 } })
    expect(nextCheckAfterFailure(item, now)).toBe('2026-09-01T12:01:40.000Z')
  })

  it('uses one quarter of the shorter expected duration and scheduler walltime', () => {
    const item = runningItem({
      monitoring: { expectedDurationSeconds: 28_800 },
      consecutiveUnchangedChecks: 2,
    })
    expect(nextCheckAfterObservation(item, {
      queueItemId: item.id,
      state: 'running',
      observedAt: now.toISOString(),
      evidence: 'running',
      elapsedSeconds: 1_800,
      walltimeSeconds: 14_400,
    }, now)).toBe('2026-09-01T12:52:30.000Z')
  })

  it('uses the 2m, 5m, 15m, 30m probe failure ladder', () => {
    const expected = [120, 300, 900, 1_800]
    expected.forEach((seconds, consecutiveFailures) => {
      const item = runningItem({ monitoring: {}, consecutiveFailures })
      expect(nextCheckAfterFailure(item, now)).toBe(new Date(now.getTime() + seconds * 1_000).toISOString())
    })
  })
})
