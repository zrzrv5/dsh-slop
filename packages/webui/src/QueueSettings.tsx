import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { browserBoot, refreshBrowserBoot, type BrowserBootConfig } from './browser-boot.ts'
import { Button, Checkbox, ErrorState, LoadingState, Notice, Panel, SectionHeading, SelectInput, StatusBadge, TextInput, formatDate, formatRelative } from './ui.tsx'

type QueueProfile = 'normal' | 'economy' | 'custom'
type Delivery = 'notify' | 'wake'

interface QueueSettingsValue {
  readonly schemaVersion: 1
  readonly revision: number
  readonly profile: QueueProfile
  readonly initialCheckSeconds: number
  readonly automaticMinimumSeconds: number
  readonly stableMinimumSeconds: number
  readonly startupWindowSeconds?: number
  readonly startupIntervalSeconds?: number
  readonly walltimeDivisor: number
  readonly durationMaximumSeconds: number
  readonly maximumDetectionDelaySeconds: number
  readonly queuedMaximumSeconds: number
  readonly fallbackEnabled: boolean
  readonly defaultDelivery: Delivery
  readonly defaultConditions: readonly string[]
  readonly updatedAt: string
}

interface QueueItemSettingsView {
  readonly id: string
  readonly label: string
  readonly state: string
  readonly observerKind: string
  readonly observerId: string
  readonly updatedAt: string
  readonly revision: number
  readonly intervalSource: 'global' | 'item'
  readonly observationSource?: 'code' | 'agent-fallback' | 'webhook'
  readonly phase?: string
  readonly awaitingVerification?: boolean
  readonly userIntervalSeconds?: number
  readonly purpose?: 'monitor' | 'continue'
  readonly continuation?: string
  readonly deliveryStatus?: string
  readonly deliveryError?: string
  readonly delivery: Delivery
  readonly lastCheckAt?: string
  readonly lastCheckError?: string
  readonly nextCheckAt?: string
  readonly nextCheckReason: string
  readonly consecutiveFailures: number
  readonly timing: {
    readonly expectedDurationSeconds?: number
    readonly walltimeSeconds?: number
    readonly walltimeRemainingSeconds?: number
    readonly startedAt?: string
    readonly elapsedSeconds?: number
    readonly expectedRemainingSeconds?: number
  }
}

interface QueueSettingsView {
  readonly schemaVersion: 1
  readonly settings: QueueSettingsValue
  readonly items: readonly QueueItemSettingsView[]
}

type ViewState = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly view: QueueSettingsView }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeView(value: unknown): QueueSettingsView | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.settings) || !Array.isArray(value.items)) return undefined
  const settings = value.settings
  if (settings.schemaVersion !== 1
    || typeof settings.revision !== 'number'
    || !['normal', 'economy', 'custom'].includes(String(settings.profile))
    || typeof settings.fallbackEnabled !== 'boolean'
    || !['notify', 'wake'].includes(String(settings.defaultDelivery))) return undefined
  const numeric = ['initialCheckSeconds', 'automaticMinimumSeconds', 'stableMinimumSeconds', 'walltimeDivisor', 'durationMaximumSeconds', 'maximumDetectionDelaySeconds', 'queuedMaximumSeconds'] as const
  if (!numeric.every((key) => typeof settings[key] === 'number' && Number.isSafeInteger(settings[key]) && settings[key] > 0)) return undefined
  if (!Array.isArray(settings.defaultConditions) || typeof settings.updatedAt !== 'string') return undefined
  const items = value.items.filter(isRecord)
  if (items.length !== value.items.length || !items.every((item) => typeof item.id === 'string'
    && typeof item.label === 'string'
    && typeof item.state === 'string'
    && typeof item.observerKind === 'string'
    && typeof item.observerId === 'string'
    && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
    && typeof item.revision === 'number'
    && (item.intervalSource === 'global' || item.intervalSource === 'item')
    && (item.observationSource === undefined || item.observationSource === 'code' || item.observationSource === 'agent-fallback' || item.observationSource === 'webhook')
    && (item.delivery === 'notify' || item.delivery === 'wake')
    && (item.lastCheckError === undefined || typeof item.lastCheckError === 'string')
    && typeof item.nextCheckReason === 'string'
    && typeof item.consecutiveFailures === 'number'
    && isRecord(item.timing))) return undefined
  return value as unknown as QueueSettingsView
}

function errorMessage(value: unknown, status: number): string {
  return isRecord(value) && typeof value.error === 'string' ? value.error : `Queue settings request failed with HTTP ${String(status)}.`
}

