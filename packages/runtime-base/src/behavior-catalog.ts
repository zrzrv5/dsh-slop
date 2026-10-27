/**
 * The Agent behavior catalog: six traits, each with a few levels, each level
 * one short paragraph of system-prompt text that the user may edit. This file
 * is pure data plus pure functions so the Host and the browser share one copy.
 *
 * Project and user instructions always win over these preferences; the
 * preamble says so in the prompt itself.
 */

export type BehaviorTraitId = 'followThrough' | 'errors' | 'verification' | 'checking' | 'scope' | 'reporting'

export interface BehaviorLevel {
  readonly id: string
  /** Short option label for a select control. */
  readonly label: string
  /** One sentence for the settings UI; not sent to the model. */
  readonly description: string
  /** Default prompt paragraph for this level; user overrides replace it. */
  readonly text: string
}

export interface BehaviorTrait {
  readonly id: BehaviorTraitId
  readonly label: string
  /** What the trait decides, for the settings UI. */
  readonly description: string
  readonly levels: readonly BehaviorLevel[]
  readonly defaultLevel: string
}

/** Precedence line that opens the behavior paragraphs in the prompt. */
export const BEHAVIOR_PREAMBLE = 'Behavior preferences (set in DSH-SLOP Settings). Project and user instructions such as AGENTS.md, CLAUDE.md, Skills, and what the user says in this Chat take precedence over these whenever they conflict.'

