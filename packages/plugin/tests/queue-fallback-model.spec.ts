import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { machineIdSchema, queueItemIdSchema, queueSessionTargetSchema, type QueueQueryRequest } from '../../queue/src/index.ts'
import { describe, expect, it, vi } from 'vitest'
import { Config, fallbackAgentOptions, type QueueConfig } from '../src/queue-entry.ts'
import { DshQueueRuntime } from '../src/queue-runtime.ts'

const target = queueSessionTargetSchema.parse({ sessionId: 'session-zns', cwd: '/work/project', agentPreset: 'standard' })
const parent = { id: 'session-zns', ctx: { sessionProjections: { stateOf: () => 'standard' } }, session: { id: 'session-zns', header: { cwd: '/work/project', agentPreset: 'standard' } } } as unknown as Agent

const request: QueueQueryRequest = {
  batchId: 'batch-1',
  parent: target,
  target: { kind: 'machine', machineId: machineIdSchema.parse('00000000-0000-7000-8000-000000000301') },
  observerKind: 'slurm',
  items: [{ id: queueItemIdSchema.parse('queue-1'), label: 'ZnS relax', state: 'running', observer: { kind: 'slurm', jobId: '1234' }, createdAt: '2026-09-01T12:00:00.000Z' }],
  prompt: 'Check Slurm job 1234 and return the structured observation.',
}

/** Run one fallback check and return the request that reached `subagents.startActivation`. */
async function startRequest(reader?: () => AgentOptions | undefined): Promise<SubagentActivationSpec['request']> {
  const dispose = vi.fn(async () => {})
  const start = vi.fn(async (_spec: SubagentActivationSpec) => ({ result: Promise.resolve({ stopReason: 'completed', structured: { observations: [] } }), dispose }))
  const ctx = { agents: { get: () => parent }, subagents: { startActivation: start } } as unknown as Context
  await new DshQueueRuntime(ctx, reader === undefined ? {} : { fallbackAgentOptions: reader }).query(request)
  expect(start).toHaveBeenCalledOnce()
  const spec = start.mock.calls[0]?.[0]
  if (spec === undefined) throw new Error('Expected a worker activation')
  expect(spec.provider).toBe('spawn')
  expect(spec.delivery).toBe('caller')
  expect(spec.request.agentPreset).toBe('slop-queue-query-machine')
  return spec.request
}

const volatile = (value: string) => ({ get: () => value })
const settings = (provider: string, model: string, effort: string) => ({ fallbackProvider: volatile(provider), fallbackModel: volatile(model), fallbackReasoningEffort: volatile(effort) })

describe('Queue fallback model route', () => {
  it('passes the configured provider, model and reasoning effort to the fallback worker', async () => {
    const started = await startRequest(() => fallbackAgentOptions(settings('cheap', 'small', 'low')))
    expect(started.agentOptions).toEqual({ provider: 'cheap', model: 'small', reasoningEffort: ReasoningEffortId('low') })
  })

  it('omits the reasoning effort when it is empty', async () => {
    const started = await startRequest(() => fallbackAgentOptions(settings('cheap', 'small', '  ')))
    expect(started.agentOptions).toEqual({ provider: 'cheap', model: 'small' })
    expect(started.agentOptions).not.toHaveProperty('reasoningEffort')
  })

  it.each([
    ['provider', settings('', 'small', 'low'), 1],
    ['model', settings('cheap', '', 'low'), 1],
    ['provider and model', settings('', '', 'low'), 0],
  ])('uses the Chat route without agentOptions when the %s is empty', async (_missing, values, warnings) => {
    const onPartial = vi.fn()
    const started = await startRequest(() => fallbackAgentOptions(values, onPartial))
    expect(started).not.toHaveProperty('agentOptions')
    expect(onPartial).toHaveBeenCalledTimes(warnings)
  })

  it('uses the Chat route when no reader is configured', async () => {
    expect(await startRequest()).not.toHaveProperty('agentOptions')
  })

  it('reads the settings again on every fallback check', async () => {
    let model = 'small'
    const reader = () => fallbackAgentOptions(settings('cheap', model, ''))
    expect((await startRequest(reader)).agentOptions).toEqual({ provider: 'cheap', model: 'small' })
    model = 'tiny'
    expect((await startRequest(reader)).agentOptions).toEqual({ provider: 'cheap', model: 'tiny' })
  })
})

describe('Queue entry config', () => {
  it('keeps the shared fields and adds three empty volatile fallback settings', () => {
    const config: QueueConfig = Config({ productHome: '/home/slop', dataRoot: '/home/slop/slop' })
    expect(config.productHome).toBe('/home/slop')
    expect(config.dataRoot).toBe('/home/slop/slop')
    expect(config.trustedBrowserHosts).toEqual([])
    for (const key of ['fallbackProvider', 'fallbackModel', 'fallbackReasoningEffort'] as const) expect(config[key].get()).toBe('')
  })
})
