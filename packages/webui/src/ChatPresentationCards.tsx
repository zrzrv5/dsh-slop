import { ChatCard } from './ChatCard.tsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { AuthTerminal } from './AuthTerminal.tsx'
import { useSlopUi } from './context.tsx'
import type { MachineConnectionPresentation, SnapshotProjection } from './types.ts'
import { Button, Disclosure, Notice, formatDate, formatRelative, humanLabel } from './ui.tsx'

export interface MachineConnectionChatCardProps {
  readonly node: ChatNode<'slop-machine-connection'>
}

export interface MachineTransferProgressChatCardProps {
  readonly node: ChatNode<'slop-machine-transfer-progress'>
}

const ANSI_CSI = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'gu')

/** Render terminal carriage returns as in-place line replacement. */
export function nativeTransferViewport(input: string): string {
  const text = input.replace(ANSI_CSI, '')
  const lines: string[] = []
  let current: string[] = []
  let cursor = 0
  for (const character of text) {
    if (character === '\r') { cursor = 0; continue }
    if (character === '\n') { lines.push(current.join('').trimEnd()); current = []; cursor = 0; continue }
    if (character === '\b') { cursor = Math.max(0, cursor - 1); continue }
    current[cursor] = character
    cursor += 1
  }
  if (current.length > 0) lines.push(current.join('').trimEnd())
  return lines.slice(-12).join('\n')
}

/** Live, bounded view of scp's own PTY output; the settled Tool card owns replay. */
export function MachineTransferProgressChatCard({ node }: MachineTransferProgressChatCardProps): ReactNode {
  const { client, state } = useSlopUi()
  const [output, setOutput] = useState('')

  useEffect(() => {
    if (state.enabled === false) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const result = await client.call('slop.transferProgress.get', { callId: node.data.toolCallId })
      if (stopped) return
      if (result.ok) setOutput(nativeTransferViewport(result.value.output))
      if (!node.data.settled && (!result.ok || result.value.status === 'running')) {
        timer = setTimeout(() => { void poll() }, 250)
      }
    }
    void poll()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [client, state.enabled, node.data.settled, node.data.toolCallId])

  return <>
    {node.data.machineIds.map(machineId => <MachineConnectionChatCard
      key={machineId}
      node={{ ...node, kind: 'slop-machine-connection', data: { machineId, toolCallId: node.data.toolCallId, settled: node.data.settled } } as ChatNode<'slop-machine-connection'>}
    />)}
    <ChatCard className="slop-transfer-progress" aria-live="polite" aria-label="File transfer progress">
      <small>scp · transferring through this Host</small>
      <pre>{output === '' ? 'Waiting for scp output…' : output}</pre>
    </ChatCard>
  </>
}


interface ActiveAuthFlow {
  readonly authFlowId: string
  readonly carrierFlowId: string
  readonly challengeId: string
  readonly presentationId: string
}

function freshnessRank(value: MachineConnectionPresentation['freshness']): number {
  if (value === 'current') return 2
  if (value === 'unknown') return 1
  return 0
}

function latestMachineConnection(
  rows: SnapshotProjection['machineConnections'] | undefined,
  target: Readonly<{ machineId?: string; machineName?: string }>,
): MachineConnectionPresentation | undefined {
  const candidates = rows?.filter(row => target.machineId === undefined
    ? row.machineLabel.toLocaleLowerCase() === target.machineName?.toLocaleLowerCase()
    : row.machineId === target.machineId)
  if (candidates === undefined || new Set(candidates.map(row => row.machineId)).size !== 1) return undefined
  return candidates.reduce<MachineConnectionPresentation | undefined>((latest, row) => {
    if (latest === undefined) return row
    const freshness = freshnessRank(row.freshness) - freshnessRank(latest.freshness)
    if (freshness !== 0) return freshness > 0 ? row : latest
    if (row.updatedAt !== latest.updatedAt) return row.updatedAt > latest.updatedAt ? row : latest
    if (row.revision !== latest.revision) return row.revision > latest.revision ? row : latest
    return row.id < latest.id ? row : latest
  }, undefined)
}

function challengeLabel(presentation: MachineConnectionPresentation): string {
  const connection = presentation.connection
  if (connection.state === 'ready') return 'Machine connected'
  if (connection.state !== 'blocked') return humanLabel(connection.state)
  switch (connection.challenge.kind) {
    case 'host-trust': return connection.challenge.change === 'changed-key' ? 'Host key changed' : 'Host key review'
    case 'authentication': return 'Authentication required'
    case 'reconnect': return 'Reconnect required'
    default: {
      const exhaustive: never = connection.challenge
      return exhaustive
    }
  }
}

