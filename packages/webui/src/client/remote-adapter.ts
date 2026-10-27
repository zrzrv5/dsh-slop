import type {
  AuthTerminalClient,
  EventFeedClient,
  SlopRemoteClient,
} from '../remote-client.ts'
import type {
  Cursor,
  ProjectionEvent,
  RemoteFailure,
  RemoteResult,
} from '../types.ts'
import type { RemoteMethod, RemoteRequest, RemoteResponse } from '../remote-client.ts'
import { browserBoot, browserWebSocketProtocol, browserWebSocketUrl, refreshBrowserBoot } from '../browser-boot.ts'

/**
 * Runtime shape of the Typert namespace exposed by DSH.  The generated
 * declaration is imported by the client entry for type augmentation; this
 * deliberately small runtime view keeps the adapter independent of a
 * generated implementation detail (nested namespaces vs flattened keys).
 */
type RemoteCallable = (...args: unknown[]) => unknown
type RemoteRecord = Record<string, unknown>

const failureCodes = new Set<RemoteFailure['code']>([
  'UNAVAILABLE', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'NOT_FOUND', 'CONFLICT',
  'INVALID', 'BOUNDS', 'STALE', 'RESYNC_REQUIRED', 'APPROVAL_REQUIRED',
  'FAILED', 'ABORTED',
])

function failure(code: RemoteFailure['code'], message: string, retryable = false): RemoteResult<never> {
  return { ok: false, error: { code, message, retryable } }
}

function normalizeFailure(value: unknown): RemoteFailure {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const rawCode = typeof record.code === 'string' ? record.code : 'UNAVAILABLE'
    const mappedCodes: Readonly<Record<string, RemoteFailure['code']>> = {
      CAPABILITY_UNAVAILABLE: 'UNAVAILABLE', CONNECTION_UNAVAILABLE: 'UNAVAILABLE',
      INVALID_REQUEST: 'INVALID', INVALID_PATH: 'INVALID',
      REVISION_CONFLICT: 'STALE', STATE_CONFLICT: 'CONFLICT',
      OPERATION_CANCELLED: 'ABORTED', OUTPUT_TRUNCATED: 'BOUNDS',
      INTERNAL: 'FAILED', APPROVAL_MISMATCH: 'APPROVAL_REQUIRED',
      HOST_KEY_REQUIRED: 'AUTH_REQUIRED', HOST_KEY_CHANGED: 'AUTH_REQUIRED',
    }
    const code = failureCodes.has(rawCode as RemoteFailure['code']) ? rawCode as RemoteFailure['code'] : mappedCodes[rawCode] ?? 'FAILED'
    return {
      code,
      message: typeof record.message === 'string' ? record.message : 'The SLOP host returned an unknown failure.',
      retryable: record.retryable === true,
      ...(typeof record.currentRevision === 'number' ? { currentRevision: record.currentRevision } : {}),
    }
  }
  return { code: 'UNAVAILABLE', message: 'The SLOP host returned an invalid failure.', retryable: true }
}

function normalizeResult(value: unknown): RemoteResult<unknown> {
  if (value !== null && typeof value === 'object' && 'ok' in value) {
    const record = value as { ok?: unknown; value?: unknown; error?: unknown }
    if (record.ok === true) {
      // Typert owns the outer carrier result; SLOP owns the inner domain
      // WireResult. Unwrap both while retaining compatibility with raw
      // projections used by focused fixtures.
      if (record.value !== null && typeof record.value === 'object' && 'ok' in record.value) return normalizeResult(record.value)
      return { ok: true, value: record.value }
    }
    if (record.ok === false) return { ok: false, error: normalizeFailure(record.error) }
  }
  // Typert remotes normally return WireResult.  Treat a raw projection as a
  // successful value as a compatibility guard for older DSH fixtures.
  return { ok: true, value }
}

function asRecord(value: unknown): RemoteRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RemoteRecord
    : undefined
}

