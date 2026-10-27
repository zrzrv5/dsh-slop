import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QueueService } from '../src/service.ts'
import { SqliteQueueStore } from '../src/sqlite-store.ts'
import { queueSessionTargetSchema } from '../src/types.ts'
import type {
  QueueChatDeliveryPort,
  QueueDeliveryRequest,
  QueueQueryRequest,
  QueueQueryWorkerPort,
  QueueProbePort,
  QueueProbeRequest,
  QueueSessionTarget,
  QueueSubscriptionInput,
} from '../src/types.ts'

const temporaryDirectories: string[] = []
const baseTime = new Date('2026-09-01T12:00:00.000Z')
const dueTime = new Date('2026-09-01T12:01:00.000Z')

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function target(sessionId: string, cwd = `/research/${sessionId}`): QueueSessionTarget {
  return queueSessionTargetSchema.parse({ sessionId, cwd, agentPreset: 'code' })
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-slop-queue-service-'))
  temporaryDirectories.push(directory)
  return join(directory, 'queue.sqlite')
}

interface FixtureOptions {
  readonly query: (request: QueueQueryRequest) => Promise<unknown>
  readonly probe?: (request: QueueProbeRequest) => Promise<unknown>
  readonly deliver?: (request: QueueDeliveryRequest) => Promise<void>
  readonly deliveryRetry?: { readonly baseSeconds?: number; readonly maximumSeconds?: number }
}

async function fixture(options: FixtureOptions) {
  const queries: QueueQueryRequest[] = []
  const deliveries: QueueDeliveryRequest[] = []
  const queryWorker: QueueQueryWorkerPort = {
    async query(request) {
      queries.push(request)
      return await options.query(request)
    },
  }
  const probe: QueueProbePort | undefined = options.probe === undefined ? undefined : {
    probe: options.probe,
  }
  const chatDelivery: QueueChatDeliveryPort = {
    async deliver(request) {
      deliveries.push(request)
      await options.deliver?.(request)
    },
  }
  const store = new SqliteQueueStore(await databasePath())
  const service = new QueueService({
    store,
    queryWorker,
    ...(probe === undefined ? {} : { probe }),
    chatDelivery,
    clock: { now: () => dueTime },
    ...(options.deliveryRetry === undefined ? {} : { deliveryRetry: options.deliveryRetry }),
  })
  await service.initialize()
  return { service, store, queries, deliveries }
}

async function trackSlurm(service: QueueService, input: {
  id: string
  primary?: QueueSessionTarget
  jobId?: string
  conditions?: readonly ('completed' | 'failed' | 'cancelled' | 'any-state-change')[]
}) {
  return await service.track({ purpose: 'monitor',
    id: input.id,
    label: input.id,
    target: { kind: 'machine', machineId: 'nova' },
    observer: { kind: 'slurm', jobId: input.jobId ?? input.id },
    initialState: 'running',
    monitoring: { userIntervalSeconds: 60 },

  }, { primary: input.primary ?? target('zns-chat'), now: baseTime })
}

function completed(request: QueueQueryRequest) {
  return {
    observations: request.items.map((item) => ({
      queueItemId: item.id,
      state: 'completed',
      observedAt: dueTime.toISOString(),
      evidence: `${item.id}: COMPLETED`,
    })),
  }
}

