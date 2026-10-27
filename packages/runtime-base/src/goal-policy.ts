import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

const CREATE_GOAL_DENIAL = 'Model-driven Goal creation is disabled; explicit opt-in uses the Goal control or /goal <objective>.'

/**
 * Keep upstream Goals available through explicit human controls, not inferred model intent.
 * The prompt side of this policy lives in the DSH-SLOP prompt block.
 */
export function registerGoalPolicy(ctx: Context): () => void {
  const restrictions = new Map<Agent, () => void>()
  const restrictCreation = (agent: Agent): void => {
    if (restrictions.has(agent) || ctx.tools.get('create_goal', agent) === undefined) return
    const tools = agent.ctx.get('tools')
    if (tools === undefined) throw new Error('Goal policy requires the agent Tool registry')
    restrictions.set(agent, tools.restrict({ deny: ['create_goal'] }))
  }
  const releaseAgent = (agent: Agent): void => {
    restrictions.get(agent)?.()
    restrictions.delete(agent)
  }

  // A guard also covers stale native calls, nested PTC calls, and calls made
  // before an agent's inherited catalog has been restricted.
  const offGuard = ctx.tools.guard(execution => execution.name === 'create_goal' ? CREATE_GOAL_DENIAL : undefined)
  const offCreated = ctx.on('agent/created', ({ agent }) => { restrictCreation(agent) })
  const offDisposed = ctx.on('agent/disposed', ({ agent }) => { releaseAgent(agent) })
  const offPrompt = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    for (const section of assembly.sections) {
      if (section.name === 'tool:ralph') {
        section.text = section.text.replace(
          'Use same-session goal tools for ordinary long-running objectives, and ',
          'Use ',
        )
      }
    }
    return assembly
  })
  for (const agent of ctx.agents.list()) restrictCreation(agent)

  return () => {
    offPrompt()
    offDisposed()
    offCreated()
    offGuard()
    for (const release of restrictions.values()) release()
    restrictions.clear()
  }
}