function camelCase(value: string): string {
  return value.replace(/\.([a-zA-Z])/g, (_match, letter: string) => letter.toUpperCase())
}

function lookup(namespace: unknown, path: string): RemoteCallable | undefined {
  const root = asRecord(namespace)
  if (root === undefined) return undefined

  // DSH's Typert RemoteNamespaceService defines dotted method names as literal
  // enumerable properties (for example `remote.slop['machine.list']`).
  const literal = root[path]
  if (typeof literal === 'function') return literal.bind(root)

  const segments = path.split('.')
  let current: unknown = root
  let parent: RemoteRecord | undefined
  for (const segment of segments) {
    const record = asRecord(current)
    if (record === undefined) break
    parent = record
    current = record[segment]
  }
  if (typeof current === 'function') return current.bind(parent)

  const candidates = [path.replaceAll('.', '_'), camelCase(path), path.replaceAll('.', '')]
  for (const candidate of candidates) {
    const method = root[candidate]
    if (typeof method === 'function') return method.bind(root)
  }
  return undefined
}

function websocketProtocol(): string | undefined {
  const boot = browserBoot()
  return boot === undefined ? undefined : browserWebSocketProtocol(boot)
}

async function refreshWebsocketProtocol(): Promise<string | undefined> {
  const boot = await refreshBrowserBoot()
  return boot === undefined ? undefined : browserWebSocketProtocol(boot)
}

interface EventFrame {
  kind?: string
  event?: unknown
  payload?: unknown
  value?: unknown
  state?: string
  cursor?: unknown
}

interface JsonSocketCallbacks {
  readonly path: '/dsh-slop/events'
  onOpen(socket: WebSocket): void
  onMessage(message: MessageEvent): void
  onDisconnected(): void
}

/** Open one nonce-protected JSON socket and refresh stale boot state at most once. */
function openJsonSocket(callbacks: JsonSocketCallbacks): () => void {
  let disposed = false
  let socket: WebSocket | undefined
  let unavailableReported = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const clearWatchdog = (): void => {
    if (watchdog !== undefined) clearTimeout(watchdog)
    watchdog = undefined
  }
  const unavailable = (): void => {
    if (disposed || unavailableReported) return
    unavailableReported = true
    clearWatchdog()
    callbacks.onDisconnected()
    socket?.close()
  }
  const armWatchdog = (): void => {
    clearWatchdog()
    watchdog = setTimeout(unavailable, 30_000)
  }
  const connect = (protocol: string, refreshed: boolean): void => {
    if (disposed || unavailableReported) return
    let candidate: WebSocket
    try {
      candidate = new WebSocket(browserWebSocketUrl(callbacks.path), protocol)
    } catch {
      unavailable()
      return
    }
    socket = candidate
    let opened = false
    let recovering = false
    const recoverOrDisconnect = (): void => {
      if (disposed || socket !== candidate || recovering) return
      recovering = true
      if (opened || refreshed) {
        unavailable()
        return
      }
      void refreshWebsocketProtocol().then(fresh => {
        if (disposed || socket !== candidate) return
        if (fresh === undefined) unavailable()
        else connect(fresh, true)
      })
    }
    candidate.addEventListener('open', () => {
      if (disposed || unavailableReported || socket !== candidate) return
      opened = true
      callbacks.onOpen(candidate)
    })
    candidate.addEventListener('message', message => {
      if (!disposed && !unavailableReported && socket === candidate) {
        armWatchdog()
        callbacks.onMessage(message)
      }
    })
    candidate.addEventListener('close', () => { recoverOrDisconnect() })
    candidate.addEventListener('error', () => { recoverOrDisconnect() })
  }
  armWatchdog()
  const protocol = websocketProtocol()
  if (protocol === undefined) {
    void refreshWebsocketProtocol().then(fresh => {
      if (disposed) return
      if (fresh === undefined) unavailable()
      else connect(fresh, true)
    })
  } else {
    connect(protocol, false)
  }
  return () => {
    disposed = true
    clearWatchdog()
    socket?.close()
  }
}

