import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Capability sections named `slop:*` are collected into one labeled block. */
export const SLOP_SECTION_PREFIX = 'slop:'
export const SLOP_BLOCK_SECTION = 'slop:block'
/** The Agent behavior preferences; rendered last inside the block, after the Goal rules. */
export const BEHAVIOR_SECTION = 'slop:behavior'
const GOAL_SECTION = 'tool:goal'
const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'

const HEADER = `<dsh-slop>
DSH-SLOP is a plugin for work on remote machines and HPC clusters. These rules apply only to its tools (slop_*), its Skills, and the changes named below. Everything outside this block is the harness's default behavior.`

const GOAL_RULES = `Goals (DSH-SLOP replaces the harness default): only the user creates a Goal, through the Goal control or /goal <objective>. If the user asks for one in conversation, point them there and continue the authorized task. A cleared Goal stays cleared until the user creates another. Before changing an existing Goal, read its current goal_id and revision, and edit or resume it only at the user's explicit request. Mark a Goal complete only when its objective is achieved, and report a blocker only as the tool's blocking policy allows.`

/**
 * Gather every DSH-SLOP rule into one labeled block placed after the harness
 * sections, so a model can tell plugin rules from harness defaults. The block
 * also carries the Goal override that replaces the harness's `tool:goal` text,
 * and ends with the user's behavior preferences.
 */
export function registerSlopPromptBlock(ctx: Context): () => void {
  return ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    const owned = assembly.sections.filter(section => section.name.startsWith(SLOP_SECTION_PREFIX) && section.text.trim() !== '')
    const hasGoal = assembly.sections.some(section => section.name === GOAL_SECTION)
    if (owned.length === 0 && !hasGoal) return assembly

    const behavior = owned.filter(section => section.name === BEHAVIOR_SECTION)
    const rules = owned.filter(section => section.name !== BEHAVIOR_SECTION)
    const lines = [
      ...rules.map(section => section.text),
      ...(hasGoal ? [GOAL_RULES] : []),
      ...behavior.map(section => section.text),
    ]
    const block = { name: SLOP_BLOCK_SECTION, text: [HEADER, ...lines, '</dsh-slop>'].join('\n') }

    assembly.sections = assembly.sections.filter(section => !section.name.startsWith(SLOP_SECTION_PREFIX) && section.name !== GOAL_SECTION)
    const suffix = assembly.sections.findIndex(section => section.name === PERSONA_SUFFIX_SECTION)
    assembly.sections.splice(suffix < 0 ? assembly.sections.length : suffix, 0, block)
    return assembly
  })
}
