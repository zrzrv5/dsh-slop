import { nativeAgentFixture } from './native-agent-fixture.ts'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  deliveryTriggerSchema,
  machineIdSchema,
  queueItemIdSchema,
  queueSessionTargetSchema,
  type QueueQueryRequest,
} from '../../queue/src/index.ts'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DshQueueRuntime, queueSessionTargetForAgent } from '../src/queue-runtime.ts'

function target(sessionId = 'session-zns'): ReturnType<typeof queueSessionTargetSchema.parse> {
  return queueSessionTargetSchema.parse({ sessionId, cwd: '/work/project', agentPreset: 'standard' })
}

function agent(sessionId = 'session-zns', cwd = '/work/project', agentPreset = 'standard') {
  return {
    id: sessionId,
    ctx: { sessionProjections: { stateOf: () => agentPreset } },
    session: {
      id: sessionId,
      header: { cwd, agentPreset },
      events: [],
      append: vi.fn(),
      deriveMessages: vi.fn(() => []),
    },
    followup: vi.fn(),
    inject: vi.fn(),
  } as unknown as Agent & { followup: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn>; session: { append: ReturnType<typeof vi.fn> } }
}

function request(overrides: Partial<QueueQueryRequest> = {}): QueueQueryRequest {
  return {
    batchId: 'batch-1',
    parent: target(),
    target: { kind: 'machine', machineId: machineIdSchema.parse('00000000-0000-7000-8000-000000000301') },
    observerKind: 'slurm',
    items: [{
      id: queueItemIdSchema.parse('queue-1'),
      label: 'ZnS relax',
      state: 'running',
      observer: { kind: 'slurm', jobId: '1234' },
      createdAt: '2026-09-01T12:00:00.000Z',
    }],
    prompt: 'Check Slurm job 1234 and return the structured observation.',
    ...overrides,
  }
}