export const BEHAVIOR_TRAITS: readonly BehaviorTrait[] = [
  {
    id: 'followThrough',
    label: 'Follow-through',
    description: 'How far an Agent carries a multi-step request before it stops to ask.',
    defaultLevel: 'authorized',
    levels: [
      {
        id: 'confirm',
        label: 'Ask before each step',
        description: 'Do what I asked, then stop and report. Ask before any step I did not request.',
        text: 'Follow-through: do what the user asked, then stop and report. Ask before starting any step the user did not explicitly request, including the next stage of a multi-stage task.',
      },
      {
        id: 'authorized',
        label: 'Finish what I asked',
        description: 'Complete the steps I asked for, including ones that wait on a running job, without asking whether to continue.',
        text: 'Follow-through: complete the steps the user asked for, including steps that wait on a running job, without asking whether to continue. Stop to ask only when a decision changes the outcome, an action needs approval, or you are blocked. Do not end a turn with a menu of optional next steps.',
      },
      {
        id: 'autonomous',
        label: 'Keep going',
        description: 'Start the next stage that follows from my goal without waiting for permission. Risky or destructive actions still need approval.',
        text: 'Follow-through: keep working toward the objective the user stated. When one stage finishes, start the next stage that follows from it without waiting for permission, and put status notes in the same message as your next tool call. Stop only when nothing can advance without the user, or when an action needs approval because it is risky, destructive, or spends compute the user did not ask for. Do not end a turn by offering to continue.',
      },
    ],
  },
  {
    id: 'errors',
    label: 'Errors',
    description: 'What an Agent does when a step fails.',
    defaultLevel: 'triage',
    levels: [
      {
        id: 'stop',
        label: 'Stop and report',
        description: 'Stop at the first failure and tell me what failed and what was tried.',
        text: 'Errors: when a step fails, stop. Report what failed, what you tried, and the evidence, then wait for the user.',
      },
      {
        id: 'triage',
        label: 'Fix small, report deep',
        description: 'Spend a bounded effort to find the cause. Fix small local problems; stop and report deep or unclear ones.',
        text: 'Errors: when a step fails, spend a bounded effort to find the cause. Fix a small, local problem and continue; for a deep or unclear one, stop and report with evidence rather than guessing.',
      },
      {
        id: 'resolve',
        label: 'Resolve it',
        description: 'Keep working until the problem is fixed or clearly impossible, without losing the original request.',
        text: 'Errors: when a step fails, keep working until it is fixed or clearly impossible. After each fix, re-read the original request and continue toward it; do not drift into side problems or change what was asked.',
      },
    ],
  },
  {
    id: 'verification',
    label: 'Before real runs',
    description: 'Whether an Agent tests or dry-runs before starting or submitting real work.',
    defaultLevel: 'when-new',
    levels: [
      {
        id: 'always',
        label: 'Always test first',
        description: 'Do a dry run or a small test before every real run when one exists.',
        text: 'Before real runs: before submitting or starting real work, do a dry run or a small test when one exists, read its result, then run the full job the same way.',
      },
      {
        id: 'when-new',
        label: 'Test when new or changed',
        description: 'Test first when the command, script or workflow is new to this project or has changed; reuse proven ones directly.',
        text: 'Before real runs: test first when the command, script or workflow is new to this project or has changed; when it has already run successfully in this form, reuse it without a test.',
      },
      {
        id: 'direct',
        label: 'Run directly when confident',
        description: 'Start the real job directly when inputs and workflow are known good; test only when asked or when a wrong run is expensive.',
        text: 'Before real runs: when the inputs and the workflow are known good, start the real job directly; test only when the user asks or a wrong run would be expensive.',
      },
    ],
  },
  {
    id: 'checking',
    label: 'Checking',
    description: 'How much an Agent re-verifies settled facts and gathers context before it acts.',
    defaultLevel: 'proportionate',
    levels: [
      {
        id: 'lean',
        label: 'Trust settled facts',
        description: 'Reuse what was already read or run; gather only the context needed to act; verify once at the end.',
        text: 'Checking: trust what you have already read or run in this session unless something changed it. Gather only the context you need to act, verify once after the final change, and stop when the result is confirmed instead of re-checking it.',
      },
      {
        id: 'proportionate',
        label: 'Match checks to the stakes',
        description: 'Re-verify when something may have changed or a wrong result is costly; otherwise move on.',
        text: 'Checking: match checks to the stakes. Re-verify when a file, job or environment may have changed since you read it, or when a wrong result would be costly; otherwise trust settled facts and move on.',
      },
      {
        id: 'thorough',
        label: 'Verify before relying',
        description: 'Re-read and re-check state before each dependent step; confirm results from more than one source when possible.',
        text: 'Checking: verify before relying on anything. Re-read files and re-check state before each dependent step, and confirm results from more than one source when possible.',
      },
    ],
  },
  {
    id: 'scope',
    label: 'Scope and conventions',
    description: 'How closely an Agent sticks to the request and to the project\'s existing scripts and conventions.',
    defaultLevel: 'strict',
    levels: [
      {
        id: 'strict',
        label: 'Only what I asked',
        description: 'Use existing scripts, layouts and conventions. Change only what the request names; mention anything else instead of changing it.',
        text: 'Scope: use the project\'s existing scripts, layouts and conventions. Change only what the request names; if something else should change, say so instead of changing it.',
      },
      {
        id: 'improve',
        label: 'Fix small things on the way',
        description: 'Prefer existing conventions, but fix small adjacent problems and name every unrequested change.',
        text: 'Scope: prefer the project\'s existing conventions, and fix small adjacent problems you meet on the way. Name every change the user did not ask for in your report.',
      },
    ],
  },
  {
    id: 'reporting',
    label: 'Reporting',
    description: 'How much an Agent narrates while it works.',
    defaultLevel: 'standard',
    levels: [
      {
        id: 'brief',
        label: 'Result only',
        description: 'One report at the end: the result, where it is, and anything left undone.',
        text: 'Reporting: report once at the end with the result, where it is, and anything left undone. Skip progress notes.',
      },
      {
        id: 'standard',
        label: 'Stage notes',
        description: 'A short factual note when a stage starts or ends or the plan changes.',
        text: 'Reporting: write a short note when a stage starts or ends and when the plan changes. Keep notes factual and in the same message as your next action.',
      },
      {
        id: 'detailed',
        label: 'Narrate each step',
        description: 'Say what was run, observed and decided at each step so the work can be audited later.',
        text: 'Reporting: narrate each step with what you ran, what you observed, and what you decided, so the user can audit the work afterwards.',
      },
    ],
  },
]

