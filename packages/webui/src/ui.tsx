import { createContext, forwardRef, useContext, useEffect, useId, useRef, type ButtonHTMLAttributes, type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button as NativeButton, Checkbox as NativeCheckbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'
export { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteFailure } from './types.ts'

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

const HeadingLevelContext = createContext<HeadingLevel>(1)

function nextHeadingLevel(level: HeadingLevel): HeadingLevel {
  return Math.min(level + 1, 6) as HeadingLevel
}

interface ModalStackEntry {
  readonly id: symbol
  readonly layer: HTMLDivElement
  readonly dialog: HTMLDivElement
  readonly close: () => void
  readonly returnFocus: HTMLElement | null
}

interface ElementAccessibilitySnapshot {
  readonly element: HTMLElement
  readonly ariaHidden: string | null
  readonly inert: boolean
}

const modalStack: ModalStackEntry[] = []
let backgroundSnapshots: ElementAccessibilitySnapshot[] | undefined
let previousBodyOverflow = ''

function setModalElementState(element: HTMLElement, hidden: boolean): void {
  element.inert = hidden
  if (hidden) element.setAttribute('aria-hidden', 'true')
  else element.removeAttribute('aria-hidden')
}

function syncModalEnvironment(): void {
  if (typeof document === 'undefined') return
  if (modalStack.length === 0) {
    if (backgroundSnapshots !== undefined) {
      for (const snapshot of backgroundSnapshots) {
        snapshot.element.inert = snapshot.inert
        if (snapshot.ariaHidden === null) snapshot.element.removeAttribute('aria-hidden')
        else snapshot.element.setAttribute('aria-hidden', snapshot.ariaHidden)
      }
      backgroundSnapshots = undefined
    }
    document.body.style.overflow = previousBodyOverflow
    return
  }

  if (backgroundSnapshots === undefined) {
    const modalLayers = new Set(modalStack.map(entry => entry.layer))
    backgroundSnapshots = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && !modalLayers.has(element as HTMLDivElement))
      .map(element => ({ element, ariaHidden: element.getAttribute('aria-hidden'), inert: element.inert === true }))
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    for (const snapshot of backgroundSnapshots) setModalElementState(snapshot.element, true)
  }

  const top = modalStack.at(-1)
  for (const entry of modalStack) setModalElementState(entry.layer, entry !== top)
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter(element => element.getAttribute('aria-hidden') !== 'true' && !element.closest('[inert]'))
}

