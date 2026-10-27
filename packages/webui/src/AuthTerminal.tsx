import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SlopRemoteClient } from './remote-client.ts'
import { Button, Modal, Notice, SectionHeading } from './ui.tsx'

type CarrierState = 'connecting' | 'attached' | 'closed' | 'error'
type FlowState = 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired'

const promptWaitWarningMs = 8_000

function emptyTerminalMessage(carrierState: CarrierState, flowState: FlowState, promptDelayed: boolean): string {
  if (flowState === 'ready') return 'SSH connection ready.'
  if (flowState === 'failed') return 'SSH sign-in ended before the connection was established.'
  if (flowState === 'expired') return 'SSH sign-in expired before it completed.'
  if (flowState === 'cancelled') return 'SSH sign-in was cancelled.'
  if (carrierState === 'error') return 'No host prompt was received because the protected terminal connection failed.'
  if (carrierState === 'closed') return 'The protected terminal disconnected before the host prompt was received.'
  if (carrierState === 'connecting') return promptDelayed
    ? 'The protected SSH terminal did not finish connecting.'
    : 'Opening the protected SSH terminal…'
  return promptDelayed
    ? 'Protected terminal attached, but the host has not sent an SSH prompt yet.'
    : 'Protected terminal attached. Waiting for OpenSSH to print the host prompt…'
}

function terminalNotice(carrierState: CarrierState, flowState: FlowState, promptDelayed: boolean, pollError: string | undefined): { tone: 'warning' | 'danger'; text: string } | undefined {
  if (flowState === 'failed') return { tone: 'danger', text: 'SSH rejected or closed this sign-in. Cancel it, then start sign-in again.' }
  if (flowState === 'expired') return { tone: 'warning', text: 'This protected sign-in expired. Cancel it, then start a new sign-in.' }
  if (flowState === 'cancelled') return { tone: 'warning', text: 'This sign-in is no longer active.' }
  if (pollError !== undefined) return { tone: 'danger', text: pollError }
  if (carrierState === 'error') return { tone: 'danger', text: 'The protected terminal could not connect. Reconnect it; if DSH was restarted, reload this page first.' }
  if (carrierState === 'closed') return { tone: 'warning', text: 'The protected terminal disconnected. Reconnect it to recover the live host prompt.' }
  if (promptDelayed) return carrierState === 'connecting'
    ? { tone: 'warning', text: 'The protected terminal connection is taking too long. Reconnect it; if DSH was restarted, reload this page.' }
    : { tone: 'warning', text: 'The terminal is connected but SSH is silent. Check VPN access, then reconnect if needed.' }
  return undefined
}