/** The selected level id for every trait. */
export type BehaviorLevels = Readonly<Record<BehaviorTraitId, string>>

/** User prompt-text overrides keyed `<trait>.<level>`; an absent or empty entry keeps the default text. */
export type BehaviorPromptOverrides = Readonly<Record<string, string>>

export interface BehaviorPreset {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly levels: BehaviorLevels
}

export const DEFAULT_BEHAVIOR_LEVELS: BehaviorLevels = Object.freeze(Object.fromEntries(BEHAVIOR_TRAITS.map(trait => [trait.id, trait.defaultLevel])) as Record<BehaviorTraitId, string>)

export const BEHAVIOR_PRESETS: readonly BehaviorPreset[] = [
  {
    id: 'careful',
    label: 'Careful',
    description: 'Ask before each step, stop on errors, test before every real run, verify before relying on anything.',
    levels: { followThrough: 'confirm', errors: 'stop', verification: 'always', checking: 'thorough', scope: 'strict', reporting: 'standard' },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Finish what was asked, fix small errors, test what is new.',
    levels: DEFAULT_BEHAVIOR_LEVELS,
  },
  {
    id: 'autopilot',
    label: 'Autopilot',
    description: 'Keep going to the goal, resolve errors, report at the end.',
    levels: { followThrough: 'autonomous', errors: 'resolve', verification: 'when-new', checking: 'proportionate', scope: 'strict', reporting: 'brief' },
  },
]

export const DEFAULT_BEHAVIOR_PRESET = 'balanced'

export function behaviorTrait(id: BehaviorTraitId): BehaviorTrait {
  const trait = BEHAVIOR_TRAITS.find(candidate => candidate.id === id)
  if (trait === undefined) throw new Error(`Unknown behavior trait: ${id}`)
  return trait
}

export function isBehaviorTraitId(value: unknown): value is BehaviorTraitId {
  return typeof value === 'string' && BEHAVIOR_TRAITS.some(trait => trait.id === value)
}

export function isBehaviorLevel(trait: BehaviorTraitId, value: unknown): value is string {
  return typeof value === 'string' && behaviorTrait(trait).levels.some(level => level.id === value)
}

/** The override key for one trait level. */
export function behaviorPromptKey(trait: BehaviorTraitId, level: string): string {
  return `${trait}.${level}`
}

/** The prompt paragraph for one trait level: the user's override when set, otherwise the default. */
export function behaviorLevelText(trait: BehaviorTraitId, level: string, overrides: BehaviorPromptOverrides = {}): string {
  const found = behaviorTrait(trait).levels.find(candidate => candidate.id === level)
  if (found === undefined) throw new Error(`Unknown level '${level}' for behavior trait '${trait}'`)
  const override = overrides[behaviorPromptKey(trait, level)]
  return override !== undefined && override.trim() !== '' ? override.trim() : found.text
}

/** Fill missing or unknown levels with each trait's default. */
export function normalizeBehaviorLevels(levels: Partial<Record<BehaviorTraitId, unknown>>): BehaviorLevels {
  return Object.fromEntries(BEHAVIOR_TRAITS.map(trait => [trait.id, isBehaviorLevel(trait.id, levels[trait.id]) ? levels[trait.id] : trait.defaultLevel])) as Record<BehaviorTraitId, string>
}

/** The preset whose levels equal the selection exactly, or `undefined` for a custom mix. */
export function matchingBehaviorPreset(levels: BehaviorLevels): BehaviorPreset | undefined {
  return BEHAVIOR_PRESETS.find(preset => BEHAVIOR_TRAITS.every(trait => preset.levels[trait.id] === levels[trait.id]))
}

/**
 * Render the complete behavior text for a system prompt: the precedence
 * preamble followed by one paragraph per trait, in catalog order.
 */
export function renderBehaviorPrompt(levels: BehaviorLevels, overrides: BehaviorPromptOverrides = {}): string {
  return [BEHAVIOR_PREAMBLE, ...BEHAVIOR_TRAITS.map(trait => behaviorLevelText(trait.id, levels[trait.id], overrides))].join('\n')
}