export function cx(...classes: readonly (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function formatDate(value: string | undefined): string {
  if (value === undefined) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

export function formatRelative(value: string | undefined, now = Date.now()): string {
  if (value === undefined) return '—'
  const time = new Date(value).valueOf()
  if (Number.isNaN(time)) return value
  const seconds = Math.round((now - time) / 1000)
  if (Math.abs(seconds) < 60) return `${Math.max(0, seconds)}s ago`
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return `${Math.max(0, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return `${Math.max(0, hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

const labelOverrides: Record<string, string> = {
  'auth-required': 'Auth required',
  'action-required': 'Action required',
  'resync-required': 'Resync required',
  'not-started': 'Not started',
  'inconclusive': 'Inconclusive',
  'tofu-labelled': 'TOFU (labelled)',
  'user-known-hosts': 'User known hosts',
}

export function humanLabel(value: string | undefined): string {
  if (value === undefined || value.length === 0) return 'Unknown'
  return labelOverrides[value] ?? value.replace(/[-_]/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted'

export function toneFor(value: string | undefined): Tone {
  if (value === undefined) return 'muted'
  if (['succeeded', 'valid', 'verified', 'ready', 'complete', 'pass', 'completed'].includes(value)) return 'success'
  if (['failed', 'invalid', 'error', 'quarantined', 'archived'].includes(value)) return 'danger'
  if (['warning', 'unknown', 'stale', 'auth-required', 'action-required', 'inconclusive', 'partial'].includes(value)) return 'warning'
  if (['running', 'queued', 'collecting', 'validating', 'connecting', 'active', 'accepted'].includes(value)) return 'info'
  return 'neutral'
}

export function StatusBadge({ value, tone, label }: { value: string | undefined; tone?: Tone; label?: string }): ReactNode {
  const resolvedTone = tone ?? toneFor(value)
  return <span className={`slop-status slop-status-${resolvedTone}`}><span className="slop-status-dot" aria-hidden="true" />{label ?? humanLabel(value)}</span>
}

export function SectionHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }): ReactNode {
  const level = useContext(HeadingLevelContext)
  const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  return <div className="slop-section-heading">
    <div>
      <Heading>{title}</Heading>
      {description === undefined ? null : <p className="slop-section-description">{description}</p>}
    </div>
    {actions === undefined ? null : <div className="slop-section-actions">{actions}</div>}
  </div>
}

export function Button({ variant = 'primary', size = 'md', className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }): ReactNode {
  return <NativeButton {...props} variant={variant === 'secondary' ? 'outline' : variant === 'danger' ? 'primary' : variant} size={size} className={cx('slop-button', variant === 'danger' && 'slop-button-danger', className)}>{children}</NativeButton>
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton({ label, children, className, ...props }, ref) {
  return <NativeButton {...props} ref={ref} variant="ghost" size="sm" aria-label={label} title={label} className={cx('slop-icon-button', className)}>{children}</NativeButton>
})

export function TextInput({ label, hint, error, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }): ReactNode {
  const id = useId()
  return <label className="slop-field" htmlFor={id}>
    <span className="slop-field-label">{label}</span>
    <Input {...props} id={id} className={cx('slop-input-control', props.className, error !== undefined && 'slop-input-error')} aria-invalid={error !== undefined || undefined} aria-describedby={hint !== undefined || error !== undefined ? `${id}-hint` : undefined} />
    {error === undefined && hint === undefined ? null : <span id={`${id}-hint`} className={cx('slop-field-hint', error !== undefined && 'slop-field-error')}>{error ?? hint}</span>}
  </label>
}

export function TextArea({ label, hint, error, preview, onTogglePreview, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string; error?: string; preview?: boolean; onTogglePreview?: () => void }): ReactNode {
  const id = useId()
  return <label className="slop-field" htmlFor={id}>
    <span className="slop-field-label slop-field-label-row"><span>{label}</span>{onTogglePreview === undefined ? null : <button type="button" className="slop-inline-link" onClick={onTogglePreview}>{preview ? 'Edit' : 'Preview'}</button>}</span>
    <textarea {...props} id={id} className={cx('slop-input slop-textarea', props.className, error !== undefined && 'slop-input-error')} aria-invalid={error !== undefined || undefined} aria-describedby={hint !== undefined || error !== undefined ? `${id}-hint` : undefined} />
    {error === undefined && hint === undefined ? null : <span id={`${id}-hint`} className={cx('slop-field-hint', error !== undefined && 'slop-field-error')}>{error ?? hint}</span>}
  </label>
}

export function SelectInput({ label, options, hint, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: readonly { value: string; label: string; disabled?: boolean }[]; hint?: string }): ReactNode {
  const id = useId()
  return <label className="slop-field" htmlFor={id}>
    <span className="slop-field-label">{label}</span>
    <select {...props} id={id} className={cx('slop-input slop-select', props.className)} aria-describedby={hint === undefined ? undefined : `${id}-hint`}>{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select>
    {hint === undefined ? null : <span id={`${id}-hint`} className="slop-field-hint">{hint}</span>}
  </label>
}

export function Checkbox({ hint, ...props }: ComponentProps<typeof NativeCheckbox> & { hint?: string }): ReactNode {
  return <div className="slop-checkbox-field"><NativeCheckbox {...props} title={props.title ?? hint} />{hint === undefined ? null : <small>{hint}</small>}</div>
}

export function Panel({ children, className, ...props }: React.HTMLAttributes<HTMLElement>): ReactNode {
  const level = useContext(HeadingLevelContext)
  return <HeadingLevelContext.Provider value={nextHeadingLevel(level)}><section {...props} className={cx('slop-panel', className)}>{children}</section></HeadingLevelContext.Provider>
}

export function EmptyState({ title, description, action, tone = 'neutral' }: { title: string; description?: string; action?: ReactNode; tone?: Tone }): ReactNode {
  return <div className={cx('slop-empty', `slop-empty-${tone}`)} role="status"><div className="slop-empty-mark" aria-hidden="true">{tone === 'danger' ? '!' : tone === 'warning' ? '·' : '↳'}</div><h3>{title}</h3>{description === undefined ? null : <p>{description}</p>}{action === undefined ? null : <div className="slop-empty-action">{action}</div>}</div>
}

export function LoadingState({ label = 'Loading SLOP data' }: { label?: string }): ReactNode {
  return <div className="slop-loading" role="status" aria-live="polite"><span className="slop-spinner" aria-hidden="true" />{label}</div>
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }): ReactNode {
  return <div className="slop-error" role="alert"><strong>Could not load this view</strong><span>{error}</span>{onRetry === undefined ? null : <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button>}</div>
}

export function OfflineBanner({ status, detail, onRetry }: { status: 'offline' | 'stale' | 'resync-required'; detail?: string; onRetry?: () => void }): ReactNode {
  const copy = status === 'offline' ? 'Offline. Showing the last confirmed state.' : status === 'stale' ? 'Data is stale. Reconnect to refresh it.' : 'Reconnect to load the current state.'
  return <div className="slop-offline" role="status"><span className="slop-status-dot" aria-hidden="true" />{copy}{detail === undefined ? null : <small>{detail}</small>}{onRetry === undefined ? null : <Button variant="ghost" size="sm" onClick={onRetry}>Reconnect</Button>}</div>
}

export function Modal({ open, title, description, onClose, children, footer, size = 'default' }: { open: boolean; title: string; description?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'default' | 'wide' | 'full' }): ReactNode {
  const titleId = useId()
  const descriptionId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const modalId = useRef(Symbol('slop-modal'))
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const layer = layerRef.current
    const dialog = dialogRef.current
    if (!open || layer === null || dialog === null) return

    const entry: ModalStackEntry = {
      id: modalId.current,
      layer,
      dialog,
      close: () => { onCloseRef.current() },
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    }
    modalStack.push(entry)
    syncModalEnvironment()
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (modalStack.at(-1)?.id !== entry.id) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        entry.close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(entry.dialog)
      const first = focusable[0]
      const last = focusable.at(-1)
      const active = document.activeElement
      if (first === undefined || last === undefined) {
        event.preventDefault()
        entry.dialog.focus()
      } else if (event.shiftKey && (active === first || !entry.dialog.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !entry.dialog.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    const handleFocusIn = (event: FocusEvent): void => {
      if (modalStack.at(-1)?.id !== entry.id || entry.dialog.contains(event.target as Node)) return
      ;(focusableElements(entry.dialog)[0] ?? entry.dialog).focus()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('focusin', handleFocusIn, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      const index = modalStack.findIndex(candidate => candidate.id === entry.id)
      const wasTop = index === modalStack.length - 1
      if (index !== -1) modalStack.splice(index, 1)
      syncModalEnvironment()
      if (!wasTop) return
      const nextDialog = modalStack.at(-1)?.dialog
      if (entry.returnFocus?.isConnected && (nextDialog === undefined || nextDialog.contains(entry.returnFocus))) entry.returnFocus.focus()
      else if (nextDialog !== undefined) (focusableElements(nextDialog)[0] ?? nextDialog).focus()
    }
  }, [open])
  if (!open || typeof document === 'undefined') return null
  return createPortal(<div ref={layerRef} className="slop-modal-layer" data-slop-modal-layer="true" role="presentation">
    <div className="slop-modal-backdrop" aria-hidden="true" onClick={() => { onCloseRef.current() }} />
    <div ref={dialogRef} className={cx('slop-modal', size === 'wide' && 'slop-modal-wide', size === 'full' && 'slop-modal-full')} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description === undefined ? undefined : descriptionId} tabIndex={-1}>
      <div className="slop-modal-header"><div><h2 id={titleId}>{title}</h2>{description === undefined ? null : <p id={descriptionId}>{description}</p>}</div><IconButton ref={closeRef} label={`Close ${title}`} onClick={onClose}>×</IconButton></div>
      <HeadingLevelContext.Provider value={2}><div className="slop-modal-body">{children}</div></HeadingLevelContext.Provider>
      {footer === undefined ? null : <div className="slop-modal-footer">{footer}</div>}
    </div>
  </div>, document.body)
}

/** Element ids used by `Tabs` when `idPrefix` is given, so a caller can label its tab panels. */
export function tabElementIds(idPrefix: string, tabId: string): { tab: string; panel: string } {
  return { tab: `${idPrefix}-${tabId}-tab`, panel: `${idPrefix}-${tabId}-panel` }
}

export function Tabs({ items, active, onChange, ariaLabel = 'View sections', idPrefix }: { items: readonly { id: string; label: string; count?: number }[]; active: string; onChange: (id: string) => void; ariaLabel?: string; idPrefix?: string }): ReactNode {
  const generatedId = useId()
  const id = idPrefix ?? generatedId
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectTab = (index: number): void => {
    const item = items[index]
    if (item === undefined) return
    onChange(item.id)
    tabRefs.current[index]?.focus()
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (items.length === 0) return
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % items.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    selectTab(nextIndex)
  }
  return <div className="slop-tabs" role="tablist" aria-label={ariaLabel} aria-orientation="horizontal">{items.map((item, index) => <button
    key={item.id}
    ref={element => { tabRefs.current[index] = element }}
    id={tabElementIds(id, item.id).tab}
    type="button"
    role="tab"
    aria-selected={item.id === active}
    aria-controls={idPrefix === undefined ? undefined : tabElementIds(id, item.id).panel}
    tabIndex={item.id === active ? 0 : -1}
    className={cx('slop-tab', item.id === active && 'slop-tab-active')}
    onClick={() => { onChange(item.id) }}
    onKeyDown={event => { handleKeyDown(event, index) }}
  >{item.label}{item.count === undefined ? null : <span className="slop-tab-count">{item.count}</span>}</button>)}</div>
}

export function FilterBar({ children }: { children: ReactNode }): ReactNode {
  return <div className="slop-filter-bar">{children}</div>
}

export function Disclosure({ title, description, children, defaultOpen = false }: { title: string; description?: string; children: ReactNode; defaultOpen?: boolean }): ReactNode {
  return <details className="slop-disclosure" open={defaultOpen}><summary><span>{title}</span>{description === undefined ? null : <small>{description}</small>}</summary><div className="slop-disclosure-body">{children}</div></details>
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }): ReactNode {
  return <div className={`slop-notice slop-notice-${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>{children}</div>
}

export function RemoteError({ failure, onRetry }: { failure: RemoteFailure; onRetry?: () => void }): ReactNode {
  return <div className="slop-remote-error" role="alert"><span>{failure.message}</span>{failure.code === 'CONFLICT' ? <small>Reload the current revision before saving.</small> : null}{onRetry === undefined ? null : <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>}</div>
}