describe('QueueService', () => {
  it('coalesces manual checks and leaves authorized continuation for background delivery', async () => {
    const probes: QueueProbeRequest[] = []
    const { service, queries, deliveries } = await fixture({
      query: async () => { throw new Error('manual checks cannot use a model') },
      probe: async request => {
        probes.push(request)
        return { observations: request.items.map(item => ({ queueItemId: item.id, state: 'completed', observedAt: dueTime.toISOString(), evidence: 'COMPLETED', source: 'code' })), issues: [] }
      },
    })
    const first = await trackSlurm(service, { id: 'manual', jobId: '123' })
    await service.update(first.id, { purpose: 'continue', continuation: 'Verify /research/manual/output then finish the authorized analysis.' })
    await trackSlurm(service, { id: 'unrelated', jobId: '456' })
    const [a, b] = await Promise.all([service.probeNow(first.id), service.probeNow(first.id)])
    expect(a).toEqual(b)
    expect(a.state).toBe('completed')
    expect(a.nextCheckAt).toBeUndefined()
    expect(a.attention.primaryDelivery).toBe('wake')
    expect(probes).toHaveLength(1)
    expect(probes[0]?.items.map(item => item.id)).toEqual(['manual'])
    expect(queries).toHaveLength(0)
    await service.flushPendingDeliveries(dueTime)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.delivery).toBe('wake')
    await service.close()
  })

  it('records an ambiguous manual probe without using fallback or replacing the last scheduler state', async () => {
    const { service, queries } = await fixture({
      query: async () => { throw new Error('manual checks cannot use a model') },
      probe: async request => ({ observations: [], issues: request.items.map(item => ({ queueItemId: item.id, kind: 'fallback', code: 'AMBIGUOUS', message: 'ambiguous scheduler output' })) }),
    })
    const item = await trackSlurm(service, { id: 'manual', jobId: '123' })
    const checked = await service.probeNow(item.id)
    expect(checked.state).toBe('running')
    expect(checked.lastCheckError?.message).toContain('AMBIGUOUS')
    expect(queries).toHaveLength(0)
    await service.close()
  })

  it('creates versioned default settings and schedules new tasks at one minute with passive delivery', async () => {
    const { service } = await fixture({ query: async () => ({ observations: [] }) })
    const settings = await service.settings()
    expect(settings).toMatchObject({ schemaVersion: 1, profile: 'normal', initialCheckSeconds: 60, stableMinimumSeconds: 300, maximumDetectionDelaySeconds: 7_200, defaultDelivery: 'notify' })
    const item = await service.track({ purpose: 'monitor',
      id: 'new-job', label: 'new job', target: { kind: 'machine', machineId: 'nova' }, observer: { kind: 'slurm', jobId: '123' },
    }, { primary: target('owner'), now: baseTime })
    expect(item.nextCheckAt).toBe('2026-09-01T12:01:00.000Z')
    expect(item.attention).toMatchObject({ primaryDelivery: 'notify', primaryConditions: ['any-state-change'] })
    await service.close()
  })

  it('validates settings relationships and immediately reschedules inherited active tasks', async () => {
    const { service } = await fixture({ query: async () => ({ observations: [] }) })
    const item = await service.track({ purpose: 'monitor',
      id: 'inherited-job', label: 'inherited job', target: { kind: 'machine', machineId: 'nova' }, observer: { kind: 'slurm', jobId: '123' },
    }, { primary: target('owner'), now: baseTime })
    await expect(service.updateSettings({ profile: 'custom', stableMinimumSeconds: 60 }, 1, dueTime)).rejects.toThrow('stable minimum')
    const settings = await service.updateSettings({
      profile: 'custom',
      initialCheckSeconds: 180,
      automaticMinimumSeconds: 180,
    }, 1, dueTime)
    expect(settings.revision).toBe(2)
    expect(await service.get(item.id)).toMatchObject({ revision: 2, nextCheckAt: '2026-09-01T12:04:00.000Z' })
    await service.close()
  })

  it('stores a host-injected durable primary target and keeps global reads side-effect free', async () => {
    const { service } = await fixture({ query: async () => ({ observations: [] }) })
    const item = await service.track({ purpose: 'monitor',
      id: 'local-process',
      label: 'local process',
      target: { kind: 'local' },
      observer: {
        kind: 'process',
        handle: {
          pid: 91,
          startToken: 'pid-91-start-123',
          launchedAt: baseTime.toISOString(),
          exitCodePath: '/runs/91.exit',
          stdoutPath: '/runs/91.out',
          stderrPath: '/runs/91.err',
        },
      },
    }, { primary: target('local-chat', '/research/local'), now: baseTime })
    expect(item.attention.primary).toEqual(target('local-chat', '/research/local'))
    expect((await service.list())[0]?.attention.subscriptions).toEqual([])
    expect(await service.list({ primarySessionId: 'local-chat' })).toHaveLength(1)
    expect(await service.list({ subscribedSessionId: 'unrelated-chat' })).toEqual([])
    await service.close()
  })

  it('batches same-machine fallback work by owner and merges delivery per Chat', async () => {
    const { service, queries, deliveries } = await fixture({ query: async (request) => completed(request) })
    await trackSlurm(service, { id: 'zns-a' })
    await trackSlurm(service, { id: 'zns-b' })
    const result = await service.runDue(dueTime)
    expect(result).toMatchObject({ batches: 1, observed: 2, deliveries: 2 })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.parent).toEqual(target('zns-chat'))
    expect(queries[0]?.items.map((item) => item.id)).toEqual(['zns-a', 'zns-b'])
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.target).toEqual(target('zns-chat'))
    expect(deliveries[0]?.triggers).toHaveLength(2)
    await service.close()
  })

  it('uses separate query parents and routes state changes to their owning Chats', async () => {
    const { service, queries, deliveries } = await fixture({ query: async (request) => completed(request) })
    await trackSlurm(service, { id: 'zns', primary: target('zns-chat') })
    await trackSlurm(service, { id: 'napso', primary: target('napso-chat') })
    const result = await service.runDue(dueTime)
    expect(result.batches).toBe(1)
    expect(queries.map((request) => request.parent.sessionId).sort()).toEqual(['napso-chat', 'zns-chat'])
    expect(deliveries.map((request) => request.target.sessionId).sort()).toEqual(['napso-chat', 'zns-chat'])
    await service.close()
  })

  it('lets only the host-provided current Chat subscribe and does not replay old states', async () => {
    const { service, deliveries } = await fixture({ query: async (request) => completed(request) })
    const item = await trackSlurm(service, { id: 'shared' })
    const attemptedModelChoice = {
      sessionId: 'victim-chat',
      delivery: 'notify',
      conditions: ['completed'],
    } satisfies QueueSubscriptionInput & { readonly sessionId: string }
    await expect(service.subscribe(item.id, attemptedModelChoice, {
      current: target('requesting-chat'),
      now: baseTime,
    })).rejects.toThrow()
    await service.subscribe(item.id, { delivery: 'notify', conditions: ['completed'] }, {
      current: target('requesting-chat'),
      now: baseTime,
    })
    expect(await service.list({ subscribedSessionId: 'requesting-chat' })).toHaveLength(1)
    await service.runDue(dueTime)
    expect(deliveries.map((request) => [request.target.sessionId, request.delivery]).sort()).toEqual([
      ['requesting-chat', 'notify'],
      ['zns-chat', 'notify'],
    ])
    await service.close()
  })

  it('isolates an omitted item while committing the other item observation', async () => {
    const { service } = await fixture({
      query: async (request) => ({
        observations: [{
          queueItemId: request.items[0]?.id,
          state: 'running',
          observedAt: dueTime.toISOString(),
          evidence: 'still running',
        }],
      }),
    })
    await trackSlurm(service, { id: 'observed' })
    await trackSlurm(service, { id: 'omitted' })
    const result = await service.runDue(dueTime)
    expect(result).toMatchObject({ batches: 1, observed: 1, missing: 1 })
    expect((await service.get('observed'))?.lastObservation?.evidence).toBe('still running')
    expect((await service.get('omitted'))?.lastCheckError?.message).toMatch(/omitted/)
    expect((await service.observations('omitted'))).toEqual([])
    await service.close()
  })

  it('uses deterministic observations without starting the fallback worker', async () => {
    const { service, queries } = await fixture({
      query: async () => { throw new Error('fallback should not run') },
      probe: async (request) => ({
        observations: request.items.map((item) => ({
          queueItemId: item.id,
          state: 'completed',
          observedAt: dueTime.toISOString(),
          evidence: 'sacct: COMPLETED',
          source: 'code',
        })),
        issues: [],
      }),
    })
    await trackSlurm(service, { id: 'direct-probe' })
    expect(await service.runDue(dueTime)).toMatchObject({ observed: 1, missing: 0 })
    expect(queries).toEqual([])
    expect((await service.get('direct-probe'))?.lastObservation?.source).toBe('code')
    await service.close()
  })

  it('falls back only for the item explicitly classified as ambiguous', async () => {
    const { service, queries } = await fixture({
      query: async (request) => completed(request),
      probe: async (request) => ({
        observations: [{
          queueItemId: request.items.find((item) => item.id === 'direct')?.id,
          state: 'running',
          observedAt: dueTime.toISOString(),
          evidence: 'squeue: RUNNING',
          source: 'code',
        }],
        issues: [{
          queueItemId: request.items.find((item) => item.id === 'ambiguous')?.id,
          kind: 'fallback',
          code: 'AMBIGUOUS_ACCOUNTING',
          message: 'Scheduler records conflict.',
        }],
      }),
    })
    await trackSlurm(service, { id: 'direct' })
    await trackSlurm(service, { id: 'ambiguous' })
    expect(await service.runDue(dueTime)).toMatchObject({ observed: 2, missing: 0 })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.items.map((item) => item.id)).toEqual(['ambiguous'])
    await service.close()
  })

  it('notifies once when monitoring degrades and once when it recovers without a state change', async () => {
    let healthy = false
    const { service, deliveries } = await fixture({
      query: async () => { throw new Error('fallback should not run') },
      probe: async (request) => healthy
        ? {
            observations: request.items.map((item) => ({ queueItemId: item.id, state: 'running', observedAt: dueTime.toISOString(), evidence: 'squeue: RUNNING', source: 'code' })),
            issues: [],
          }
        : {
            observations: [],
            issues: request.items.map((item) => ({ queueItemId: item.id, kind: 'retry', code: 'PROBE_TIMEOUT', message: 'scheduler timed out' })),
          },
    })
    let item = await trackSlurm(service, { id: 'health-alert' })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      item = await service.update(item.id, { nextCheckAt: dueTime.toISOString() }, item.revision, dueTime)
      await service.runDue(dueTime)
      item = (await service.get(item.id))!
    }
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.delivery).toBe('notify')
    expect(deliveries[0]?.triggers[0]?.event).toBe('monitor-degraded')

    healthy = true
    item = await service.update(item.id, { nextCheckAt: dueTime.toISOString() }, item.revision, dueTime)
    await service.runDue(dueTime)
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1]?.triggers[0]?.event).toBe('monitor-recovered')
    await service.close()
  })

  it('keeps failed delivery pending and retries with capped exponential backoff', async () => {
    let failuresRemaining = 2
    const { service, deliveries } = await fixture({
      query: async (request) => completed(request),
      deliver: async () => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1
          throw new Error('Chat host unavailable')
        }
      },
      deliveryRetry: { baseSeconds: 30, maximumSeconds: 50 },
    })
    await trackSlurm(service, { id: 'retry-delivery' })
    expect((await service.runDue(dueTime)).deliveries).toBe(0)
    expect(await service.earliestWorkAt()).toBe('2026-09-01T12:01:30.000Z')
    expect(await service.flushPendingDeliveries(new Date('2026-09-01T12:01:29.000Z'))).toBe(0)
    expect(deliveries).toHaveLength(1)
    expect(await service.flushPendingDeliveries(new Date('2026-09-01T12:01:30.000Z'))).toBe(0)
    expect(await service.earliestWorkAt()).toBe('2026-09-01T12:02:20.000Z')
    expect(await service.flushPendingDeliveries(new Date('2026-09-01T12:02:20.000Z'))).toBe(1)
    expect(deliveries).toHaveLength(3)
    expect(await service.earliestWorkAt()).toBeUndefined()
    await service.close()
  })

  it('allows one explicit terminal recheck and clears its deadline after a query failure', async () => {
    const { service } = await fixture({ query: async () => { throw new Error('scheduler unavailable') } })
    const item = await service.track({ purpose: 'monitor',
      id: 'terminal-recheck',
      label: 'terminal recheck',
      target: { kind: 'machine', machineId: 'nova' },
      observer: { kind: 'slurm', jobId: 'finished-1' },
      initialState: 'completed',
      monitoring: { preferredIntervalSeconds: 60 },
    }, { primary: target('zns-chat'), now: baseTime })
    expect(item.nextCheckAt).toBeUndefined()
    await service.update(item.id, { nextCheckAt: dueTime.toISOString() }, item.revision, baseTime)
    expect((await service.runDue(dueTime)).contractFailures).toBe(1)
    const failed = await service.get(item.id)
    expect(failed?.nextCheckAt).toBeUndefined()
    expect(failed?.lastCheckError?.message).toBe('scheduler unavailable')
    expect(await service.earliestWorkAt()).toBeUndefined()
    await service.close()
  })
})
