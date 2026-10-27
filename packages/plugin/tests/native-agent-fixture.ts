import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { onTestFinished } from 'vitest'
import { registerQueueDeliveryProjection } from '../src/queue-delivery-projection.ts'


export async function nativeAgentFixture(cwd = '/tmp', persistence?: { root: string; resume?: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  if (persistence !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: persistence.root, compression: 'none' })
  await ctx.plugin(AgentLoop)
  ctx.sessionProjections.register({ key: 'agentPreset', stateVersion: 1, stateSchema: z.string().nullable(), init: () => 'standard', apply: state => state })
  registerQueueDeliveryProjection(ctx)
  const owned = persistence?.resume === true ? await ctx.agents.resume({ resumeSessionId: SessionId('queue-inbox-proof') }) : await ctx.agents.create({ sessionId: SessionId('queue-inbox-proof'), meta: { cwd, agentPreset: 'standard' } })
  onTestFinished(async () => { await owned.dispose(); await ctx.fiber.dispose() })
  return { ctx, agent: owned.agent, dispose: async () => { await owned.dispose(); await ctx.fiber.dispose() } }
}
