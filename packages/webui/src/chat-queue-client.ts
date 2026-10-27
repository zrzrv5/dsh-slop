import { browserBoot, refreshBrowserBoot } from './browser-boot.ts'

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function queueState(value: unknown): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | undefined {
  switch (value) {
    case 'queued': case 'running': case 'completed': case 'failed': case 'cancelled': case 'unknown': return value
    default: return undefined
  }
}

function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

export function decodeChatQueue(value: unknown, sessionId: string) {
  const view = record(value)
  if (view?.schemaVersion !== 1 || view.sessionId !== sessionId || !Array.isArray(view.items)) throw new Error('Invalid Chat Queue response.')
  return view.items.map((value: unknown) => {
    const item = record(value)
    const target = record(item?.target)
    const state = queueState(item?.state)
    if (item === undefined || typeof item.id !== 'string' || typeof item.label !== 'string' || state === undefined
      || typeof item.observerId !== 'string' || typeof item.observerKind !== 'string'
      || (item.relation !== 'owned' && item.relation !== 'subscribed')
      || (target?.kind !== 'local' && !(target?.kind === 'machine' && typeof target.machineId === 'string'))) throw new Error('Invalid Chat Queue item.')
    return {
      purpose: text(item.purpose), continuation: text(item.continuation), delivery: text(item.delivery), deliveryStatus: text(item.deliveryStatus), deliveryError: text(item.deliveryError),
      id: item.id, label: item.label, state, observerId: item.observerId, observerKind: item.observerKind,
      relation: item.relation, machineId: target.kind === 'local' ? undefined : text(target.machineId),
      observedAt: text(item.observedAt), evidence: text(item.evidence), nextCheckAt: text(item.nextCheckAt), checkError: text(item.checkError),
      observationSource: text(item.observationSource), startedAt: text(item.startedAt), phase: text(item.phase), awaitingVerification: item.awaitingVerification === true,
      elapsedSeconds: typeof item.elapsedSeconds === 'number' && Number.isFinite(item.elapsedSeconds) && item.elapsedSeconds >= 0 ? item.elapsedSeconds : undefined,
    }
  })
}

export type ChatQueueItem = ReturnType<typeof decodeChatQueue>[number]

/** Read persisted observations; polling this endpoint never probes or wakes an Agent. */
export async function readChatQueue(sessionId: string, signal: AbortSignal): Promise<ChatQueueItem[]> {
  return await requestChatQueue(sessionId, signal)
}

/** Explicit one-item deterministic check; never launches an Agent. */
export async function refreshChatQueueItem(sessionId: string, id: string, signal: AbortSignal): Promise<ChatQueueItem[]> {
  return await requestChatQueue(sessionId, signal, id)
}

async function requestChatQueue(sessionId: string, signal: AbortSignal, id?: string): Promise<ChatQueueItem[]> {
  const boot = browserBoot() ?? await refreshBrowserBoot()
  if (boot === undefined) throw new Error('Chat Queue is unavailable.')
  const send = (nonce: string) => fetch(id === undefined ? `${boot.queueSettingsBridgePath}?${new URLSearchParams({ view: 'chat', sessionId })}` : boot.queueSettingsBridgePath, {
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'x-dsh-slop-csrf': nonce, ...(id === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(id === undefined ? {} : { method: 'PUT', body: JSON.stringify({ scope: 'chat-refresh', sessionId, id }) }),
  })
  let response = await send(boot.csrfNonce)
  if (response.status === 403) {
    const fresh = await refreshBrowserBoot()
    if (fresh !== undefined && fresh.csrfNonce !== boot.csrfNonce) response = await send(fresh.csrfNonce)
  }
  if (!response.ok) throw new Error(`Could not ${id === undefined ? 'read' : 'refresh'} Chat Queue (${response.status}).`)
  return decodeChatQueue(await response.json(), sessionId)
}