/** Shared protected SSH prompt used by Machine details and Chat setup. */
export function AuthTerminal({ client, authFlowId, carrierFlowId, onClose, onReady, embedded = false, retainCompletion = false }: { client: SlopRemoteClient; authFlowId: string; carrierFlowId: string; onClose: () => void; onReady: () => Promise<void>; embedded?: boolean; retainCompletion?: boolean }): ReactNode {
  const [output, setOutput] = useState('')
  const [input, setInput] = useState('')
  const [carrierState, setCarrierState] = useState<CarrierState>('connecting')
  const [flowState, setFlowState] = useState<FlowState>('pending')
  const [pollError, setPollError] = useState<string | undefined>()
  const [promptDelayed, setPromptDelayed] = useState(false)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const outputRef = useRef('')
  const terminalRef = useRef<{ send(text: string): void; close(): void } | undefined>(undefined)
  const onReadyRef = useRef(onReady)
  const readyHandledRef = useRef(false)
  onReadyRef.current = onReady

  useEffect(() => { readyHandledRef.current = false }, [authFlowId])

  useEffect(() => {
    let disposed = false
    let pollTimer: number | undefined
    let promptTimer: number | undefined
    let terminal: { send(text: string): void; close(): void } | undefined
    setCarrierState('connecting')
    setFlowState('pending')
    setPollError(undefined)
    setPromptDelayed(false)
    setOutput('')
    outputRef.current = ''
    setInput('')

    const schedulePromptWarning = (): void => {
      if (promptTimer !== undefined) window.clearTimeout(promptTimer)
      promptTimer = window.setTimeout(() => {
        if (!disposed && outputRef.current.length === 0) setPromptDelayed(true)
      }, promptWaitWarningMs)
    }

    if (client.auth === undefined) {
      setCarrierState('error')
      setPollError('The protected authentication terminal is unavailable in this DSH composition.')
      return () => { disposed = true }
    }

    try {
      schedulePromptWarning()
      terminal = client.auth.open(carrierFlowId, text => {
        if (disposed) return
        setCarrierState(current => current === 'connecting' ? 'attached' : current)
        setPromptDelayed(false)
        const next = `${outputRef.current}${text}`.slice(-65_536)
        outputRef.current = next
        setOutput(next)
      }, next => {
        if (disposed) return
        setCarrierState(current => current === 'error' && next === 'closed' ? current : next)
        if (next === 'attached') {
          setPollError(undefined)
          schedulePromptWarning()
        }
      })
      terminalRef.current = terminal
    } catch (reason) {
      setCarrierState('error')
      setPollError(reason instanceof Error ? reason.message : 'The protected SSH terminal could not be opened.')
    }

    const poll = async (): Promise<void> => {
      if (disposed) return
      const result = await client.call('slop.authFlow.status', { authFlowId })
      if (disposed) return
      if (!result.ok) {
        setPollError(result.error.message)
        pollTimer = window.setTimeout(() => { void poll() }, 1_000)
        return
      }
      setPollError(undefined)
      setFlowState(result.value.state)
      if (result.value.state === 'ready') {
        terminal?.close()
        terminalRef.current = undefined
        if (!readyHandledRef.current) {
          readyHandledRef.current = true
          await onReadyRef.current()
        }
        return
      }
      if (result.value.state === 'failed' || result.value.state === 'expired' || result.value.state === 'cancelled') {
        terminal?.close()
        terminalRef.current = undefined
        return
      }
      pollTimer = window.setTimeout(() => { void poll() }, 1_000)
    }
    pollTimer = window.setTimeout(() => { void poll() }, 1_000)

    return () => {
      disposed = true
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
      if (promptTimer !== undefined) window.clearTimeout(promptTimer)
      terminal?.close()
      if (terminalRef.current === terminal) terminalRef.current = undefined
    }
  }, [authFlowId, carrierFlowId, client, connectionAttempt])

  const send = (): void => {
    if (input.length === 0) return
    try {
      const value = input
      setInput('')
      terminalRef.current?.send(`${value}\n`)
    } catch (reason) {
      setPollError(reason instanceof Error ? reason.message : 'Authentication input could not be sent.')
    }
  }
  const cancel = async (): Promise<void> => {
    const result = await client.call('slop.authFlow.cancel', { authFlowId })
    if (!result.ok) setPollError(result.error.message)
    onClose()
  }
  const reconnect = (): void => { setConnectionAttempt(value => value + 1) }
  const notice = terminalNotice(carrierState, flowState, promptDelayed, pollError)
  const reconnectable = flowState === 'pending' && (carrierState === 'closed' || carrierState === 'error' || promptDelayed)
  const canRespond = flowState === 'pending' && carrierState === 'attached' && input.length > 0
  if (flowState === 'ready' && retainCompletion) {
    return <section className="slop-auth-embedded" aria-label="SSH sign-in"><Notice tone="success">Authentication completed</Notice></section>
  }
  const content = <>
    <pre className="slop-log-output slop-auth-output" aria-live="polite">{output || emptyTerminalMessage(carrierState, flowState, promptDelayed)}</pre>
    <label className="slop-field">
      <span className="slop-field-label">SSH response</span>
      <input aria-label="SSH response" data-slop-auth-flow={authFlowId} className="slop-input" type="password" autoComplete="off" autoFocus value={input} disabled={flowState !== 'pending' || carrierState !== 'attached'} onChange={event => { setInput(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); send() } }} />
      <span className="slop-field-hint">Enter only the requested password, Duo choice, or one-time code. The app clears it after sending and never saves it.</span>
    </label>
    {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
    <div className="slop-auth-actions">
      <Button variant="ghost" onClick={() => { void cancel() }}>Cancel sign-in</Button>
      {carrierState === 'error' || (carrierState === 'connecting' && promptDelayed) ? <Button variant="ghost" onClick={() => { globalThis.location.reload() }}>Reload DSH</Button> : null}
      {reconnectable ? <Button variant="secondary" onClick={reconnect}>Reconnect terminal</Button> : null}
      <Button onClick={send} disabled={!canRespond}>Send response</Button>
    </div>
  </>
  if (embedded) return <section className="slop-auth-embedded" aria-label="SSH sign-in"><SectionHeading title="Sign in to SSH" description="The host's live SSH prompt appears below. Setup continues automatically after authentication succeeds." />{content}</section>
  return <Modal open title="SSH authentication terminal" description="This protected PTY is owner-bound. Input bytes and terminal output are never written to the DSH conversation or product database." onClose={() => { void cancel() }} footer={null}>{content}</Modal>
}