describe('DSH Queue runtime', () => {

  it('disposes a published query worker when Queue closes without sending a parent notice', async () => {
    let finish!: (result: { stopReason: string }) => void
    const result = new Promise<{ stopReason: string }>(resolve => { finish = resolve })
    const dispose = vi.fn(async () => { finish({ stopReason: 'cancelled' }) })
    const startActivation = vi.fn(async () => ({ childId: 'query-worker', result, dispose }))
    const runtime = new DshQueueRuntime({ agents: { get: () => agent() }, subagents: { startActivation } } as unknown as Context)
    const query = runtime.query(request())
    const rejected = expect(query).rejects.toThrow('Queue runtime closed')
    await vi.waitFor(() => { expect(startActivation).toHaveBeenCalledOnce() })
    runtime.close()
    await rejected
    expect(dispose).toHaveBeenCalledOnce()
    expect(startActivation).toHaveBeenCalledWith(expect.objectContaining({ delivery: 'caller' }))
  })

  it('resumes persisted code targets with the migrated ptc preset without changing ownership', async () => {
    const parent = agent('session-zns', '/work/project', 'ptc')
    const mount = vi.fn(async () => {})
    const dispose = vi.fn(async () => {})
    const resume = vi.fn(async (options: { setup?: (ctx: Context) => Promise<void> }) => {
      await options.setup?.({} as Context)
      return { agent: parent, dispose }
    })
    const start = vi.fn(async () => ({ result: Promise.resolve({ stopReason: 'completed', structured: { observations: [] } }), dispose }))
    const ctx = { agents: { get: () => undefined, resume }, agentPresets: { mount }, subagents: { startActivation: start } } as unknown as Context
    const legacy = queueSessionTargetSchema.parse({ ...target(), agentPreset: 'code' })
    await new DshQueueRuntime(ctx).query(request({ parent: legacy, items: [] }))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'ptc')
    expect(legacy.agentPreset).toBe('code')
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ provider: 'spawn', delivery: 'caller', request: expect.objectContaining({ parent }) }))
  })

  it('delivers a passive update to a migrated ptc Chat from an old code target', async () => {
    const live = agent('session-zns', '/work/project', 'ptc')
    const flush = vi.fn(async () => true)
    const ctx = { agents: { get: () => live }, sessions: { flush } } as unknown as Context
    await new DshQueueRuntime(ctx).deliver({ target: { ...target(), agentPreset: 'code' }, delivery: 'notify', triggers: [] })
    expect(live.session.append).toHaveBeenCalledOnce()
    expect(live.session.append).toHaveBeenCalledWith('user/message', expect.objectContaining({ source: expect.objectContaining({ kind: 'dsh-slop-queue', plugin: 'dsh-slop-queue', form: 'notice' }) }), { surfaceOp: 'append' })
    expect(flush).toHaveBeenCalledWith(live.session)
    expect(live.inject).not.toHaveBeenCalled()
    expect(live.followup).not.toHaveBeenCalled()
  })

  it.each(['current', 'migrated', 'legacy-footer', 'migrated-legacy-footer'] as const)('puts a passive failure notice on the real idle Chat surface and deduplicates %s records', async format => {
    const host = new Context()
    await host.plugin(SessionStore)
    onTestFinished(async () => { await host.fiber.dispose() })
    const session = host.sessions.create(undefined, { meta: { cwd: '/work/project', agentPreset: 'standard' } })
    const idle = {
      id: String(session.id),
      ctx: { sessionProjections: { stateOf: () => 'standard' } },
      session,
      followup: vi.fn(),
      inject: vi.fn(),
    } as unknown as Agent
    const flush = vi.fn(async () => true)
    const trigger = deliveryTriggerSchema.parse({
      triggerKey: 'queue-failure:1:failed',
      queueItemId: 'queue-failure',
      label: 'Failed calculation',
      previousState: 'running',
      state: 'failed',
      observedAt: '2026-09-21T20:25:16.000Z',
      evidence: 'job 15859042: FAILED',
    })

    await new DshQueueRuntime({ agents: { get: () => idle }, sessions: { flush } } as unknown as Context).deliver({
      target: target(String(session.id)),
      delivery: 'notify',
      triggers: [trigger],
    })

    expect(session.deriveMessages()).toEqual([expect.objectContaining({
      role: 'user',
      source: expect.objectContaining({ plugin: 'dsh-slop-queue', form: 'notice' }),
      content: [{ type: 'text', text: expect.stringContaining('Failed calculation') }],
    })])
    expect(flush).toHaveBeenCalledWith(session)
    expect(idle.inject).not.toHaveBeenCalled()
    expect(idle.followup).not.toHaveBeenCalled()

    if (format !== 'current') {
      const messages = session.deriveMessages()
      vi.spyOn(session, 'deriveMessages').mockReturnValue(messages.map(message => ({
        ...message,
        ...(format.startsWith('migrated') ? { source: { kind: 'plugin:dsh-slop-queue', form: 'notice', summary: 'Failed calculation: failed' } } : {}),
        content: message.content.map(block => block.type === 'text' && format.endsWith('legacy-footer') ? {
          ...block, text: block.text.replace("beyond the user's existing authorization", 'unless the user asks'),
        } : block),
      })) as unknown as typeof messages)
    }
    const appendAgain = vi.spyOn(session, 'append')

    await new DshQueueRuntime({ agents: { get: () => idle }, sessions: { flush } } as unknown as Context).deliver({
      target: target(String(session.id)),
      delivery: 'notify',
      triggers: [trigger],
    })
    expect(session.deriveMessages()).toHaveLength(1)
    expect(appendAgain).not.toHaveBeenCalled()
    expect(flush).toHaveBeenCalledTimes(2)

    await new DshQueueRuntime({ agents: { get: () => idle }, sessions: { flush } } as unknown as Context).deliver({
      target: target(String(session.id)), delivery: 'notify',
      triggers: [{ ...trigger, triggerKey: 'queue-failure:2:failed', observedAt: '2026-09-21T20:30:00.000Z' }],
    })
    expect(appendAgain).toHaveBeenCalledOnce()
  })

  it('captures the current Chat cwd and resolved preset as durable ownership', () => {
    expect(queueSessionTargetForAgent(agent())).toEqual({
      sessionId: 'session-zns',
      cwd: '/work/project',
      agentPreset: 'standard',
    })
  })

  it('starts a fresh short-context remote query worker under the exact primary Chat', async () => {
    const parent = agent()
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      result: Promise.resolve({
        stopReason: 'completed',
        output: [],
        structured: {
          observations: [{
            queueItemId: 'queue-1',
            state: 'running',
            observedAt: '2026-09-01T12:01:00.000Z',
            evidence: 'squeue: RUNNING',
          }],
        },
      }),
      dispose,
    }))
    const ctx = {
      agents: { get: vi.fn(() => parent) },
      subagents: { startActivation: start },
    } as unknown as Context
    const runtime = new DshQueueRuntime(ctx)
    const result = await runtime.query(request())
    expect(result).toMatchObject({ observations: [{ queueItemId: 'queue-1', state: 'running' }] })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'spawn', delivery: 'caller',
      request: expect.objectContaining({
      cwd: '/work/project', parent,
      prompt: [{ type: 'text', text: expect.stringContaining('Check Slurm job 1234') }],
      agentPreset: 'slop-queue-query-machine',
      outputSchema: expect.objectContaining({ type: 'object' }),
      }),
    }))
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('cold-resumes the exact owner preset for a query and releases only its owned handle', async () => {
    const parent = agent()
    const disposeParent = vi.fn(async () => {})
    const mount = vi.fn(async () => {})
    const resume = vi.fn(async (options: { setup?: (ctx: Context) => Promise<void> }) => {
      await options.setup?.({} as Context)
      return { agent: parent, dispose: disposeParent }
    })
    const disposeRun = vi.fn(async () => {})
    const ctx = {
      agents: { get: vi.fn(() => undefined), resume },
      agentPresets: { mount },
      subagents: {
        startActivation: vi.fn(async () => ({
          result: Promise.resolve({ stopReason: 'completed', output: [], structured: { observations: [] } }),
          dispose: disposeRun,
        })),
      },
    } as unknown as Context
    const runtime = new DshQueueRuntime(ctx)
    await runtime.query(request({ items: [] }))
    expect(mount).toHaveBeenCalledWith(expect.anything(), 'standard')
    expect(disposeRun).toHaveBeenCalledTimes(1)
    expect(disposeParent).toHaveBeenCalledTimes(1)
  })

  it('refuses to attach a query worker to a live Chat with stale cwd or preset identity', async () => {
    const start = vi.fn()
    const ctx = {
      agents: { get: vi.fn(() => agent('session-zns', '/wrong/project')) },
      subagents: { startActivation: start },
    } as unknown as Context
    const runtime = new DshQueueRuntime(ctx)
    await expect(runtime.query(request())).rejects.toThrow(/stored cwd and preset/)
    expect(start).not.toHaveBeenCalled()
  })

  it('cold-activates only the target Chat and uses followup for wake or durable append for passive notify', async () => {
    const { agent: targetAgent } = await nativeAgentFixture('/work/project')
    let release!: () => void
    const held = targetAgent.runMaintenance(() => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    onTestFinished(async () => { targetAgent.inbox.clear(); release(); await held })
    const followup = vi.spyOn(targetAgent, 'followup')
    const append = vi.spyOn(targetAgent.session, 'append')
    let live: Agent | undefined
    const create = vi.fn(async () => {
      live = targetAgent
      return { rpcId: 'rpc-1', result: { ok: true, value: { sessionId: 'session-napso', agentPreset: 'standard' } } }
    })
    const ctx = {
      agents: { get: vi.fn(() => live) },
      sessions: { flush: vi.fn(async () => true) },
      sessionController: { create },
    } as unknown as Context
    const runtime = new DshQueueRuntime(ctx)
    const trigger = deliveryTriggerSchema.parse({
      triggerKey: 'queue-1:2:completed',
      queueItemId: 'queue-1',
      label: 'Campaign relaxation',
      previousState: 'running',
      state: 'completed',
      observedAt: '2026-09-01T12:10:00.000Z',
      evidence: 'sacct: COMPLETED',
    })
    await runtime.deliver({ target: target(String(targetAgent.session.id)), delivery: 'wake', triggers: [trigger] })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: String(targetAgent.session.id), cwd: '/work/project', agentPreset: 'standard',
    }))
    expect(targetAgent.followup).toHaveBeenCalledTimes(1)
    expect(followup.mock.calls[0]?.[0]).toMatchObject({
      source: { kind: 'dsh-slop-queue', plugin: 'dsh-slop-queue', form: 'notice' },
      content: [{ type: 'text', text: expect.stringContaining('Full probe evidence remains in Queue Ledger.') }],
    })

    await runtime.deliver({ target: target(String(targetAgent.session.id)), delivery: 'notify', triggers: [trigger] })
    expect(create).toHaveBeenCalledTimes(1)
    expect(append.mock.calls.filter(call => call[0] === 'user/message')).toHaveLength(1)
  })
})
