import { describe, expect, it } from 'vitest'
import {
  planQueueBatches,
  QueueWorkerContractError,
  validateObservationBatch,
} from '../src/planner.ts'
import { queueItemSchema, queueItemIdSchema, type QueueItem } from '../src/types.ts'

const now = new Date('2026-09-01T12:00:00.000Z')

function item(input: {
  id: string
  nextCheckAt: string
  target?: 'local' | string
  observer?: 'slurm' | 'pbs' | 'process'
}): QueueItem {
  const target = input.target === undefined || input.target === 'local'
    ? { kind: 'local' }
    : { kind: 'machine', machineId: input.target }
  const observer = input.observer === 'process'
    ? {
        kind: 'process',
        handle: {
          pid: 42,
          startToken: 'start-42',
          launchedAt: '2026-09-01T11:59:00.000Z',
          exitCodePath: '/tmp/task.exit',
          stdoutPath: '/tmp/task.out',
          stderrPath: '/tmp/task.err',
        },
      }
    : { kind: input.observer ?? 'slurm', jobId: `job-${input.id}` }
  return queueItemSchema.parse({
    id: input.id,
    label: input.id,
    tags: [],
    target,
    observer,
    state: 'running',
    monitoring: { preferredIntervalSeconds: 60 },
    attention: {
      primary: {
        sessionId: 'session-shared',
        cwd: '/research/shared',
        agentPreset: 'code',
      },
      primaryDelivery: 'wake',
      primaryConditions: ['completed'],
      subscriptions: [],
    },
    revision: 1,
    createdAt: '2026-09-01T11:00:00.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
    nextCheckAt: input.nextCheckAt,
    consecutiveUnchangedChecks: 0,
    consecutiveFailures: 0,
  })
}

describe('planQueueBatches', () => {
  it('packs same-target observers and only pulls bounded near-due peers forward', () => {
    const due = item({ id: 'due', nextCheckAt: '2026-09-01T11:59:59.000Z', target: 'nova' })
    const near = item({ id: 'near', nextCheckAt: '2026-09-01T12:00:10.000Z', target: 'nova' })
    const tooEarly = item({ id: 'early', nextCheckAt: '2026-09-01T12:00:20.000Z', target: 'nova' })
    const otherObserver = item({ id: 'pbs', nextCheckAt: '2026-09-01T12:00:10.000Z', target: 'nova', observer: 'pbs' })
    const plans = planQueueBatches([tooEarly, otherObserver, near, due], now, {
      earlyPiggybackWindowSeconds: 60,
      maximumEarlyFraction: 0.25,
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]?.items.map((entry) => entry.id)).toEqual(['due', 'near'])
  })

  it('does not wait for a near-due item before planning an overdue item', () => {
    const plans = planQueueBatches([
      item({ id: 'late-a', nextCheckAt: '2026-09-01T11:00:00.000Z', target: 'nova' }),
      item({ id: 'late-b', nextCheckAt: '2026-09-01T11:30:00.000Z', target: 'nova' }),
    ], now)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.items.map((entry) => entry.id)).toEqual(['late-a', 'late-b'])
  })

  it('batches deterministic probes across owners when target and observer match', () => {
    const first = item({ id: 'first', nextCheckAt: '2026-09-01T11:59:00.000Z', target: 'nova' })
    const second = queueItemSchema.parse({
      ...item({ id: 'second', nextCheckAt: '2026-09-01T11:59:00.000Z', target: 'nova' }),
      attention: {
        ...first.attention,
        primary: { sessionId: 'other-chat', cwd: '/research/other', agentPreset: 'code' },
      },
    })
    const plans = planQueueBatches([first, second], now)
    expect(plans).toHaveLength(1)
    expect(plans[0]?.items.map((entry) => entry.id).sort()).toEqual(['first', 'second'])
  })
})

describe('validateObservationBatch', () => {
  const requested = [queueItemIdSchema.parse('a'), queueItemIdSchema.parse('b')]
  const observation = (id: string) => ({
    queueItemId: id,
    state: 'running',
    observedAt: now.toISOString(),
    evidence: `${id} is running`,
  })

  it('isolates an omitted item instead of failing the returned observation', () => {
    const result = validateObservationBatch({ observations: [observation('a')] }, requested)
    expect([...result.observations]).toHaveLength(1)
    expect(result.missing).toEqual([queueItemIdSchema.parse('b')])
  })

  it('rejects duplicate and unrequested IDs', () => {
    expect(() => validateObservationBatch({ observations: [observation('a'), observation('a')] }, requested))
      .toThrow(QueueWorkerContractError)
    expect(() => validateObservationBatch({ observations: [observation('outside')] }, requested))
      .toThrow(/unrequested/)
  })
})
