import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueueMonitor } from '../src/monitor.ts'
import { QueueService } from '../src/service.ts'
import { SqliteQueueStore } from '../src/sqlite-store.ts'
import type {
  QueueChatDeliveryPort,
  QueueClockPort,
  QueueDeliveryRequest,
  QueueQueryRequest,
  QueueQueryWorkerPort,
  QueueTimerHandle,
  QueueTimerPort,
} from '../src/types.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

class MutableClock implements QueueClockPort {
  constructor(public value: Date) {}
  now(): Date { return this.value }
}

interface ManualEntry {
  readonly at: Date
  readonly callback: () => void
  cancelled: boolean
}

class ManualTimer implements QueueTimerPort {
  readonly entries: ManualEntry[] = []

  schedule(at: Date, callback: () => void): QueueTimerHandle {
    const entry: ManualEntry = { at, callback, cancelled: false }
    this.entries.push(entry)
    return { cancel: () => { entry.cancelled = true } }
  }

  active(): ManualEntry[] {
    return this.entries.filter((entry) => !entry.cancelled)
  }

  fireNext(): void {
    const entry = this.active()[0]
    if (entry === undefined) throw new Error('no active timer')
    entry.cancelled = true
    entry.callback()
  }
}

async function pathForTest(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-slop-queue-monitor-'))
  temporaryDirectories.push(directory)
  return join(directory, 'queue.sqlite')
}

function ports(options: { failFirstDelivery?: boolean } = {}) {
  const queries: QueueQueryRequest[] = []
  const deliveries: QueueDeliveryRequest[] = []
  let fail = options.failFirstDelivery ?? false
  const queryWorker: QueueQueryWorkerPort = {
    async query(request) {
      queries.push(request)
      return {
        observations: request.items.map((item) => ({
          queueItemId: item.id,
          state: 'completed',
          observedAt: '2026-09-01T12:01:00.000Z',
          evidence: `${item.id}: COMPLETED`,
        })),
      }
    },
  }
  const chatDelivery: QueueChatDeliveryPort = {
    async deliver(request) {
      deliveries.push(request)
      if (fail) {
        fail = false
        throw new Error('host restarting')
      }
    },
  }
  return { queryWorker, chatDelivery, queries, deliveries }
}

async function seed(path: string): Promise<void> {
  const seedPorts = ports()
  const service = new QueueService({ store: new SqliteQueueStore(path), ...seedPorts })
  await service.initialize()
  for (const id of ['overdue-a', 'overdue-b']) {
    await service.track({ purpose: 'monitor',
      id,
      label: id,
      target: { kind: 'machine', machineId: 'nova' },
      observer: { kind: 'slurm', jobId: id },
      initialState: 'running',
      monitoring: { userIntervalSeconds: 5 },

    }, {
      primary: { sessionId: 'origin-chat', cwd: '/research/origin', agentPreset: 'code' },
      now: new Date('2026-09-01T12:00:00.000Z'),
    })
  }
  await service.close()
}

describe('QueueMonitor', () => {
  it('restores one earliest timer and coalesces every overdue compatible item after restart', async () => {
    const path = await pathForTest()
    await seed(path)
    const runtimePorts = ports()
    const clock = new MutableClock(new Date('2026-09-01T12:01:00.000Z'))
    const service = new QueueService({ store: new SqliteQueueStore(path), ...runtimePorts, clock })
    const timer = new ManualTimer()
    const monitor = new QueueMonitor({ service, clock, timer })
    await monitor.start()
    expect(timer.active()).toHaveLength(1)
    expect(timer.active()[0]?.at.toISOString()).toBe(clock.value.toISOString())
    timer.fireNext()
    await vi.waitFor(() => expect(runtimePorts.queries).toHaveLength(1))
    expect(runtimePorts.queries[0]?.items).toHaveLength(2)
    await vi.waitFor(() => expect(runtimePorts.deliveries).toHaveLength(1))
    await vi.waitFor(() => expect(timer.active()).toHaveLength(0))
    monitor.stop()
    await service.close()
  })

  it('keeps the single timer alive for a delivery retry after the task is terminal', async () => {
    const path = await pathForTest()
    await seed(path)
    const runtimePorts = ports({ failFirstDelivery: true })
    const clock = new MutableClock(new Date('2026-09-01T12:01:00.000Z'))
    const service = new QueueService({
      store: new SqliteQueueStore(path),
      ...runtimePorts,
      clock,
      deliveryRetry: { baseSeconds: 30, maximumSeconds: 30 },
    })
    const timer = new ManualTimer()
    const monitor = new QueueMonitor({ service, clock, timer })
    await monitor.start()
    timer.fireNext()
    await vi.waitFor(() => expect(runtimePorts.deliveries).toHaveLength(1))
    await vi.waitFor(() => expect(timer.active()[0]?.at.toISOString()).toBe('2026-09-01T12:01:30.000Z'))
    clock.value = new Date('2026-09-01T12:01:30.000Z')
    timer.fireNext()
    await vi.waitFor(() => expect(runtimePorts.deliveries).toHaveLength(2))
    await vi.waitFor(() => expect(timer.active()).toHaveLength(0))
    monitor.stop()
    await service.close()
  })
})