const projectionKinds = new Set<ProjectionEvent['projection']>(['machine-connection'])

/** Validate the ordered projection envelope before it enters the shared store. */
export function decodeSlopFeedEvent(value: unknown): ProjectionEvent | 'resync-required' | undefined {
  const candidate = asRecord(value)
  if (candidate === undefined || typeof candidate.cursor !== 'string' || !/^\d+$/.test(candidate.cursor)) return undefined
  if (candidate.schemaVersion !== 1) return 'resync-required'
  if (typeof candidate.projection !== 'string' || !projectionKinds.has(candidate.projection as ProjectionEvent['projection'])) return 'resync-required'
  if (candidate.change !== 'upsert' && candidate.change !== 'remove') return 'resync-required'
  if (typeof candidate.id !== 'string' || typeof candidate.revision !== 'number' || !Number.isSafeInteger(candidate.revision) || candidate.revision < 1) return 'resync-required'
  if (candidate.change === 'remove') return candidate as ProjectionEvent
  const projected = asRecord(candidate.value)
  if (projected === undefined || projected.id !== candidate.id || projected.revision !== candidate.revision || projected.schemaVersion !== 1) return 'resync-required'
  return candidate as ProjectionEvent
}

function createEventClient(): EventFeedClient {
  return {
    subscribe(feedId: 'slop', asOfCursor: Cursor, snapshotToken: string, onEvent: (event: ProjectionEvent) => void, onState?: (state: 'subscribed' | 'resync-required' | 'offline') => void): () => void {
      if (typeof WebSocket === 'undefined') {
        onState?.('offline')
        return () => {}
      }
      let cursor = asOfCursor
      return openJsonSocket({
        path: '/dsh-slop/events',
        onOpen: socket => { socket.send(JSON.stringify({ kind: 'subscribe', feedId, asOfCursor, snapshotToken })) },
        onMessage: message => {
          try {
            const frame = JSON.parse(typeof message.data === 'string' ? message.data : '') as EventFrame
            if (frame.kind === 'resync-required') {
              onState?.('resync-required')
              return
            }
            if (frame.kind === 'subscribed') {
              onState?.('subscribed')
              return
            }
            if (frame.kind === 'heartbeat') {
              if (frame.cursor !== cursor) onState?.('resync-required')
              return
            }
            const candidate = decodeSlopFeedEvent(frame.event ?? frame.payload ?? frame.value ?? frame)
            if (candidate === 'resync-required') onState?.('resync-required')
            else if (candidate !== undefined) { cursor = candidate.cursor; onEvent(candidate) }
            else onState?.('resync-required')
          } catch {
            onState?.('resync-required')
          }
        },
        onDisconnected: () => {
          console.warn('DSH-SLOP event feed disconnected.')
          onState?.('offline')
        },
      })
    },
  }
}