async function requestView(method: 'GET' | 'PUT', body?: unknown, signal?: AbortSignal): Promise<QueueSettingsView> {
  const boot = browserBoot()
  if (boot === undefined) throw new Error('DSH-SLOP browser authorization for Queue settings is unavailable.')
  const send = async (activeBoot: BrowserBootConfig): Promise<Response> => await fetch(activeBoot.queueSettingsBridgePath, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'x-dsh-slop-csrf': activeBoot.csrfNonce,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  })
  let response = await send(boot)
  if (response.status === 403) {
    const fresh = await refreshBrowserBoot()
    if (fresh !== undefined && fresh.csrfNonce !== boot.csrfNonce) response = await send(fresh)
  }
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(errorMessage(value, response.status))
  const view = decodeView(value)
  if (view === undefined) throw new Error('Queue settings returned an invalid view.')
  return view
}

function minutes(seconds: number): string {
  return String(seconds / 60)
}

function secondsFromMinutes(value: string): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return undefined
  return Math.round(parsed * 60)
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—'
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3_600).toFixed(seconds % 3_600 === 0 ? 0 : 1)}h`
}

function ItemOverride({ item, busy, onSave }: { item: QueueItemSettingsView; busy: boolean; onSave: (body: unknown) => Promise<void> }): ReactNode {
  const [interval, setInterval] = useState(item.userIntervalSeconds === undefined ? '' : minutes(item.userIntervalSeconds))
  const [purpose, setPurpose] = useState<'legacy' | 'monitor' | 'continue'>(item.purpose ?? 'legacy')
  const [continuation, setContinuation] = useState(item.continuation ?? '')
  useEffect(() => {
    setInterval(item.userIntervalSeconds === undefined ? '' : minutes(item.userIntervalSeconds))
    setPurpose(item.purpose ?? 'legacy')
    setContinuation(item.continuation ?? '')
  }, [item])
  const seconds = interval.trim() === '' ? null : secondsFromMinutes(interval)
  const invalid = (interval.trim() !== '' && seconds === undefined) || (purpose === 'continue' && continuation.trim() === '')
  return <div className="slop-queue-item-detail">
    <p className="slop-muted">{item.intervalSource === 'global' ? 'Inherits global cadence' : 'Item override'}</p>
    <p className="slop-muted">Last {formatDate(item.lastCheckAt)} · Next {formatDate(item.nextCheckAt)} · Last observation {item.observationSource ?? 'not checked'} · {item.nextCheckReason}</p>
    {item.lastCheckError === undefined ? null : <Notice tone="warning">Latest probe: {item.lastCheckError}</Notice>}
    <p className="slop-muted">Started {formatDate(item.timing.startedAt)} · Walltime {duration(item.timing.walltimeSeconds)} · Time budget left {duration(item.timing.walltimeRemainingSeconds)} · Expected duration {duration(item.timing.expectedDurationSeconds)} · Failures {item.consecutiveFailures}</p>
    {item.phase===undefined?null:<p className="slop-muted">Reported phase: {item.phase}</p>}
    {item.awaitingVerification?<Notice tone="info">Exit reported by webhook; awaiting scheduler verification.</Notice>:null}
    <div className="slop-queue-item-controls">
      <TextInput label="Override interval (minutes)" value={interval} onChange={(event) => { setInterval(event.target.value) }} placeholder="Inherit" error={invalid ? 'Use at least 1 minute.' : undefined} disabled={busy} inputMode="decimal" />
      <SelectInput label="Tracking purpose" value={purpose} onChange={event => { const next = event.target.value; if (next === 'monitor' || next === 'continue' || next === 'legacy') setPurpose(next) }} options={[...(item.purpose === undefined ? [{ value: 'legacy', label: 'Keep legacy delivery (' + item.delivery + ')' }] : []), { value: 'monitor', label: 'Monitor only' }, { value: 'continue', label: 'Continue authorized work' }]} disabled={busy} />
      {purpose === 'continue' ? <TextInput label="Authorized next step and result location" value={continuation} onChange={event => setContinuation(event.target.value)} disabled={busy} /> : null}
      <p>{item.deliveryStatus?.replaceAll('-', ' ')}{item.deliveryError ? ': ' + item.deliveryError : ''}</p>
      <Button variant="secondary" size="sm" disabled={busy || invalid} onClick={() => { void onSave({ scope: 'item', id: item.id, expectedRevision: item.revision, userIntervalSeconds: seconds, ...(purpose === 'legacy' ? {} : { purpose }), ...(purpose === 'continue' ? { continuation } : {}) }) }}>Save</Button>
    </div>
  </div>
}

const taskFilters = ['All', 'Running', 'Queued', 'Failed', 'Finished', 'Unknown'] as const
type TaskFilter = typeof taskFilters[number]
function matchesTaskFilter(item: QueueItemSettingsView, filter: TaskFilter): boolean {
  if (filter === 'All') return true
  if (filter === 'Finished') return item.state === 'completed' || item.state === 'cancelled'
  return item.state === filter.toLowerCase()
}

function TaskOverrides({ items, busy, onSave }: { items: readonly QueueItemSettingsView[]; busy: boolean; onSave: (body: unknown) => Promise<void> }): ReactNode {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<TaskFilter>('All')
  const [selected, setSelected] = useState<string>()
  const id = useId()
  const visible = items.filter(item => matchesTaskFilter(item, filter))
  return <Panel className="slop-queue-overrides">
    <button className="slop-queue-disclosure" aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open) }}>
      <span><span aria-hidden="true">{open ? '▾' : '▸'}</span> Task overrides <span className="slop-queue-count">{items.length}</span></span>
      <small>Updated in the last 14 days</small>
    </button>
    {open ? <div id={id}>
      <div className="slop-queue-filters" role="group" aria-label="Filter tasks by status">
        {taskFilters.map(value => <button key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelected(undefined) }}>
          {value}<span>{items.filter(item => matchesTaskFilter(item, value)).length}</span>
        </button>)}
      </div>
      <div className="slop-queue-table-scroll">
        <table className="slop-queue-table" aria-label="Recent task overrides">
          <thead><tr><th>Task</th><th>Status</th><th>Job</th><th>Last check</th><th>Next check</th></tr></thead>
          <tbody>{visible.length === 0 ? <tr><td colSpan={5} className="slop-queue-empty">No {filter === 'All' ? '' : `${filter.toLowerCase()} `}tasks updated in the last 14 days.</td></tr> : visible.map(item => {
            const expanded = selected === item.id
            return <Fragment key={item.id}>
              <tr>
                <td><button className="slop-queue-task-label" aria-label={`Settings for ${item.label}`} aria-expanded={expanded} aria-controls={`${id}-${item.id}`} title={item.label} onClick={() => { setSelected(expanded ? undefined : item.id) }}>
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span><span>{item.label}</span>
                </button></td>
                <td><StatusBadge value={item.state} />{item.awaitingVerification ? <span className="slop-queue-marker" title="Awaiting scheduler verification" aria-label="Awaiting scheduler verification"> · verifying</span> : null}</td>
                <td title={item.observerKind}>{item.observerId}</td>
                <td title={formatDate(item.lastCheckAt)}>{formatRelative(item.lastCheckAt)}{item.lastCheckError ? <span className="slop-queue-marker slop-queue-warning" title={item.lastCheckError} aria-label="Probe warning"> !</span> : null}</td>
                <td title={item.nextCheckReason}>{formatDate(item.nextCheckAt)}</td>
              </tr>
              {expanded ? <tr id={`${id}-${item.id}`} className="slop-queue-detail-row"><td colSpan={5}><ItemOverride item={item} busy={busy} onSave={onSave} /></td></tr> : null}
            </Fragment>
          })}</tbody>
        </table>
      </div>
    </div> : null}
  </Panel>
}

/** Configure adaptive Queue monitoring and inspect effective per-task cadence. */
export function QueueSettings({ compact = false }: { readonly compact?: boolean }): ReactNode {
  const mounted = useRef(true)
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => () => { mounted.current = false }, [])
  const adopt = useCallback((view: QueueSettingsView): void => {
    setState({ kind: 'ready', view })
    const settings = view.settings
    setDraft({
      initialCheckSeconds: minutes(settings.initialCheckSeconds),
      automaticMinimumSeconds: minutes(settings.automaticMinimumSeconds),
      stableMinimumSeconds: minutes(settings.stableMinimumSeconds),
      startupWindowSeconds: minutes(settings.startupWindowSeconds ?? 600),
      startupIntervalSeconds: minutes(settings.startupIntervalSeconds ?? 60),
      durationMaximumSeconds: minutes(settings.durationMaximumSeconds),
      maximumDetectionDelaySeconds: minutes(settings.maximumDetectionDelaySeconds),
      queuedMaximumSeconds: minutes(settings.queuedMaximumSeconds),
      walltimeDivisor: String(settings.walltimeDivisor),
    })
  }, [])
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const view = await requestView('GET', undefined, signal)
      if (mounted.current && signal?.aborted !== true) adopt(view)
    } catch (requestError) {
      if (mounted.current && signal?.aborted !== true) setState({ kind: 'error', message: requestError instanceof Error ? requestError.message : 'Could not load Queue settings.' })
    }
  }, [adopt])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [refresh])
  const save = async (body: unknown): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const view = await requestView('PUT', body)
      if (mounted.current) adopt(view)
    } catch (requestError) {
      if (mounted.current) setError(requestError instanceof Error ? requestError.message : 'Queue settings update failed.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const view = state.kind === 'ready' ? state.view : undefined
  const settings = view?.settings
  const items = view?.items ?? []
  const numericPatch = (): Record<string, number> | undefined => {
    const fields = ['initialCheckSeconds', 'automaticMinimumSeconds', 'startupWindowSeconds', 'startupIntervalSeconds', 'stableMinimumSeconds', 'durationMaximumSeconds', 'maximumDetectionDelaySeconds', 'queuedMaximumSeconds'] as const
    const result: Record<string, number> = {}
    for (const field of fields) {
      const value = secondsFromMinutes(draft[field] ?? '')
      if (value === undefined) return undefined
      result[field] = value
    }
    const divisor = Number(draft.walltimeDivisor)
    if (!Number.isSafeInteger(divisor) || divisor < 1) return undefined
    result.walltimeDivisor = divisor
    return result
  }
  const patch = numericPatch()
  return <div className={compact ? 'slop-view slop-view-embedded' : 'slop-view'}>
    <SectionHeading title="Queue" description="Monitor from submission through startup and exit. Walltime is a runtime limit, not task progress." actions={<Button variant="ghost" onClick={() => { void refresh() }} disabled={busy}>Refresh</Button>} />
    {state.kind === 'loading' ? <LoadingState label="Loading Queue settings" /> : null}
    {state.kind === 'error' ? <ErrorState error={state.message} onRetry={() => { void refresh() }} /> : null}
    {settings === undefined ? null : <>
      {error === undefined ? null : <Notice tone="danger">{error}</Notice>}
      <Panel className="slop-settings-form">
        <SelectInput label="Cadence profile" value={settings.profile} options={[{ value: 'normal', label: 'Normal' }, { value: 'economy', label: 'Economy' }, { value: 'custom', label: 'Custom' }]} onChange={(event) => { void save({ scope: 'global', expectedRevision: settings.revision, patch: { profile: event.target.value } }) }} disabled={busy} hint="Economy allows up to 12 hours between stable checks; Normal caps detection at 2 hours." />
        <TextInput label="Initial check (minutes)" value={draft.initialCheckSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, initialCheckSeconds: event.target.value }) }} disabled={busy} />
        <TextInput label="Automatic minimum (minutes)" value={draft.automaticMinimumSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, automaticMinimumSeconds: event.target.value }) }} disabled={busy} />
        <TextInput label="Startup window (minutes)" value={draft.startupWindowSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, startupWindowSeconds: event.target.value }) }} disabled={busy} hint="Measured from actual execution start, excluding time spent queued." />
        <TextInput label="Startup check interval (minutes)" value={draft.startupIntervalSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, startupIntervalSeconds: event.target.value }) }} disabled={busy} />
        <TextInput label="Stable-running minimum (minutes)" value={draft.stableMinimumSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, stableMinimumSeconds: event.target.value }) }} disabled={busy} />
        <TextInput label="Walltime divisor" value={draft.walltimeDivisor ?? ''} onChange={(event) => { setDraft({ ...draft, walltimeDivisor: event.target.value }) }} disabled={busy} hint="Stable interval starts at walltime divided by this value." />
        <TextInput label="Duration cap (minutes)" value={draft.durationMaximumSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, durationMaximumSeconds: event.target.value }) }} disabled={busy} />
        <TextInput label="Maximum detection delay (minutes)" value={draft.maximumDetectionDelaySeconds ?? ''} onChange={(event) => { setDraft({ ...draft, maximumDetectionDelaySeconds: event.target.value }) }} disabled={busy} />
        <TextInput label="Queued backoff cap (minutes)" value={draft.queuedMaximumSeconds ?? ''} onChange={(event) => { setDraft({ ...draft, queuedMaximumSeconds: event.target.value }) }} disabled={busy} />
        <Checkbox label="Allow agent fallback" checked={settings.fallbackEnabled} onChange={checked => { void save({ scope: 'global', expectedRevision: settings.revision, patch: { profile: 'custom', fallbackEnabled: checked } }) }} disabled={busy} hint="Used only for unsupported or ambiguous deterministic results." />
        <SelectInput label="Default notification conditions" value={settings.defaultConditions.includes('any-state-change') ? 'any-state-change' : 'terminal'} onChange={(event) => { void save({ scope: 'global', expectedRevision: settings.revision, patch: { profile: 'custom', defaultConditions: event.target.value === 'any-state-change' ? ['any-state-change'] : ['completed', 'failed', 'cancelled'] } }) }} options={[{ value: 'any-state-change', label: 'Any state change' }, { value: 'terminal', label: 'Terminal states only' }]} disabled={busy} />
        <div className="slop-form-actions"><Button disabled={busy || patch === undefined} onClick={() => { if (patch !== undefined) void save({ scope: 'global', expectedRevision: settings.revision, patch: { profile: 'custom', ...patch } }) }}>Save custom cadence</Button></div>
      </Panel>
      <TaskOverrides items={items} busy={busy} onSave={save} />
    </>}
  </div>
}
