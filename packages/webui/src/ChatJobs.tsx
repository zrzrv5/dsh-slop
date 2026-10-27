import styles from './ChatStatus.module.css'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { readChatQueue, refreshChatQueueItem, type ChatQueueItem } from './chat-queue-client.ts'
import { useSlopUi } from './context.tsx'
import { formatDate } from './ui.tsx'

const priority = { failed: 0, unknown: 1, running: 2, queued: 3, cancelled: 4, completed: 5 }
export function jobTone(state: ChatQueueItem['state']): string {
  return state === 'failed' ? 'red' : state === 'running' || state === 'completed' ? 'green' : state === 'queued' || state === 'unknown' ? 'yellow' : 'neutral'
}

function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}

export function observationAge(value: string | undefined, now: number): string {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return '—'
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds} s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  return `${Math.floor(seconds / 3600)} hr ago`
}

/** Polls saved observations; only an explicit refresh starts a deterministic probe. */
export function ChatJobs({ sessionId }: { sessionId: string }): ReactNode {
  const { snapshot } = useSlopUi()
  const [items, setItems] = useState<ChatQueueItem[]>([])
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string>()
  const [checking, setChecking] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const checkItem = useRef<(id: string) => Promise<void>>()
  const bodyId = useId()
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let manual = false
    let generation = 0
    setItems([]); setOpen(false); setError(undefined); setSelected(undefined); setChecking(undefined)
    const refresh = async (id?: string) => {
      if (manual) return
      const request = ++generation
      if (id !== undefined) { manual = true; setChecking(id) }
      try {
        const rows = id === undefined ? await readChatQueue(sessionId, controller.signal)
          : await refreshChatQueueItem(sessionId, id, controller.signal)
        if (!controller.signal.aborted && request === generation) { setItems(rows.sort((a, b) => priority[a.state] - priority[b.state])); setError(undefined) }
      } catch (err) { if (!controller.signal.aborted && request === generation) setError(err instanceof Error ? err.message : 'Queue unavailable.') }
      finally { if (id !== undefined) { manual = false; if (!controller.signal.aborted) setChecking(undefined) } }
    }
    checkItem.current = refresh
    const poll = async () => {
      await refresh()
      if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 10_000)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer); checkItem.current = undefined }
  }, [sessionId])
  const machineName = (item: ChatQueueItem) => item.machineId === undefined ? 'Host'
    : snapshot?.machineConnections.find(row => row.machineId === item.machineId)?.machineLabel ?? item.machineId
  const machines = [...new Map(items.map(item => [item.machineId ?? 'local', machineName(item)])).values()]
  const current = items.find(item => item.id === selected)
  if (items.length === 0 && error === undefined) return null
  return <section className={styles['slop-chat-jobs']} aria-label="Jobs">
    <button type="button" className={styles['slop-chat-jobs-summary']} aria-controls={bodyId} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={styles['slop-chat-jobs-icon']} aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 5h1m2 0h3M5 8h1m2 0h3M5 11h1m2 0h3" /></svg></span>
      <span className={styles['slop-chat-jobs-title']}>Jobs</span>
      <span className={styles['slop-chat-jobs-progress']} title={`${items.length} jobs · ${machines.length} machines · ${machines.join(', ')}`}>{items.length === 0 && error !== undefined ? 'Unavailable' : <><span>{items.length} {items.length === 1 ? 'job' : 'jobs'}</span><span className={styles['slop-chat-jobs-machines']}> · {machines.length} {machines.length === 1 ? 'machine' : 'machines'}</span><span className={styles['slop-chat-jobs-names']}>{machines.length <= 2 ? ` · ${machines.join(', ')}` : ''}</span></>}</span>
      <span className={styles['slop-chat-job-counts']}>{Object.keys(priority).map(key => {
        const rows = items.filter(item => item.state === key)
        const first = rows[0]
        return first === undefined ? null : <span className={styles[`slop-chat-${jobTone(first.state)}`]} key={key}>{rows.length} {key}</span>
      })}{error === undefined ? null : <span className={styles['slop-chat-yellow']}>Status unavailable</span>}</span>
      <span className={styles['slop-chat-jobs-icon']} aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25"><path d={open ? 'm4 6 4 4 4-4' : 'm4 10 4-4 4 4'} /></svg></span>
    </button>
    {open ? <div id={bodyId} className={styles['slop-chat-jobs-body']} role="region" aria-label="Jobs in this Chat" tabIndex={0}>
      {error === undefined ? null : <p className={styles['slop-chat-yellow']} role="status">{error} Showing last received observations.</p>}
      <div className={styles['slop-chat-table-scroll']}><table className={styles['slop-chat-job-table']}><thead><tr><th>Job / ID</th><th>Machine</th><th>Status</th><th>Elapsed</th><th>Observed</th></tr></thead>
        <tbody>{items.map(item => <tr key={item.id}>
          <td><button type="button" onClick={() => setSelected(item.id)}>{item.label}</button><small>{item.observerKind} #{item.observerId}{item.relation === 'subscribed' ? ' · subscribed' : ''}</small></td>
          <td>{machineName(item)}</td><td><span className={styles[`slop-chat-${jobTone(item.state)}`]}>{item.state}</span>{item.observationSource==='webhook'?<small>webhook{item.awaitingVerification?' · verifying':''}</small>:null}{item.checkError === undefined ? null : <small className={styles['slop-chat-yellow']}>Probe failed</small>}</td>
          <td>{duration(item.elapsedSeconds)}</td><td><span className={styles['slop-chat-observation']}>
            <span title={formatDate(item.observedAt)}>{observationAge(item.observedAt, now)}</span>
            <button type="button" aria-label={`Refresh ${item.label}`} title="Check status now" disabled={checking !== undefined} aria-busy={checking === item.id} onClick={() => { void checkItem.current?.(item.id) }}>
              {checking === item.id ? '…' : '↻'}
            </button>
          </span></td>
        </tr>)}</tbody></table></div>
      {current === undefined ? null : <div className={styles['slop-chat-job-evidence']}><strong>{current.label}</strong><small>Last observation <span title={formatDate(current.observedAt)}>{observationAge(current.observedAt, now)}</span> · Next check {formatDate(current.nextCheckAt)}</small>
        <small>Started {formatDate(current.startedAt)} · Source {current.observationSource ?? 'unknown'}{current.phase===undefined?'':` · Phase ${current.phase}`}</small>
        <small>Tracking: {current.purpose ?? ('legacy ' + current.delivery)} · {current.deliveryStatus?.replaceAll('-', ' ')}</small>
        {current.continuation === undefined ? null : <p>Next: {current.continuation}</p>}
        {current.deliveryError === undefined ? null : <p className={styles['slop-chat-yellow']}>{current.deliveryError}</p>}
        {current.checkError === undefined ? null : <p className={styles['slop-chat-yellow']}>{current.checkError}</p>}
        <pre>{current.evidence ?? 'No observation yet.'}</pre></div>}
    </div> : null}
  </section>
}
