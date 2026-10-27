import type { Context } from '@deepseek-ai/cordis'
import { jsonSchemaToTs, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { QueueMonitor, QueueService } from '@dsh-slop/queue'
import { describe, expect, it, vi } from 'vitest'
import { registerQueueTools } from '../src/queue-tools.ts'
import { MAX_QUEUE_LIST_BYTES } from '../src/queue-list.ts'

interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly output: ToolDefinition['output']
  execute(args: Record<string, unknown>, execution: ReturnType<typeof execution>): Promise<unknown>
}

function execution(sessionId = 'session-zns') {
  return {
    agent: {
      id: sessionId,
      ctx: { sessionProjections: { stateOf: () => 'standard' } },
      session: {
        id: sessionId,
        header: { cwd: '/work/project', agentPreset: 'standard' },
        events: [],
      },
    },
    callId: 'queue-call',
    signal: new AbortController().signal,
  }
}

function item(sessionId = 'session-zns') {
  return {
    id: 'queue-1',
    label: 'structure relaxation',
    tags: ['relax'],
    target: { kind: 'machine', machineId: 'machine-1' },
    observer: { kind: 'slurm', jobId: '1234' },
    state: 'running',
    monitoring: { expectedDurationSeconds: 3_600 },
    revision: 1,
    createdAt: '2026-09-02T12:00:00.000Z',
    updatedAt: '2026-09-02T12:00:00.000Z',
    nextCheckAt: '2026-09-02T12:05:00.000Z',
    consecutiveUnchangedChecks: 0,
    consecutiveFailures: 0,
    attention: {
      primary: { sessionId, cwd: '/work/project', agentPreset: 'standard' },
      primaryDelivery: 'wake',
      primaryConditions: ['completed'],
      subscriptions: [],
    },
  }
}

function fixture(overrides: Partial<Record<keyof QueueService, ReturnType<typeof vi.fn>>> = {}) {
  const tools: RegisteredTool[] = []
  const defaults = {
    get: vi.fn(async () => item()),
    list: vi.fn(async () => []),
    observations: vi.fn(async () => []),
    update: vi.fn(async () => item()),
    subscribe: vi.fn(async () => item()),
    unsubscribe: vi.fn(async () => item()),
    track: vi.fn(async () => item()),
    runDue: vi.fn(async () => ({ batches: 1, observed: 1, missing: 0, contractFailures: 0, deliveries: 0 })),
  }
  const service = { ...defaults, ...overrides } as unknown as QueueService
  const refresh = vi.fn(async () => {})
  const monitor = { refresh } as unknown as QueueMonitor
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tools.push(definition as unknown as RegisteredTool)
        return () => {}
      },
    },
  } as unknown as Context
  registerQueueTools(ctx, { service, monitor })
  return { tools, service: { ...defaults, ...overrides }, refresh }
}

