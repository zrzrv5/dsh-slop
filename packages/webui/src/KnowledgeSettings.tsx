import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { browserBoot, refreshBrowserBoot, type BrowserBootConfig } from './browser-boot.ts'
import { KnowledgeDirectoryBrowser, type KnowledgeDirectoryLister } from './KnowledgeDirectoryBrowser.tsx'
import { Button, ErrorState, Input, LoadingState, Notice, Panel, SectionHeading, StatusBadge, formatDate } from './ui.tsx'

const KNOWLEDGE_NAMESPACE = 'dsh-slop-knowledge'

export type KnowledgeSourceState = 'ready' | 'missing' | 'error'

interface KnowledgeSourceFields {
  readonly state: KnowledgeSourceState
  readonly documentCount: number
  readonly indexedAt?: string
  readonly error?: string
}

export type KnowledgeSourceStatus =
  | KnowledgeSourceFields & {
    readonly kind: 'home'
    readonly root: string
  }
  | KnowledgeSourceFields & {
    readonly kind: 'workspace'
    readonly workspaceId: string
    readonly workspaceTitle: string
    readonly workspacePath: string
    readonly root: string
  }

export interface KnowledgeSettingsView {
  readonly schemaVersion: 1
  readonly namespace: typeof KNOWLEDGE_NAMESPACE
  readonly revision: number
  readonly homeRoot: string
  readonly defaultHomeRoot: string
  readonly overridden: boolean
  readonly sources: readonly KnowledgeSourceStatus[]
}

export interface KnowledgeSettingsProps {
  readonly compact?: boolean
  readonly listDirectory?: KnowledgeDirectoryLister
}

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly view: KnowledgeSettingsView }

type Operation = 'idle' | 'saving' | 'rebuilding'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function decodeSource(value: unknown): KnowledgeSourceStatus | undefined {
  if (!isRecord(value)) return undefined
  const state = value.state
  const documentCount = value.documentCount
  const indexedAt = value.indexedAt
  const error = value.error
  if (state !== 'ready' && state !== 'missing' && state !== 'error') return undefined
  if (typeof documentCount !== 'number' || !Number.isSafeInteger(documentCount) || documentCount < 0) return undefined
  if (!optionalString(indexedAt) || !optionalString(error)) return undefined
  const fields: KnowledgeSourceFields = {
    state,
    documentCount,
    ...(indexedAt === undefined ? {} : { indexedAt }),
    ...(error === undefined ? {} : { error }),
  }
  if (value.kind === 'home' && typeof value.root === 'string' && value.root.length > 0) {
    return { kind: 'home', root: value.root, ...fields }
  }
  if (value.kind === 'workspace'
    && typeof value.workspaceId === 'string' && value.workspaceId.length > 0
    && typeof value.workspaceTitle === 'string'
    && typeof value.workspacePath === 'string' && value.workspacePath.length > 0
    && typeof value.root === 'string' && value.root.length > 0) {
    return {
      kind: 'workspace',
      workspaceId: value.workspaceId,
      workspaceTitle: value.workspaceTitle,
      workspacePath: value.workspacePath,
      root: value.root,
      ...fields,
    }
  }
  return undefined
}

function decodeView(value: unknown): KnowledgeSettingsView | undefined {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.namespace !== KNOWLEDGE_NAMESPACE
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.homeRoot !== 'string' || value.homeRoot.length === 0
    || typeof value.defaultHomeRoot !== 'string' || value.defaultHomeRoot.length === 0
    || typeof value.overridden !== 'boolean'
    || !Array.isArray(value.sources)) return undefined
  const sources: KnowledgeSourceStatus[] = []
  for (const source of value.sources) {
    const decoded = decodeSource(source)
    if (decoded === undefined) return undefined
    sources.push(decoded)
  }
  return {
    schemaVersion: 1,
    namespace: KNOWLEDGE_NAMESPACE,
    revision: value.revision,
    homeRoot: value.homeRoot,
    defaultHomeRoot: value.defaultHomeRoot,
    overridden: value.overridden,
    sources,
  }
}

function errorMessage(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.error === 'string') return value.error
  return `Knowledge settings request failed with HTTP ${status}.`
}