function createAuthClient(): AuthTerminalClient {
  return {
    open(carrierFlowId, onOutput, onState) {
      if (typeof WebSocket === 'undefined') {
        onState?.('error')
        return { send: () => {}, close: () => {} }
      }
      let disposed = false
      let socket: WebSocket | undefined
      onState?.('connecting')

      const connect = (protocol: string, retry: boolean): void => {
        if (disposed) return
        let candidate: WebSocket
        try {
          candidate = new WebSocket(browserWebSocketUrl('/dsh-slop/auth'), protocol)
        } catch {
          onState?.('error')
          return
        }
        socket = candidate
        candidate.binaryType = 'arraybuffer'
        let opened = false
        let recovering = false
        let failed = false
        const recoverOrFail = (): void => {
          if (disposed || socket !== candidate || recovering) return
          if (opened || retry) {
            recovering = true
            failed = true
            onState?.('error')
            return
          }
          recovering = true
          void refreshWebsocketProtocol().then(fresh => {
            if (disposed || socket !== candidate) return
            if (fresh === undefined) {
              failed = true
              console.warn('DSH-SLOP auth terminal could not refresh its browser bootstrap after the initial connection failed.')
              onState?.('error')
              return
            }
            connect(fresh, true)
          })
        }
        candidate.addEventListener('open', () => {
          if (disposed || socket !== candidate) return
          opened = true
          candidate.send(JSON.stringify({ kind: 'subscribe', flowId: carrierFlowId }))
        })
        candidate.addEventListener('message', message => {
          if (disposed || socket !== candidate) return
          if (typeof message.data === 'string') {
            try {
              const frame = JSON.parse(message.data) as { kind?: unknown }
              if (frame.kind === 'subscribed') onState?.('attached')
            } catch {
              failed = true
              onState?.('error')
            }
            return
          }
          if (message.data instanceof ArrayBuffer) {
            onOutput(new TextDecoder().decode(new Uint8Array(message.data)))
            return
          }
          if (typeof Blob !== 'undefined' && message.data instanceof Blob) {
            void message.data.arrayBuffer().then(bytes => { if (!disposed && socket === candidate) onOutput(new TextDecoder().decode(new Uint8Array(bytes))) })
          }
        })
        candidate.addEventListener('close', event => {
          if (disposed || socket !== candidate) return
          if (!opened) {
            if (retry) console.warn(`DSH-SLOP auth terminal retry closed (${String(event.code)}${event.reason === '' ? '' : `: ${event.reason}`}).`)
            recoverOrFail()
            return
          }
          if (!failed) onState?.('closed')
          console.warn(`DSH-SLOP auth terminal closed (${String(event.code)}${event.reason === '' ? '' : `: ${event.reason}`}).`)
        })
        candidate.addEventListener('error', () => { recoverOrFail() })
      }

      const protocol = websocketProtocol()
      if (protocol === undefined) {
        void refreshWebsocketProtocol().then(fresh => {
          if (disposed) return
          if (fresh === undefined) onState?.('error')
          else connect(fresh, true)
        })
      } else {
        connect(protocol, false)
      }
      return {
        send(text) {
          if (socket?.readyState !== WebSocket.OPEN) throw new Error('Authentication terminal is not attached.')
          socket.send(new TextEncoder().encode(text))
        },
        close() { disposed = true; socket?.close() },
      }
    },
  }
}

/**
 * Adapt DSH's generated `ctx.remote.slop.*` namespace to the UI's local
 * method map.  Components never receive raw Cordis context and tests can
 * keep using the same typed `SlopRemoteClient` with a mock transport.
 */
export function createDshRemoteClient(ctx: { remote: unknown }, mountedNamespace?: unknown): SlopRemoteClient {
  const namespace = asRecord(mountedNamespace ?? asRecord(ctx.remote)?.slop)
  const events = createEventClient()
  const auth = createAuthClient()

  const call = async <M extends RemoteMethod>(method: M, request: RemoteRequest<M>): Promise<RemoteResult<RemoteResponse<M>>> => {
    if (namespace === undefined) return failure('UNAVAILABLE', 'The SLOP remote namespace is not mounted in this DSH composition.', true) as RemoteResult<RemoteResponse<M>>

    const path = method.slice('slop.'.length)
    const remote = lookup(namespace, path)
    if (remote === undefined) return failure('UNAVAILABLE', `The SLOP remote ${path} is not mounted in this DSH composition.`, false) as RemoteResult<RemoteResponse<M>>
    try {
      const value = await remote(request)
      return normalizeResult(value) as RemoteResult<RemoteResponse<M>>
    } catch (error) {
      return failure('UNAVAILABLE', error instanceof Error ? error.message : 'The SLOP remote call failed.', true) as RemoteResult<RemoteResponse<M>>
    }
  }

  return { call, events, auth }
}
