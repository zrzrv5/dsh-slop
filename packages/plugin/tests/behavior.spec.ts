import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { registerBehavior, type BehaviorSelection } from '@dsh-slop/runtime-base/behavior'
import { BEHAVIOR_PREAMBLE, BEHAVIOR_TRAITS, DEFAULT_BEHAVIOR_LEVELS, behaviorLevelText, type BehaviorLevels } from '@dsh-slop/runtime-base/behavior-catalog'
import { registerSlopPromptBlock } from '@dsh-slop/runtime-base/prompt-block'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.systemPrompt.section({ name: 'slop:queue', order: 515, text: 'Queue rule.' })
  const agents: Agent[] = []
  const start = async (): Promise<Agent> => {
    const session = ctx.sessions.create()
    const agent: Agent = {
      id: session.id, session, options: {}, status: 'idle',
      get ctx() { return scope.ctx },
      inbox: { nextTurn: [], nextStep: [], clear: vi.fn(), append: vi.fn(), prepend: vi.fn(), replace: () => false, remove: () => false, splice: () => [] },
      cancel: vi.fn(), whenIdle: async () => {},
      runMaintenance: async task => await task(new AbortController().signal),
      send: vi.fn(), followup: vi.fn(), steer: vi.fn(), deferContext: vi.fn(),
    }
    const scope = createScope(ctx, agent)
    onTestFinished(ctx.agents.register(agent))
    agents.push(agent)
    // Creation listeners run serially after registration; a started Agent has finished them.
    await new Promise(resolve => setTimeout(resolve, 0))
    return agent
  }
  const prompt = async (agent: Agent) => renderPrompt(await ctx.systemPrompt.assemble({ scope: agent, agent }))
  return { ctx, start, prompt }
}

describe('Agent behavior preferences', () => {
  it('gives each Agent the behavior selected when it starts and leaves running Agents unchanged', async () => {
    const f = await fixture()
    let levels: BehaviorLevels = DEFAULT_BEHAVIOR_LEVELS
    onTestFinished(registerBehavior(f.ctx, () => ({ levels, overrides: {} })))
    onTestFinished(registerSlopPromptBlock(f.ctx))

    const first = await f.start()
    levels = { ...DEFAULT_BEHAVIOR_LEVELS, followThrough: 'autonomous', errors: 'stop' }
    const second = await f.start()

    const before = await f.prompt(first)
    expect(before).toContain(behaviorLevelText('followThrough', 'authorized'))
    expect(before).toContain(behaviorLevelText('errors', 'triage'))
    expect(before).not.toContain(behaviorLevelText('followThrough', 'autonomous'))
    const after = await f.prompt(second)
    expect(after).toContain(behaviorLevelText('followThrough', 'autonomous'))
    expect(after).toContain(behaviorLevelText('errors', 'stop'))
  })

  it('opens with the precedence preamble and renders one paragraph per trait in catalog order', async () => {
    const f = await fixture()
    onTestFinished(registerBehavior(f.ctx, () => ({ levels: DEFAULT_BEHAVIOR_LEVELS, overrides: {} })))
    onTestFinished(registerSlopPromptBlock(f.ctx))
    const prompt = await f.prompt(await f.start())

    const positions = [BEHAVIOR_PREAMBLE, ...BEHAVIOR_TRAITS.map(trait => behaviorLevelText(trait.id, trait.defaultLevel))].map(paragraph => prompt.indexOf(paragraph))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('uses an override only for the selected level it names and ignores unknown or empty entries', async () => {
    const f = await fixture()
    let selection: BehaviorSelection = {
      levels: DEFAULT_BEHAVIOR_LEVELS,
      overrides: { 'errors.triage': 'Errors: custom triage text.', 'errors.stop': 'Errors: custom stop text.', 'scope.strict': '  ', 'nonsense.key': 'Injected text.' },
    }
    onTestFinished(registerBehavior(f.ctx, () => selection))
    onTestFinished(registerSlopPromptBlock(f.ctx))

    const prompt = await f.prompt(await f.start())
    expect(prompt).toContain('Errors: custom triage text.')
    expect(prompt).not.toContain(behaviorLevelText('errors', 'triage'))
    expect(prompt).not.toContain('Errors: custom stop text.')
    expect(prompt).toContain(behaviorLevelText('scope', 'strict'))
    expect(prompt).not.toContain('Injected text.')

    selection = { ...selection, levels: { ...DEFAULT_BEHAVIOR_LEVELS, errors: 'stop' } }
    expect(await f.prompt(await f.start())).toContain('Errors: custom stop text.')
  })

  it('falls back to the trait default for an unknown stored level', async () => {
    const f = await fixture()
    onTestFinished(registerBehavior(f.ctx, () => ({ levels: { ...DEFAULT_BEHAVIOR_LEVELS, followThrough: 'reckless', reporting: undefined }, overrides: {} })))
    onTestFinished(registerSlopPromptBlock(f.ctx))

    const prompt = await f.prompt(await f.start())
    expect(prompt).toContain(behaviorLevelText('followThrough', 'authorized'))
    expect(prompt).toContain(behaviorLevelText('reporting', 'standard'))
  })

  it('places the behavior text last inside the labeled block and drops it when disposed', async () => {
    const f = await fixture()
    const off = registerBehavior(f.ctx, () => ({ levels: DEFAULT_BEHAVIOR_LEVELS, overrides: {} }))
    onTestFinished(registerSlopPromptBlock(f.ctx))
    const agent = await f.start()

    const prompt = await f.prompt(agent)
    const block = prompt.slice(prompt.indexOf('<dsh-slop>'), prompt.indexOf('</dsh-slop>'))
    expect(block.indexOf('Queue rule.')).toBeLessThan(block.indexOf(BEHAVIOR_PREAMBLE))
    expect(block).toContain('Reporting:')
    off()
    const disposed = await f.prompt(agent)
    expect(disposed).not.toContain(BEHAVIOR_PREAMBLE)
    expect(disposed).not.toContain('Follow-through:')
  })

  it('keeps every default text free of approval bypass wording', () => {
    for (const trait of BEHAVIOR_TRAITS) {
      for (const level of trait.levels) expect(level.text).not.toMatch(/without (asking|approval)[^.]*\b(destructive|risky|delete)/iu)
    }
    expect(behaviorLevelText('followThrough', 'autonomous')).toContain('needs approval')
  })
})
