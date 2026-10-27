import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteQueueStore } from '../src/sqlite-store.ts'
import { defaultQueueSettings, deliveryRecordSchema, queueItemSchema, queueObservationSchema } from '../src/types.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-slop-queue-'))
  temporaryDirectories.push(directory)
  return join(directory, 'queue.sqlite')
}

function initialItem() {
  return queueItemSchema.parse({
    id: 'durable-task',
    label: 'durable task',
    tags: ['science'],
    target: { kind: 'machine', machineId: 'nova' },
    observer: { kind: 'slurm', jobId: '1234' },
    state: 'running',
    monitoring: { preferredIntervalSeconds: 60 },
    attention: {
      primary: { sessionId: 'zns-chat', cwd: '/research/zns', agentPreset: 'code' },
      primaryDelivery: 'wake',
      primaryConditions: ['completed'],
      subscriptions: [],
    },
    revision: 1,
    createdAt: '2026-09-01T11:00:00.000Z',
    updatedAt: '2026-09-01T11:00:00.000Z',
    nextCheckAt: '2026-09-01T12:00:00.000Z',
    consecutiveUnchangedChecks: 0,
    consecutiveFailures: 0,
  })
}

describe('SqliteQueueStore', () => {
  it('persists the global ledger and earliest deadline across restart', async () => {
    const path = await storePath()
    const first = new SqliteQueueStore(path)
    await first.initialize()
    const item = initialItem()
    await first.insertItem(item)
    await first.close()

    const reopened = new SqliteQueueStore(path)
    await reopened.initialize()
    expect(await reopened.getItem(item.id)).toEqual(item)
    expect(await reopened.earliestNextCheckAt()).toBe(item.nextCheckAt)
    expect(await reopened.listDue('2026-09-01T12:00:00.000Z')).toEqual([item])
    await reopened.close()
  })

  it('adds versioned settings without rewriting existing Queue item bodies', async () => {
    const path = await storePath()
    const first = new SqliteQueueStore(path)
    await first.initialize()
    const item = initialItem()
    await first.insertItem(item)
    const settings = defaultQueueSettings(new Date('2026-09-03T12:00:00.000Z'))
    await first.insertSettings(settings)
    await first.close()

    const reopened = new SqliteQueueStore(path)
    await reopened.initialize()
    expect(await reopened.getItem(item.id)).toEqual(item)
    expect(await reopened.getSettings()).toEqual(settings)
    await reopened.close()
  })

  it('atomically commits an observation, item state, and deduplicated delivery', async () => {
    const store = new SqliteQueueStore(await storePath())
    await store.initialize()
    const item = initialItem()
    await store.insertItem(item)
    const observation = queueObservationSchema.parse({
      queueItemId: item.id,
      state: 'completed',
      observedAt: '2026-09-01T12:00:01.000Z',
      evidence: 'sacct: COMPLETED',
    })
    const next = queueItemSchema.parse({
      ...item,
      state: 'completed',
      revision: 2,
      updatedAt: observation.observedAt,
      nextCheckAt: undefined,
      lastObservation: observation,
    })
    const delivery = deliveryRecordSchema.parse({
      target: item.attention.primary,
      trigger: {
        triggerKey: 'durable-task:2:completed',
        queueItemId: item.id,
        label: item.label,
        previousState: 'running',
        state: 'completed',
        observedAt: observation.observedAt,
        evidence: observation.evidence,
      },
      delivery: 'wake',
      state: 'pending',
      attempts: 0,
      createdAt: observation.observedAt,
      updatedAt: observation.observedAt,
    })
    expect(await store.commitObservation({
      expectedRevision: 1,
      item: next,
      observation,
      deliveries: [delivery, delivery],
    })).toBe('updated')
    expect(await store.getItem(item.id)).toEqual(next)
    expect(await store.listObservations(item.id)).toEqual([observation])
    expect(await store.listPendingDeliveries('2026-09-01T12:00:01.000Z')).toEqual([delivery])
    await store.markDeliveries([{
      kind: 'retry',
      target: delivery.target,
      triggerKey: delivery.trigger.triggerKey,
      attemptedAt: '2026-09-01T12:00:02.000Z',
      error: 'host unavailable',
      nextAttemptAt: '2026-09-01T12:00:32.000Z',
    }])
    expect(await store.listPendingDeliveries('2026-09-01T12:00:31.000Z')).toEqual([])
    expect(await store.earliestPendingDeliveryAt()).toBe('2026-09-01T12:00:32.000Z')
    expect(await store.listPendingDeliveries('2026-09-01T12:00:32.000Z')).toEqual([
      deliveryRecordSchema.parse({
        ...delivery,
        attempts: 1,
        updatedAt: '2026-09-01T12:00:02.000Z',
        lastError: 'host unavailable',
        nextAttemptAt: '2026-09-01T12:00:32.000Z',
      }),
    ])
    await store.markDeliveries([{
      kind: 'delivered',
      target: delivery.target,
      triggerKey: delivery.trigger.triggerKey,
      deliveredAt: '2026-09-01T12:00:33.000Z',
    }])
    expect(await store.listPendingDeliveries('2026-09-01T12:00:33.000Z')).toEqual([])
    expect(await store.earliestPendingDeliveryAt()).toBeUndefined()
    await store.close()
  })

  it('does not append an observation when the item revision conflicts', async () => {
    const store = new SqliteQueueStore(await storePath())
    await store.initialize()
    const item = initialItem()
    await store.insertItem(item)
    const observation = queueObservationSchema.parse({
      queueItemId: item.id,
      state: 'running',
      observedAt: '2026-09-01T12:00:01.000Z',
      evidence: 'running',
    })
    const next = queueItemSchema.parse({ ...item, revision: 2, lastObservation: observation })
    expect(await store.commitObservation({
      expectedRevision: 99,
      item: next,
      observation,
      deliveries: [],
    })).toBe('revision-conflict')
    expect(await store.listObservations(item.id)).toEqual([])
    expect(await store.getItem(item.id)).toEqual(item)
    await store.close()
  })
})
