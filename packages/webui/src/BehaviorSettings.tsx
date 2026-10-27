import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import {
  BEHAVIOR_PRESETS,
  behaviorTrait,
  behaviorLevelText,
  behaviorPromptKey,
  matchingBehaviorPreset,
  type BehaviorLevels,
  type BehaviorPromptOverrides,
  type BehaviorTrait,
  type BehaviorTraitId,
} from '@dsh-slop/runtime-base/behavior-catalog'
import { Button, ErrorState, LoadingState, Notice, Panel, SectionHeading, SelectInput, TextArea } from './ui.tsx'

export const BEHAVIOR_APPLIES_TO = 'Takes effect in new sessions. Chats that are already open keep their current behavior.'

const CUSTOM_PRESET = 'custom'

const TRAIT_GROUPS = [
  { label: 'Execution', traits: ['followThrough', 'errors'] },
  { label: 'Verification', traits: ['verification', 'checking'] },
  { label: 'Scope and communication', traits: ['scope', 'reporting'] },
] as const satisfies readonly { label: string; traits: readonly BehaviorTraitId[] }[]

export interface BehaviorSettingsView {
  readonly levels: BehaviorLevels
  /** Prompt-text overrides keyed `<trait>.<level>`; an absent key uses the default text. */
  readonly overrides: BehaviorPromptOverrides
  readonly revision: number
  readonly writable: boolean
}

/** Keys written to the `slop-runtime` settings namespace. */
export type BehaviorSettingsPatch = Partial<Record<BehaviorTraitId, string>> & { readonly promptOverrides?: BehaviorPromptOverrides }

export interface BehaviorSettingsSource {
  load(): Promise<BehaviorSettingsView>
  save(patch: BehaviorSettingsPatch, expectedRevision: number): Promise<BehaviorSettingsView>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The Agent behavior settings are unavailable.'
}

function applyPatch(view: BehaviorSettingsView, patch: BehaviorSettingsPatch): BehaviorSettingsView {
  const { promptOverrides, ...levels } = patch
  return { ...view, levels: { ...view.levels, ...levels }, overrides: promptOverrides ?? view.overrides }
}

/** Settings tab for the Agent behavior traits and their prompt text. */
export function BehaviorSettings({ source }: { source: BehaviorSettingsSource }): ReactNode {
  const [view, setView] = useState<BehaviorSettingsView>()
  const [pending, setPending] = useState<BehaviorSettingsView>()
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()

  const load = useCallback(() => {
    setError(undefined)
    source.load().then(setView, (failure: unknown) => { setError(message(failure)) })
  }, [source])
  useEffect(load, [load])

  /** Resolves to whether the Host accepted the change. */
  const save = async (patch: BehaviorSettingsPatch, confirmation: string): Promise<boolean> => {
    if (view === undefined || pending !== undefined) return false
    // Show the change at once; the Host's revision check decides whether it stands.
    setPending(applyPatch(view, patch))
    setSaved(undefined)
    setError(undefined)
    try {
      setView(await source.save(patch, view.revision))
      setSaved(confirmation)
      return true
    } catch (failure: unknown) {
      setError(message(failure))
      return false
    } finally {
      setPending(undefined)
    }
  }

  const shown = pending ?? view
  const preset = shown === undefined ? undefined : matchingBehaviorPreset(shown.levels)
  const disabled = pending !== undefined || shown?.writable !== true
  return <Panel className="slop-behavior-settings">
    <SectionHeading title="Agent behavior" description="Choose how an Agent carries out requests. Project and user instructions such as AGENTS.md take precedence." />
    {error !== undefined && view === undefined ? <ErrorState error={error} onRetry={load} /> : null}
    {view === undefined && error === undefined ? <LoadingState label="Loading Agent behavior" /> : null}
    {shown === undefined ? null : <>
      <p className="slop-behavior-timing">{BEHAVIOR_APPLIES_TO}</p>
      {shown.writable ? null : <Notice tone="warning">This profile does not accept setting changes.</Notice>}
      {saved === undefined ? null : <Notice tone="success">{saved}</Notice>}
      {error === undefined || view === undefined ? null : <Notice tone="danger">{error}</Notice>}
      <div className="slop-behavior-preset">
        <SelectInput
          label="Preset"
          value={preset?.id ?? CUSTOM_PRESET}
          disabled={disabled}
          options={[
            ...BEHAVIOR_PRESETS.map(option => ({ value: option.id, label: option.label })),
            ...(preset === undefined ? [{ value: CUSTOM_PRESET, label: 'Custom', disabled: true }] : []),
          ]}
          hint={preset?.description ?? 'A custom mix of levels.'}
          onChange={event => {
            const chosen = BEHAVIOR_PRESETS.find(option => option.id === event.target.value)
            if (chosen !== undefined && chosen.id !== preset?.id) void save({ ...chosen.levels }, 'Saved. New sessions will use this preset.')
          }}
        />
        <p className="slop-behavior-preset-hint">Sets all six preferences. Adjust individual choices below.</p>
      </div>
      {TRAIT_GROUPS.map(group => <fieldset key={group.label} className="slop-behavior-group">
        <legend>{group.label}</legend>
        {group.traits.map(id => <TraitControl
          key={id}
          trait={behaviorTrait(id)}
          view={shown}
          disabled={disabled}
          onLevel={level => { void save({ [id]: level } as BehaviorSettingsPatch, 'Saved. New sessions will use this level.') }}
          onOverrides={async (overrides, confirmation) => await save({ promptOverrides: overrides }, confirmation)}
        />)}
      </fieldset>)}
    </>}
  </Panel>
}

