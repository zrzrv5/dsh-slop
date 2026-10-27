import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { Button, Checkbox, Modal, Notice } from './ui.tsx'

export type KnowledgeDirectoryLister = (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>

interface KnowledgeDirectoryBrowserProps {
  readonly open: boolean
  readonly initialPath: string
  readonly listDirectory: KnowledgeDirectoryLister
  readonly onSelect: (path: string) => void
  readonly onClose: () => void
}

type BrowserState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly path?: string }
  | { readonly kind: 'ready'; readonly listing: DirectoryListing }
  | { readonly kind: 'error'; readonly path?: string; readonly message: string }

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not list this directory.'
}

/** Small host-backed directory chooser for the Knowledge home root. */
export function KnowledgeDirectoryBrowser({ open, initialPath, listDirectory, onSelect, onClose }: KnowledgeDirectoryBrowserProps): ReactNode {
  const [state, setState] = useState<BrowserState>({ kind: 'closed' })
  const [showHidden, setShowHidden] = useState(false)
  const activeRequest = useRef<AbortController>()

  const load = useCallback((path?: string): void => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setState({ kind: 'loading', ...(path === undefined ? {} : { path }) })
    void listDirectory(path, controller.signal).then(
      listing => {
        if (!controller.signal.aborted) setState({ kind: 'ready', listing })
      },
      error => {
        if (!controller.signal.aborted) setState({ kind: 'error', ...(path === undefined ? {} : { path }), message: messageFrom(error) })
      },
    )
  }, [listDirectory])

  useEffect(() => {
    if (!open) {
      activeRequest.current?.abort()
      setState({ kind: 'closed' })
      return
    }
    setShowHidden(false)
    const path = initialPath.trim()
    load(path.length === 0 ? undefined : path)
    return () => { activeRequest.current?.abort() }
  }, [initialPath, load, open])

  const listing = state.kind === 'ready' ? state.listing : undefined
  const entries = listing?.entries.filter(entry => showHidden || !entry.hidden) ?? []
  const selectedPath = listing?.path

  return <Modal
    open={open}
    title="Choose Knowledge home"
    description="Browse directories on the DSH host. Files remain on that host."
    onClose={onClose}
    footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button onClick={() => { if (selectedPath !== undefined) onSelect(selectedPath) }} disabled={selectedPath === undefined}>Use this folder</Button>
    </>}
  >
    <div className="slop-knowledge-browser">
      {listing === undefined ? null : <nav className="slop-knowledge-crumbs" aria-label="Directory path">
        {listing.crumbs.map((crumb, index) => <span key={crumb.path}>
          {index > 0 ? <span aria-hidden="true">/</span> : null}
          <button
            type="button"
            aria-current={crumb.path === listing.path ? 'page' : undefined}
            onClick={() => { load(crumb.path) }}
          >
            {crumb.path === listing.home ? 'Home' : crumb.name}
          </button>
        </span>)}
      </nav>}

      {state.kind === 'loading' ? <div className="slop-knowledge-browser-state" role="status" aria-live="polite"><span className="slop-spinner" aria-hidden="true" />Loading folders</div> : null}
      {state.kind === 'error' ? <Notice tone="danger">
        <span>{state.message}</span>{' '}
        <button type="button" className="slop-inline-link" onClick={() => { load(state.path) }}>Try again</button>
        {state.path === undefined ? null : <>{' '}<button type="button" className="slop-inline-link" onClick={() => { load() }}>Browse host home</button></>}
      </Notice> : null}
      {state.kind === 'ready' ? <>
        <code className="slop-knowledge-current-path">{state.listing.path}</code>
        {entries.length === 0
          ? <p className="slop-knowledge-browser-empty">No folders to show.</p>
          : <ul className="slop-knowledge-directory-list" aria-label={`Folders in ${state.listing.path}`}>
            {entries.map(entry => <li key={entry.path}>
              <button type="button" onClick={() => { load(entry.path) }}>
                <span aria-hidden="true">▱</span>
                <span>{entry.name}</span>
                <span aria-hidden="true">›</span>
              </button>
            </li>)}
          </ul>}
        {state.listing.truncated ? <Notice tone="warning">This folder has more entries than the host returned. Only the first group is shown.</Notice> : null}
        <Checkbox label="Show hidden folders" checked={showHidden} onChange={setShowHidden} />
      </> : null}
    </div>
  </Modal>
}
