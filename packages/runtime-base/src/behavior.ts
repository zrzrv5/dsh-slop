import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { BEHAVIOR_TRAITS, behaviorPromptKey, normalizeBehaviorLevels, renderBehaviorPrompt, type BehaviorLevels, type BehaviorPromptOverrides, type BehaviorTraitId } from './behavior-catalog.ts'
import { BEHAVIOR_SECTION } from './prompt-block.ts'

/** The stored behavior selection, possibly holding stale or unknown values. */
export interface BehaviorSelection {
  readonly levels: Partial<Record<BehaviorTraitId, unknown>>
  readonly overrides: Readonly<Record<string, unknown>>
}

const OVERRIDE_KEYS: ReadonlySet<string> = new Set(BEHAVIOR_TRAITS.flatMap(trait => trait.levels.map(level => behaviorPromptKey(trait.id, level.id))))

/** Keep only non-empty string overrides whose key names a known `<trait>.<level>`. */
export function knownBehaviorOverrides(overrides: Readonly<Record<string, unknown>>): BehaviorPromptOverrides {
  return Object.fromEntries(Object.entries(overrides).filter((entry): entry is [string, string] => OVERRIDE_KEYS.has(entry[0]) && typeof entry[1] === 'string' && entry[1].trim() !== ''))
}

/** The prompt text for a stored selection; unknown levels use the trait default and unknown overrides are ignored. */
export function behaviorPromptFor(selection: BehaviorSelection): string {
  const levels: BehaviorLevels = normalizeBehaviorLevels(selection.levels)
  return renderBehaviorPrompt(levels, knownBehaviorOverrides(selection.overrides))
}

/**
 * Give each Agent the behavior text selected when it starts. A later change
 * applies to Agents created afterwards, so a running Chat keeps a stable
 * prompt prefix. One global section resolves its text from the assembling Agent.
 */
export function registerBehavior(ctx: Context, read: () => BehaviorSelection): () => void {
  const texts = new WeakMap<object, string>()
  const attach = (agent: Agent): void => { if (!texts.has(agent)) texts.set(agent, behaviorPromptFor(read())) }
  const offSection = ctx.systemPrompt.section({
    name: BEHAVIOR_SECTION,
    order: 530,
    text: assembly => (assembly.scope === undefined ? undefined : texts.get(assembly.scope)) ?? '',
  })
  const offCreated = ctx.on('agent/created', ({ agent }) => { attach(agent) })
  for (const agent of ctx.agents.list()) attach(agent)
  return () => {
    offCreated()
    offSection()
  }
}
