import styles from './ChatStatus.module.css'
import { clsx } from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatPopover } from './ChatPopover.tsx'
import { connectionForMachine } from './MachineSettings.tsx'
import { useSlopUi } from './context.tsx'
import type { MachineProjection, MachineConnectionPresentation } from './types.ts'
import { formatDate } from './ui.tsx'

export function machineChipStatus(machine: MachineProjection, presentation: MachineConnectionPresentation | undefined, online: boolean, now: number) {
  if (!online) return { label: 'Status unavailable', tone: 'yellow', connect: false }
  if (machine.kind === 'local') return { label: 'Ready', tone: 'green', connect: false }
  const connection = presentation?.connection
  if (presentation?.freshness !== 'current') return { label: 'Not connected', tone: 'neutral', connect: true }
  switch (connection?.state) {
    case 'ready': return Date.parse(connection.expiresAt) > now
      ? { label: 'Connected', tone: 'green', connect: false }
      : { label: 'Stale', tone: 'yellow', connect: true }
    case 'checking': case 'connecting': return { label: 'Connecting', tone: 'yellow', connect: false }
    case 'disconnecting': return { label: 'Disconnecting', tone: 'yellow', connect: false }
    case 'blocked': return { label: connection.challenge.kind === 'host-trust' ? 'Review host key' : 'Authentication needed', tone: 'yellow', connect: true }
    case 'stale': return { label: 'Stale', tone: 'yellow', connect: true }
    default: return { label: machine.connectionState === 'error' ? 'Connection failed' : 'Not connected', tone: machine.connectionState === 'error' ? 'red' : 'neutral', connect: true }
  }
}

type Props = Pick<PropsRuntime<'conversation.session.header'>, 'useInput' | 'inputActions' | 'sessionId'>

export function machineChipDetails(machine: MachineProjection) {
  const scheduler = machine.scheduler ?? machine.schedulerPreference ?? machine.baseConfiguration.preferredExecutionProviderId
  const scheduled = scheduler !== undefined && !['none', 'local', 'direct', 'unknown'].includes(scheduler)
  const host = machine.host ?? machine.target ?? machine.sshAlias ?? (machine.kind === 'local' ? 'Local Host' : 'Saved SSH target')
  const endpoint = `${machine.username && !host.includes('@') ? `${machine.username}@` : ''}${host}${machine.port && machine.port !== 22 ? `:${machine.port}` : ''}`
  return { scheduled, endpoint, scheduler: scheduler === 'local' || scheduler === 'direct' ? 'none' : scheduler ?? 'unknown' }
}

function MachineIcon({ scheduled }: { scheduled: boolean }) {
  return <svg className={styles['slop-machine-icon']} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
    {scheduled ? <><rect x="2" y="2" width="12" height="5" rx="1.5" /><rect x="2" y="9" width="12" height="5" rx="1.5" /><path d="M4 4.5h1m-1 7h1M8 4.5h4m-4 7h4" /></> : <><rect x="1.5" y="2" width="13" height="9" rx="1.5" /><path d="M8 11v3m-3 0h6" /></>}
  </svg>
}

/** Saved targets, never a global current-Machine selector. Connect uses ordinary Chat. */
export function ChatMachineChips({ useInput, inputActions, sessionId }: Props): ReactNode {
  const { client, snapshot, state } = useSlopUi()
  const [machines, setMachines] = useState<readonly MachineProjection[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const input = useInput((value: InputState) => value)
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await client.call('slop.machine.list', {})
        if (stopped) return
        setNow(Date.now())
        if (result.ok) { setMachines(result.value); setError(undefined) } else setError(result.error.message)
      } catch { if (!stopped) setError('Machine inventory unavailable.') }
      if (!stopped) timer = setTimeout(() => { void refresh() }, 15_000)
    }
    void refresh()
    return () => { stopped = true; clearTimeout(timer) }
  }, [client])
  useEffect(() => { setSelected(undefined); setNotice(undefined) }, [sessionId])
  const active = machines.find(machine => machine.id === selected)
  const connect = (machine: MachineProjection) => {
    if (input.phase !== 'plain' || input.draft.length > 0 || input.attachmentIds.length > 0) {
      setNotice('Send or clear the current draft before connecting. Your draft has been kept.')
      return
    }
    inputActions.setDraft(`Connect to the saved Machine ${JSON.stringify(machine.name)} using slop_machine_connect with machineId ${JSON.stringify(machine.id)}. Only establish access; do not run discovery or other commands.`)
    inputActions.submit()
    setNotice('Connection requested in this Chat. Complete any authentication in the protected Chat card.')
  }
  if (machines.length === 0 && error === undefined) return null
  return <div className={styles['slop-chat-machine-chips']} aria-label="Machines">
    <div className={styles['slop-chat-machine-strip']}>
      {machines.map(machine => {
        const status = machineChipStatus(machine, connectionForMachine(snapshot, machine.id), state.connected && error === undefined, now)
        const details = machineChipDetails(machine)
        return <Tooltip key={machine.id} side="bottom" delayMs={250} disabled={selected === machine.id} label={`${details.endpoint} · Scheduler: ${details.scheduler} · ${status.label}`}><button type="button" className={styles['slop-chat-chip']} aria-label={`${machine.name} ${status.label}`} aria-haspopup="dialog" aria-expanded={selected === machine.id}
          onClick={() => {
            if (selected === machine.id) { setSelected(undefined); return }
            setSelected(machine.id); setNotice(undefined)
            if (status.connect && status.label !== 'Authentication needed' && status.label !== 'Review host key') connect(machine)
          }}>
          <span className={clsx(styles['slop-chat-dot'], styles[`slop-chat-${status.tone}`])} aria-hidden="true" /><MachineIcon scheduled={details.scheduled} />{machine.name}<small>{status.label}</small>
        </button></Tooltip>
      })}
      {error === undefined ? null : <small className={styles['slop-chat-yellow']} role="status">{error}</small>}
    </div>
    {active === undefined ? null : <ChatPopover label={active.name} close={() => setSelected(undefined)}>
      <p>{machineChipDetails(active).endpoint}</p>
      <small>Scheduler: {machineChipDetails(active).scheduler}</small>
      <small>Last connection observation: {formatDate(connectionForMachine(snapshot, active.id)?.updatedAt)}</small>
      {notice === undefined && active.kind !== 'local' ? <button type="button" className={styles['slop-chat-chip']} onClick={() => connect(active)}>Connect in this Chat</button> : null}
      {notice === undefined ? null : <p role="status">{notice}</p>}
    </ChatPopover>}
  </div>
}
