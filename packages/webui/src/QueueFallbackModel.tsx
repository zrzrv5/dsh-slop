import { useCallback, useEffect, useId, useState, type ChangeEvent, type ReactNode } from 'react'
import { Button, ErrorState, LoadingState, Notice, TextInput } from './ui.tsx'

export interface QueueFallbackModelValues {
  /** Provider route id; empty inherits the parent Chat's route. */
  readonly provider: string
  /** Model id on that route; empty inherits the parent Chat's model. */
  readonly model: string
  /** Optional reasoning effort; empty inherits the parent Chat's setting. */
  readonly reasoningEffort: string
}

export interface QueueFallbackModelView extends QueueFallbackModelValues {
  readonly revision: number
  readonly writable: boolean
}

export interface ProviderOption { readonly id: string; readonly name: string }

export interface QueueFallbackModelSource {
  load(): Promise<QueueFallbackModelView>
  save(values: QueueFallbackModelValues, expectedRevision: number): Promise<QueueFallbackModelView>
  /** Configured provider routes, offered as suggestions; optional. */
  listProviders?(): Promise<readonly ProviderOption[]>
}

export const QUEUE_FALLBACK_SCOPE = 'Applies only to the short Queue check worker that runs when a deterministic check is unsupported or ambiguous. Leave provider or model empty to use the Chat\'s model. An empty reasoning effort inherits the Chat\'s effort.'

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The Queue fallback model setting is unavailable.'
}

function valuesOf(view: QueueFallbackModelView): QueueFallbackModelValues {
  return { provider: view.provider, model: view.model, reasoningEffort: view.reasoningEffort }
}

function trimmed(values: QueueFallbackModelValues): QueueFallbackModelValues {
  return { provider: values.provider.trim(), model: values.model.trim(), reasoningEffort: values.reasoningEffort.trim() }
}

function same(left: QueueFallbackModelValues, right: QueueFallbackModelValues): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Provider, model and reasoning effort of the Queue fallback worker. */
export function QueueFallbackModel({ source }: { source: QueueFallbackModelSource }): ReactNode {
  const listId = useId()
  const [view, setView] = useState<QueueFallbackModelView>()
  const [draft, setDraft] = useState<QueueFallbackModelValues>({ provider: '', model: '', reasoningEffort: '' })
  const [providers, setProviders] = useState<readonly ProviderOption[]>([])
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const adopt = (next: QueueFallbackModelView): void => {
    setView(next)
    setDraft(valuesOf(next))
  }
  const load = useCallback(() => {
    setError(undefined)
    source.load().then(adopt, (failure: unknown) => { setError(message(failure)) })
  }, [source])
  useEffect(load, [load])
  useEffect(() => {
    let active = true
    // Suggestions only: a missing or failing provider list leaves free text entry.
    source.listProviders?.().then(list => { if (active) setProviders(list) }, () => undefined)
    return () => { active = false }
  }, [source])

  const save = (): void => {
    if (view === undefined) return
    setSaving(true)
    setSaved(false)
    setError(undefined)
    source.save(trimmed(draft), view.revision).then(next => { adopt(next); setSaved(true) }, (failure: unknown) => { setError(message(failure)) }).finally(() => { setSaving(false) })
  }

  const disabled = saving || view?.writable !== true
  const changed = view !== undefined && !same(trimmed(draft), valuesOf(view))
  const field = (key: keyof QueueFallbackModelValues) => ({
    value: draft[key],
    disabled,
    onChange: (event: ChangeEvent<HTMLInputElement>) => { setDraft({ ...draft, [key]: event.target.value }); setSaved(false) },
  })
  return <fieldset className="slop-fallback-model">
    <legend>Fallback worker model</legend>
    <p className="slop-section-description">{QUEUE_FALLBACK_SCOPE}</p>
    {error !== undefined && view === undefined ? <ErrorState error={error} onRetry={load} /> : null}
    {view === undefined && error === undefined ? <LoadingState label="Loading the fallback worker model" /> : null}
    {view === undefined ? null : <>
      <div className="slop-form-grid">
        <TextInput label="Provider route" placeholder="Inherit from Chat" list={providers.length === 0 ? undefined : listId} hint="Provider route id from Models settings, such as deepseek." {...field('provider')} />
        <TextInput label="Model" placeholder="Inherit from Chat" hint="Model id on that provider route." {...field('model')} />
        <TextInput label="Reasoning effort" placeholder="Inherit from Chat" hint="Optional, such as low or high." {...field('reasoningEffort')} />
      </div>
      {providers.length === 0 ? null : <datalist id={listId}>{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</datalist>}
      {view.writable ? null : <Notice tone="warning">This profile does not accept setting changes.</Notice>}
      {saved ? <Notice tone="success">Saved.</Notice> : null}
      {error === undefined ? null : <Notice tone="danger">{error}</Notice>}
      <div className="slop-form-actions">
        <Button variant="secondary" disabled={disabled || !changed} onClick={() => { setDraft(valuesOf(view)) }}>Cancel</Button>
        <Button disabled={disabled || !changed} onClick={save}>Save fallback model</Button>
      </div>
    </>}
  </fieldset>
}