function connectionDetail(presentation: MachineConnectionPresentation): ReactNode {
  const connection = presentation.connection
  switch (connection.state) {
    case 'blocked': {
      const challenge = connection.challenge
      switch (challenge.kind) {
        case 'host-trust': return <><p>{connection.reason}</p><dl className="slop-definition-list"><div><dt>Host</dt><dd>{challenge.host} · {challenge.algorithm} · {humanLabel(challenge.change)}</dd></div><div><dt>Exact fingerprint</dt><dd><code>{challenge.fingerprint}</code></dd></div></dl></>
        case 'authentication': return <><p>{connection.reason}</p><p>Prompt {humanLabel(challenge.authentication.promptState)} · carrier {humanLabel(challenge.authentication.carrierState)} · flow {humanLabel(challenge.authentication.flowState)}</p></>
        case 'reconnect': return <p>{challenge.reason}</p>
        default: {
          const exhaustive: never = challenge
          return exhaustive
        }
      }
    }
    case 'ready': return <p>Connection verified at {formatDate(connection.observedAt)}. Lease readiness expires {formatDate(connection.expiresAt)}.</p>
    case 'stale': return <p>{connection.reason} Last ready {formatRelative(connection.lastReadyAt)}.</p>
    case 'disconnected': return <p>{connection.reason}</p>
    case 'checking': return <p>Checking the current Machine access path.</p>
    case 'connecting': return <p>Opening the declared Machine access path.</p>
    case 'disconnecting': return <p>Closing the Machine connection.</p>
    default: {
      const exhaustive: never = connection
      return exhaustive
    }
  }
}