function TraitControl({ trait, view, disabled, onLevel, onOverrides }: {
  readonly trait: BehaviorTrait
  readonly view: BehaviorSettingsView
  readonly disabled: boolean
  readonly onLevel: (level: string) => void
  readonly onOverrides: (overrides: BehaviorPromptOverrides, confirmation: string) => Promise<boolean>
}): ReactNode {
  const editorId = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>()
  const levelId = view.levels[trait.id]
  const level = trait.levels.find(candidate => candidate.id === levelId)
  const key = behaviorPromptKey(trait.id, levelId)
  const effective = behaviorLevelText(trait.id, levelId, view.overrides)
  const overridden = (view.overrides[key] ?? '').trim() !== ''
  // A draft belongs to the level it was started on.
  const [draftKey, setDraftKey] = useState(key)
  if (draftKey !== key) { setDraftKey(key); setDraft(undefined) }
  const text = draft ?? effective

  const writeOverride = (value: string | undefined, confirmation: string): void => {
    const defaultText = level?.text ?? ''
    const trimmed = value?.trim() ?? ''
    // The Host merges patches recursively, so a dropped key would keep its old
    // text; an empty string is how an override is cleared.
    const next = { ...view.overrides, [key]: trimmed === defaultText ? '' : trimmed }
    // Keep the draft until the Host accepts it, so a refused save loses no text.
    void onOverrides(next, confirmation).then(accepted => { if (accepted) setDraft(undefined) })
  }

  return <div className="slop-behavior-trait">
    <SelectInput
      label={trait.label}
      value={levelId}
      disabled={disabled}
      options={trait.levels.map(option => ({ value: option.id, label: option.id === trait.defaultLevel ? `${option.label} (default)` : option.label }))}
      hint={level?.description ?? trait.description}
      onChange={event => { if (event.target.value !== levelId) onLevel(event.target.value) }}
    />
    <button type="button" className="slop-behavior-disclosure" aria-expanded={editing} aria-controls={editorId} onClick={() => { setEditing(!editing) }}>
      <span aria-hidden="true" className="slop-behavior-chevron">›</span>
      {editing ? 'Hide prompt text' : 'Edit prompt text'}{overridden ? ' (edited)' : ''}
    </button>
    {editing ? <div id={editorId} className="slop-behavior-editor">
      <p className="slop-section-description">{trait.description}</p>
      <TextArea
        label={`${trait.label} prompt text: ${level?.label ?? levelId}`}
        value={text}
        rows={4}
        disabled={disabled}
        hint="Sent to the model word for word at the start of new sessions. Leave it empty to use the default text."
        onChange={event => { setDraft(event.target.value) }}
      />
      <div className="slop-form-actions">
        {overridden ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { writeOverride(undefined, 'Restored the default text for new sessions.') }}>Reset to default</Button> : null}
        <Button variant="secondary" size="sm" onClick={() => { setDraft(undefined); setEditing(false) }}>Cancel</Button>
        <Button size="sm" disabled={disabled || draft === undefined || draft.trim() === effective} onClick={() => { writeOverride(draft, 'Saved. New sessions will use this text.') }}>Save text</Button>
      </div>
    </div> : null}
  </div>
}