async function requestView(method: 'GET' | 'PUT' | 'POST', body?: unknown, signal?: AbortSignal): Promise<KnowledgeSettingsView> {
  const boot = browserBoot()
  if (boot === undefined) throw new Error('DSH-SLOP browser authorization for Knowledge settings is unavailable.')
  const send = async (activeBoot: BrowserBootConfig): Promise<Response> => await fetch(activeBoot.knowledgeSettingsBridgePath, {
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
  if (view === undefined) throw new Error('Knowledge settings returned an invalid view.')
  return view
}

function sourceTitle(source: KnowledgeSourceStatus): string {
  return source.kind === 'home' ? 'Home Knowledge' : source.workspaceTitle
}

function sourcePath(source: KnowledgeSourceStatus): string {
  return source.root
}

/** Configure host-level Home Knowledge storage and inspect every indexed source. */
export function KnowledgeSettings({ compact = false, listDirectory }: KnowledgeSettingsProps): ReactNode {
  const rootInputId = useId()
  const mounted = useRef(true)
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [draftRoot, setDraftRoot] = useState('')
  const [operation, setOperation] = useState<Operation>('idle')
  const [operationError, setOperationError] = useState<string>()
  const [browserOpen, setBrowserOpen] = useState(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const view = await requestView('GET', undefined, signal)
      if (mounted.current && signal?.aborted !== true) {
        setState({ kind: 'ready', view })
        setDraftRoot(view.homeRoot)
        setOperationError(undefined)
      }
    } catch (error) {
      if (mounted.current && signal?.aborted !== true) setState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not load Knowledge settings.' })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [refresh])

  const commit = async (kind: Exclude<Operation, 'idle'>, method: 'PUT' | 'POST', body: unknown): Promise<void> => {
    setOperation(kind)
    setOperationError(undefined)
    try {
      const view = await requestView(method, body)
      if (mounted.current) {
        setState({ kind: 'ready', view })
        setDraftRoot(view.homeRoot)
      }
    } catch (error) {
      if (mounted.current) setOperationError(error instanceof Error ? error.message : 'Knowledge settings request failed.')
    } finally {
      if (mounted.current) setOperation('idle')
    }
  }

  const busy = operation !== 'idle'
  const view = state.kind === 'ready' ? state.view : undefined
  const normalizedRoot = draftRoot.trim()
  const rootError = normalizedRoot.length === 0 ? 'Enter an absolute directory path.' : undefined
  const dirty = view !== undefined && normalizedRoot !== view.homeRoot
  const documentCount = view?.sources.reduce((total, source) => total + source.documentCount, 0) ?? 0
  const sourceErrors = view?.sources.filter(source => source.state === 'error').length ?? 0
  const missingSources = view?.sources.filter(source => source.state === 'missing').length ?? 0
  const indexState = operation === 'rebuilding' ? 'indexing' : sourceErrors > 0 ? 'error' : missingSources > 0 ? 'missing' : 'ready'

  return <div className={compact ? 'slop-view slop-view-embedded' : 'slop-view'}>
    <SectionHeading
      title="Knowledge"
      description="Choose where Home Knowledge is stored, rebuild the index, and inspect the sources available to agents."
      actions={<Button variant="ghost" onClick={() => { void refresh() }} disabled={busy || state.kind === 'loading'}>Refresh</Button>}
    />

    {state.kind === 'loading' ? <LoadingState label="Loading Knowledge settings" /> : null}
    {state.kind === 'error' ? <ErrorState error={state.message} onRetry={() => { void refresh() }} /> : null}
    {view === undefined ? null : <>
      {operationError === undefined ? null : <Notice tone="danger">{operationError}</Notice>}
      <Panel className="slop-knowledge-home-panel">
        <SectionHeading title="Home Knowledge" description="This host-level directory stores systematic Knowledge shared across Workspaces. Finer Knowledge stays with its Workspace." />
        <div className="slop-field">
          <label className="slop-field-label" htmlFor={rootInputId}>Home root</label>
          <div className="slop-knowledge-path-row">
            <Input
              id={rootInputId}
              className={`slop-input-control${rootError === undefined ? '' : ' slop-input-error'}`}
              value={draftRoot}
              onChange={event => { setDraftRoot(event.target.value) }}
              aria-invalid={rootError !== undefined || undefined}
              aria-describedby={`${rootInputId}-hint`}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
            />
            <Button variant="secondary" onClick={() => { setBrowserOpen(true) }} disabled={busy || listDirectory === undefined} title={listDirectory === undefined ? 'Directory browsing is unavailable in this client.' : undefined}>Browse</Button>
          </div>
          <span id={`${rootInputId}-hint`} className={`slop-field-hint${rootError === undefined ? '' : ' slop-field-error'}`}>{rootError ?? (view.overridden ? 'Using a custom location.' : 'Using the default location.')}</span>
        </div>
        <div className="slop-knowledge-form-actions">
          <Button variant="ghost" onClick={() => { setDraftRoot(view.defaultHomeRoot) }} disabled={busy || normalizedRoot === view.defaultHomeRoot}>Reset to default</Button>
          <Button onClick={() => { void commit('saving', 'PUT', { homeRoot: normalizedRoot, expectedRevision: view.revision }) }} disabled={busy || !dirty || rootError !== undefined}>{operation === 'saving' ? 'Saving…' : 'Save'}</Button>
        </div>
      </Panel>

      <Panel>
        <SectionHeading
          title="Index"
          description={`${documentCount} ${documentCount === 1 ? 'document' : 'documents'} across ${view.sources.length} ${view.sources.length === 1 ? 'source' : 'sources'}.`}
          actions={<div className="slop-section-actions" role="status" aria-live="polite">
            <StatusBadge value={indexState} tone={operation === 'rebuilding' ? 'info' : indexState === 'missing' ? 'warning' : undefined} label={operation === 'rebuilding' ? 'Rebuilding' : undefined} />
            <Button variant="secondary" onClick={() => { void commit('rebuilding', 'POST', { action: 'rebuild' }) }} disabled={busy}>{operation === 'rebuilding' ? 'Rebuilding…' : 'Rebuild index'}</Button>
          </div>}
        />
        {sourceErrors > 0 ? <Notice tone="danger">{sourceErrors} {sourceErrors === 1 ? 'source has' : 'sources have'} an indexing error. Check the source list below.</Notice> : null}
        {sourceErrors === 0 && missingSources > 0 ? <Notice tone="warning">{missingSources} {missingSources === 1 ? 'source is' : 'sources are'} currently missing.</Notice> : null}
      </Panel>

      <Panel>
        <SectionHeading title="Sources" description="Read-only index status for Home Knowledge and registered Workspace Knowledge roots." />
        <ul className="slop-knowledge-source-list">
          {view.sources.map(source => <li key={source.kind === 'home' ? `home:${source.root}` : `workspace:${source.workspaceId}`}>
            <div className="slop-knowledge-source-main">
              <span className="slop-eyebrow">{source.kind === 'home' ? 'Home' : 'Workspace'}</span>
              <strong>{sourceTitle(source)}</strong>
              <code>{sourcePath(source)}</code>
            </div>
            <div className="slop-knowledge-source-meta">
              <StatusBadge value={source.state} tone={source.state === 'missing' ? 'warning' : undefined} />
              <span>{source.documentCount} {source.documentCount === 1 ? 'document' : 'documents'}</span>
              <span>{source.indexedAt === undefined ? 'Not indexed' : `Indexed ${formatDate(source.indexedAt)}`}</span>
            </div>
            {source.error === undefined ? null : <p role="alert">{source.error}</p>}
          </li>)}
        </ul>
        {view.sources.length === 0 ? <p className="slop-muted">No Knowledge sources are available.</p> : null}
      </Panel>
    </>}

    {listDirectory === undefined ? null : <KnowledgeDirectoryBrowser
      open={browserOpen}
      initialPath={draftRoot}
      listDirectory={listDirectory}
      onClose={() => { setBrowserOpen(false) }}
      onSelect={path => { setDraftRoot(path); setBrowserOpen(false) }}
    />}
  </div>
}
