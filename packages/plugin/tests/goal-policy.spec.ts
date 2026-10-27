import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import * as goalCommand from '@deepseek-ai/dsh-command-goal'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { GoalService } from '@deepseek-ai/dsh-goal'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerGoalPolicy } from '@dsh-slop/runtime-base/goal-policy'
import { registerSlopPromptBlock } from '@dsh-slop/runtime-base/prompt-block'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(GoalService)
  await ctx.plugin(goalCommand)
  const create = vi.fn(async () => true)
  ctx.tools.register(defineTool({
    name: 'create_goal', description: 'Infer goal intent from long-running work.',
    parameters: {}, output: { schema: { type: 'boolean' }, render: value => [{ type: 'text', text: String(value) }] }, execute: create,
  }))
  ctx.tools.register(defineTool({
    name: 'get_goal', description: 'Read the goal.',
    parameters: {}, output: { schema: { type: 'boolean' }, render: value => [{ type: 'text', text: String(value) }] }, execute: async () => true,
  }))
  ctx.tools.register(defineTool({
    name: 'update_goal', description: 'Update the goal.',
    parameters: {}, output: { schema: { type: 'boolean' }, render: value => [{ type: 'text', text: String(value) }] }, execute: async () => true,
  }))
  ctx.systemPrompt.section({ name: 'tool:goal', order: 2400, text: 'create_goal may infer goal intent from a direct human request.' })
  ctx.systemPrompt.section({ name: 'tool:ralph', order: 2700, text: 'Use ralph only on request. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.' })

  // Only the model-driving methods are inert. Session, Goal, command, scope,
  // prompt, and tool behavior all use the released upstream implementations.
  const session = ctx.sessions.create()
  const agent: Agent = {
    id: session.id, session, options: {}, status: 'idle',
    get ctx() { return scope.ctx },
    inbox: {
      nextTurn: [], nextStep: [], clear: vi.fn(), append: vi.fn(), prepend: vi.fn(),
      replace: () => false, remove: () => false, splice: () => [],
    },
    cancel: vi.fn(), whenIdle: async () => {},
    runMaintenance: async task => await task(new AbortController().signal),
    send: vi.fn(), followup: vi.fn(), steer: vi.fn(), deferContext: vi.fn(),
  }
  const scope = createScope(ctx, agent)
  const unregister = ctx.agents.register(agent)
  let callNumber = 0
  const call = (name: string) => ctx.tools.execute({
    callId: ToolCallId(`goal-policy-${++callNumber}`), name, arguments: {},
    agent, signal: new AbortController().signal,
  })
  const command = (line: string) => ctx.commands.execute(agent, line, [], new AbortController().signal)
  return { ctx, agent, scope, create, call, command, unregister }
}

describe('explicit Goal opt-in', () => {
  it('blocks model creation and preserves human create, clear, and a new explicit opt-in', async () => {
    const f = await fixture()
    const dispose = registerGoalPolicy(f.ctx)
    onTestFinished(dispose)
    expect(f.ctx.tools.schemas(f.agent).map(tool => tool.name)).toEqual(['get_goal', 'update_goal'])
    expect((await f.call('create_goal')).isError).toBe(true)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.ctx.goals.get(f.agent)).toBeUndefined()

    await f.command('/goal Prepare the requested result')
    expect(f.ctx.goals.get(f.agent)).toMatchObject({ objective: 'Prepare the requested result', phase: 'active', activation: 'armed' })
    await f.command('/goal clear')
    expect(f.ctx.goals.get(f.agent)).toBeUndefined()
    // A later ordinary request cannot recreate a goal from a stale tool call.
    expect((await f.call('create_goal')).isError).toBe(true)
    expect(f.ctx.goals.get(f.agent)).toBeUndefined()
    await f.command('/goal Explicitly requested second goal')
    expect(f.ctx.goals.get(f.agent)?.objective).toBe('Explicitly requested second goal')
    expect((await f.call('get_goal')).error).toBeUndefined()
    expect(await f.call('update_goal')).toMatchObject({ isError: false })
  })

  it('removes inferred-Goal advice from the assembled prompt and leaves unrelated guidance intact', async () => {
    const f = await fixture()
    onTestFinished(registerGoalPolicy(f.ctx))
    onTestFinished(registerSlopPromptBlock(f.ctx))
    const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent, agent: f.agent }))
    expect(prompt).toContain('/goal <objective>')
    expect(prompt).toContain('A cleared Goal stays cleared')
    expect(prompt).not.toContain('may infer goal intent')
    expect(prompt).not.toContain('goal tools for ordinary long-running objectives')
    expect(prompt).toContain('Use ralph only on request.')
  })

  it('applies the same restriction to the generated PTC catalog', async () => {
    const f = await fixture()
    // Prompt generation needs the language only; this test executes no code.
    f.ctx.provide('ptcRuntime', { language: 'typescript' })
    f.scope.ctx.get('tools')?.presentAs('ptc')
    onTestFinished(registerGoalPolicy(f.ctx))
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent, agent: f.agent })
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    expect(sdk).toContain('get_goal')
    expect(sdk).toContain('update_goal')
    expect(sdk).not.toContain('create_goal')
  })

  it('guards late registrations and releases all policy hooks on disposal', async () => {
    const f = await fixture()
    f.unregister()
    const dispose = registerGoalPolicy(f.ctx)
    // Before agent publication, the inherited definition still exists. The
    // monotonic guard must reject it even if a pre-execute listener allows it.
    f.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    expect((await f.call('create_goal')).isError).toBe(true)
    expect(f.create).not.toHaveBeenCalled()
    f.ctx.agents.register(f.agent)
    expect(f.ctx.tools.get('create_goal', f.agent)).toBeUndefined()
    dispose()
    expect((await f.call('create_goal')).error).toBeUndefined()
    expect(f.create).toHaveBeenCalledOnce()
    expect(renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }))).toContain('may infer goal intent')
  })
})