/** Separate, projection-backed access card. It never renders ordinary Tool JSON. */
export function MachineConnectionChatCard({ node }: MachineConnectionChatCardProps): ReactNode {
  const { client, store, state, snapshot, navigate, reload } = useSlopUi()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [authFlow, setAuthFlow] = useState<ActiveAuthFlow>()
  const [, updateClock] = useState(0)
  const observedPresentationId = useRef<string>()
  const automaticAuthenticationAttempt = useRef<string>()
  const presentation = latestMachineConnection(snapshot?.machineConnections, node.data)
  const presentationId = presentation?.id

  useEffect(() => {
    if (!node.data.settled) void store.load()
  }, [store, node.data.toolCallId, node.data.settled])

  if (presentation?.connection.state === 'blocked' && observedPresentationId.current === undefined) {
    observedPresentationId.current = presentation.id
  }
  const isObservedPresentation = presentation !== undefined
    && observedPresentationId.current !== undefined
    && observedPresentationId.current === presentation.id
  const blocked = isObservedPresentation && presentation.connection.state === 'blocked'
    ? presentation.connection
    : undefined
  const challengeId = blocked?.challengeId
  const challengeRevision = blocked?.challengeRevision
  const challengeExpiresAt = blocked?.expiresAt
  const challengeExpired = challengeExpiresAt !== undefined && Date.parse(challengeExpiresAt) <= Date.now()
  useEffect(() => {
    if (challengeExpiresAt === undefined) return
    const remaining = Date.parse(challengeExpiresAt) - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => { updateClock(value => value + 1) }, remaining)
    return () => { clearTimeout(timer) }
  }, [challengeExpiresAt])
  const challengeRef = challengeId === undefined || challengeRevision === undefined ? undefined : {
    challengeId,
    expectedChallengeRevision: challengeRevision,
  }
  const canStartAuthentication = state.enabled !== false && blocked?.challenge.kind === 'authentication'
    && !challengeExpired && !node.data.settled
    && state.status === 'ready'
    && presentation !== undefined
    && presentation.actions.some(action => action === 'start-authentication'
      || action === 'start-new-flow'
      || action === 'retry-carrier')
  const automaticAuthenticationKey = canStartAuthentication ? `${presentation.machineId}:${challengeId}` : undefined
  const startAuthentication = useCallback(async (): Promise<void> => {
    if (store.getSnapshot().enabled === false || challengeId === undefined || challengeRevision === undefined || presentationId === undefined
      || challengeExpiresAt === undefined || Date.parse(challengeExpiresAt) <= Date.now() || node.data.settled) {
      setError('The authentication challenge is no longer current.')
      return
    }
    const requestedChallenge = {
      challengeId,
      expectedChallengeRevision: challengeRevision,
    }
    setBusy(true)
    setError(undefined)
    const result = await client.call('slop.authFlow.start', requestedChallenge)
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      if (result.error.code === 'CONFLICT' || result.error.code === 'STALE') await reload()
      return
    }
    const returnedRevision = result.value.challenge.revision
    if (result.value.scope !== 'machine'
      || result.value.challenge.id !== requestedChallenge.challengeId
      || (returnedRevision !== requestedChallenge.expectedChallengeRevision
        && returnedRevision !== requestedChallenge.expectedChallengeRevision + 1)) {
      setError('The protected authentication flow does not match this Machine challenge.')
      return
    }
    setAuthFlow({
      authFlowId: result.value.authFlowId,
      carrierFlowId: result.value.carrierFlowId,
      challengeId: requestedChallenge.challengeId,
      presentationId,
    })
  }, [store, challengeId, challengeRevision, challengeExpiresAt, client, presentationId, node.data.settled, reload])

  useEffect(() => {
    if (store.getSnapshot().status !== 'ready' || automaticAuthenticationKey === undefined
      || automaticAuthenticationAttempt.current === automaticAuthenticationKey) return
    automaticAuthenticationAttempt.current = automaticAuthenticationKey
    void startAuthentication()
  }, [automaticAuthenticationKey, startAuthentication, store])

  if (presentation === undefined && state.enabled === false) return <ChatCard><strong>{node.data.machineName ?? node.data.machineId ?? 'Machine'}</strong><p>Historical connection request. Details remain in the original tool result; Machine operations are disabled.</p></ChatCard>
  if (presentation === undefined || !isObservedPresentation) return null

  const run = async (operation: () => Promise<string | undefined>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    const failure = await operation()
    setBusy(false)
    if (failure !== undefined) { setError(failure); return }
    await reload()
  }
  const decideTrust = async (decision: 'trust-once' | 'trust-and-pin' | 'reject'): Promise<string | undefined> => {
    if (challengeRef === undefined || blocked?.challenge.kind !== 'host-trust') return 'The host-key challenge is no longer current.'
    const result = await client.call('slop.hostTrust.decide', { ...challengeRef, decision, fingerprint: blocked.challenge.fingerprint })
    return result.ok ? undefined : result.error.message
  }
  const actions = new Set(presentation.actions)
  const authFlowMatchesPresentation = authFlow?.presentationId === presentation.id
  const activeAuthFlow = state.enabled !== false && authFlow !== undefined
    && authFlowMatchesPresentation
    && blocked?.challenge.kind === 'authentication'
    && authFlow.challengeId === blocked.challengeId
    ? authFlow
    : undefined
  const authenticationCompleted = authFlowMatchesPresentation && presentation.connection.state === 'ready'
  const visibleError = presentation.connection.state === 'ready' || challengeExpired ? undefined : error
  return <ChatCard className={`slop-conversation-card slop-conversation-card-${presentation.connection.state}`} data-slop-presentation="machine-connection" data-presentation-id={presentation.id} data-presentation-revision={presentation.revision}>
    <div className="slop-conversation-card-main">
      <div className="slop-machine-summary"><strong>{presentation.machineLabel}</strong><span>{challengeLabel(presentation)}</span></div>
      {challengeExpired ? <p>Sign-in expired. Connect again in this Chat.</p> : connectionDetail(presentation)}
      {blocked === undefined ? null : <Disclosure title="Connection details"><small>Challenge <code>{blocked.challengeId}</code> · revision {blocked.challengeRevision} · expires {formatDate(blocked.expiresAt)}{presentation.waitingSessionCount > 1 ? ` · ${presentation.waitingSessionCount} Chats waiting` : ''}</small></Disclosure>}
      {visibleError === undefined ? null : <Notice tone="danger">{visibleError}</Notice>}
      {blocked === undefined || challengeExpired || node.data.settled ? null : <div className="slop-row-actions">
        {blocked.challenge.kind === 'host-trust' && actions.has('trust-fingerprint') ? <><Button size="sm" variant="secondary" disabled={busy} onClick={() => { void run(async () => await decideTrust('trust-once')) }}>Trust once</Button><Button size="sm" disabled={busy} onClick={() => { void run(async () => await decideTrust('trust-and-pin')) }}>{busy ? 'Applying…' : 'Trust and pin'}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(async () => await decideTrust('reject')) }}>Reject</Button></> : null}
        {blocked.challenge.kind === 'authentication' && (actions.has('start-authentication') || actions.has('start-new-flow') || actions.has('retry-carrier')) ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void startAuthentication() }}>{busy ? 'Opening…' : 'Open protected sign-in'}</Button> : null}
        {actions.has('open-machine-settings') ? <Button size="sm" variant="ghost" onClick={() => { navigate({ kind: 'machines', machineId: presentation.machineId }) }}>Open Machine settings</Button> : null}
      </div>}
      {authenticationCompleted
        ? <section className="slop-auth-embedded" aria-label="SSH sign-in"><Notice tone="success">Authentication completed</Notice></section>
        : activeAuthFlow === undefined || challengeExpired || node.data.settled
          ? null
          : <AuthTerminal embedded retainCompletion client={client} authFlowId={activeAuthFlow.authFlowId} carrierFlowId={activeAuthFlow.carrierFlowId} onClose={() => { setAuthFlow(undefined) }} onReady={reload} />}
    </div>
  </ChatCard>
}