describe('Queue model tools', () => {
  it('registers only ledger, query, and subscription operations', () => {
    const { tools } = fixture()
    expect(tools.map(tool => tool.name)).toEqual([
      'slop_queue_track',
      'slop_queue_list',
      'slop_queue_get',
      'slop_queue_update',
    ])
    expect(tools.some(tool => /submit|cancel|retry/i.test(tool.name))).toBe(false)
  })

  it('projects Queue identities, states, observations, and receipts into the Code Mode SDK', () => {
    const { tools } = fixture()
    const outputType = (name: string): string => {
      const tool = tools.find(candidate => candidate.name === name)
      if (tool === undefined) throw new Error(`missing tool ${name}`)
      return jsonSchemaToTs(tool.output.schema)
    }

    const track = outputType('slop_queue_track')
    expect(track).toContain('ok: true')
    expect(track).toContain('id: string')
    expect(track).toContain('state: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown"')
    expect(track).toContain('observer:')
    expect(track).toContain('jobId: string')

    const list = outputType('slop_queue_list')
    expect(list).toContain('value:')
    expect(list).toContain('target:')

    const get = outputType('slop_queue_get')
    expect(get).toContain('observations:')
    expect(get).toContain('evidence: string')

    const update = outputType('slop_queue_update')
    expect(update).toContain('run?:')
    expect(update).toContain('deliveries: number')

    for (const tool of tools) expect(jsonSchemaToTs(tool.output.schema)).not.toBe('unknown')
  })

  it('does not let another Chat change the primary owner delivery settings', async () => {
    const update = vi.fn(async () => item())
    const get = vi.fn(async () => item('session-zns'))
    const { tools } = fixture({ get, update })
    const queueUpdate = tools.find(tool => tool.name === 'slop_queue_update')
    await expect(queueUpdate?.execute({
      queueItemId: 'queue-1',
      action: 'patch',
      patch: { primaryDelivery: 'notify' },
    }, execution('session-other'))).rejects.toThrow(/primary owner Chat/)
    expect(update).not.toHaveBeenCalled()
  })

  it('rejects a model-authored subscription session selector', async () => {
    const { tools } = fixture()
    const queueUpdate = tools.find(tool => tool.name === 'slop_queue_update')
    await expect(queueUpdate?.execute({
      queueItemId: 'queue-1',
      action: 'subscribe',
      sessionId: 'victim-chat',
      delivery: 'wake',
      conditions: ['completed'],
    }, execution())).rejects.toThrow()
  })

  it('routes check-now through the packed Queue run instead of a per-item query worker', async () => {
    const get = vi.fn(async () => item())
    const update = vi.fn(async () => item())
    const runDue = vi.fn(async () => ({ batches: 1, observed: 1, missing: 0, contractFailures: 0, deliveries: 0 }))
    const observations = vi.fn(async () => [])
    const { tools, refresh } = fixture({ get, update, runDue, observations })
    const queueUpdate = tools.find(tool => tool.name === 'slop_queue_update')
    const result = await queueUpdate?.execute({ queueItemId: 'queue-1', action: 'check-now' }, execution())
    expect(update).toHaveBeenCalledWith('queue-1', expect.objectContaining({ nextCheckAt: expect.any(String) }), 1)
    expect(runDue).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(validateJsonSchemaValue(queueUpdate!.output.schema, result)).toEqual([])
  })

  it('returns recent summaries and counts without spilling large historical records', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...item(),
      id: `queue-${String(index)}`,
      createdAt: new Date(Date.UTC(2026, 8, index + 1)).toISOString(),
      state: index === 0 ? 'running' : 'completed',
      notes: 'x'.repeat(20_000),
    }))
    const list = vi.fn(async () => rows)
    const { tools } = fixture({ list })
    const queueList = tools.find(tool => tool.name === 'slop_queue_list')!
    const result = await queueList.execute({}, execution())

    expect(result).toMatchObject({ ok: true, value: [
      ...Array.from({ length: 10 }, (_, index) => expect.objectContaining({ id: `queue-${String(19 - index)}` })),
    ], page: { total: 20, offset: 0, hasMore: true, nextOffset: 10, stateCounts: { running: 1, completed: 19 } } })
    expect(validateJsonSchemaValue(queueList.output.schema, result)).toEqual([])
    expect(JSON.stringify(result)).not.toContain('notes')
    expect(JSON.stringify(result)).not.toContain('subscriptions')
    expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(MAX_QUEUE_LIST_BYTES)
    expect(await queueList.execute({ offset: 10 }, execution())).toMatchObject({
      value: [
        ...Array.from({ length: 10 }, (_, index) => expect.objectContaining({ id: `queue-${String(9 - index)}` })),
      ], page: { offset: 10, hasMore: false, total: 20 },
    })
  })

  it('applies filters and Chat scope before paging and never subscribes or refreshes', async () => {
    const { tools, service, refresh } = fixture()
    const queueList = tools.find(tool => tool.name === 'slop_queue_list')!
    const filters = { states: ['running'], observerKinds: ['slurm'], target: { kind: 'machine', machineId: 'nova' }, tags: ['HZO'] }
    for (const scope of ['all', 'primary', 'subscribed']) {
      const result = await queueList.execute({ ...filters, scope, limit: 2, offset: 3 }, execution())
      expect(service.list).toHaveBeenLastCalledWith({
        ...filters,
        ...(scope === 'primary' ? { primarySessionId: 'session-zns' } : {}),
        ...(scope === 'subscribed' ? { subscribedSessionId: 'session-zns' } : {}),
      })
      expect(result).toMatchObject({ ok: true, value: [], page: { total: 0, offset: 3, hasMore: false } })
      expect(validateJsonSchemaValue(queueList.output.schema, result)).toEqual([])
    }
    expect(service.subscribe).not.toHaveBeenCalled()
    expect(service.update).not.toHaveBeenCalled()
    expect(service.runDue).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(queueList.execute({ offset }, execution())).rejects.toThrow()
    }
  })
})
