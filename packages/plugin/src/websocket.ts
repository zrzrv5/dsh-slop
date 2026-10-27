import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { PrincipalContext, SlopAuthWebSocketSession, SlopWebSocketSession } from '@dsh-slop/core'
import { admitLocalRequest, HttpAdmissionError } from './admission.ts'

const MAX_CONTROL_FRAME_BYTES = 64 * 1024

type JsonSession = SlopWebSocketSession<unknown>
type ProductSession = JsonSession | SlopAuthWebSocketSession

/** Product WebSocket protocol whose routing is owned by one exact DSH upgrade path. */
export interface ProductWebSocketRoute {
  readonly path: '/dsh-slop/events' | '/dsh-slop/auth'
  readonly auth: boolean
  open(principal: PrincipalContext, signal: AbortSignal): Promise<ProductSession> | ProductSession
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const phrase = status === 403 ? 'Forbidden' : 'Bad Request'
  const body = reason.replaceAll(/[\r\n]/g, ' ')
  socket.end([
    `HTTP/1.1 ${String(status)} ${phrase}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

function hasProtocol(request: IncomingMessage, expected: string): boolean {
  return request.headers['sec-websocket-protocol']
    ?.split(',')
    .map(protocol => protocol.trim())
    .includes(expected) === true
}

function parseJson(bytes: Buffer): unknown {
  if (bytes.length > MAX_CONTROL_FRAME_BYTES) throw new Error('control frame exceeds 64 KiB')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}

function send(socket: WebSocket, value: unknown | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('socket closed before frame delivery'))
      return
    }
    const payload = value instanceof Uint8Array ? value : JSON.stringify(value)
    const size = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf8') : payload.byteLength
    if (size > MAX_CONTROL_FRAME_BYTES) {
      reject(new Error('provider frame exceeds 64 KiB'))
      return
    }
    socket.send(payload, error => { if (error == null) resolve(); else reject(error) })
  })
}

  /** Own and dispose all accepted sockets for the event and protected-auth protocols. */
export class ProductWebSocketGateway {
  private readonly servers = new Map<ProductWebSocketRoute['path'], WebSocketServer>()
  private readonly pumps = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()

  constructor(
    private readonly nonce: string,
    private readonly principal: PrincipalContext,
    routes: readonly ProductWebSocketRoute[],
    private readonly reportError: (error: unknown) => void = () => {},
    private readonly trustedHosts: readonly string[] = [],
  ) {
    for (const route of routes) {
      const protocol = this.protocol()
      this.servers.set(route.path, new WebSocketServer({
        noServer: true,
        maxPayload: MAX_CONTROL_FRAME_BYTES,
        handleProtocols: protocols => protocols.has(protocol) ? protocol : false,
      }))
    }
  }

  /** Upgrade one admitted route; the caller retains ownership when it rejects. */
  upgrade(route: ProductWebSocketRoute, request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      admitLocalRequest(request, this.nonce, false, this.trustedHosts)
      if (new URL(request.url ?? route.path, 'http://localhost').search !== '') {
        throw new HttpAdmissionError(400, 'query parameters are not allowed')
      }
      if (!hasProtocol(request, this.protocol())) throw new HttpAdmissionError(403, 'request nonce protocol required')
    } catch (error) {
      rejectUpgrade(socket, error instanceof HttpAdmissionError ? error.status : 400, 'forbidden')
      return
    }
    const server = this.servers.get(route.path)
    if (server === undefined) {
      rejectUpgrade(socket, 400, 'unknown product protocol')
      return
    }
    server.handleUpgrade(request, socket, head, websocket => {
      server.emit('connection', websocket, request)
      const pump = this.run(route, websocket)
      this.pumps.add(pump)
      void pump.finally(() => { this.pumps.delete(pump) })
    })
  }

  /** Stop accepted sessions and settle their pumps before the owning plugin unloads. */
  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort()
    for (const server of this.servers.values()) {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
    await Promise.allSettled(this.pumps)
  }

  private protocol(): string {
    return `dsh-slop.v1.${this.nonce}`
  }

  private async run(route: ProductWebSocketRoute, socket: WebSocket): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    let session: ProductSession | undefined
    let inbound = Promise.resolve()
    const opening = Promise.resolve(route.open(this.principal, controller.signal))
    socket.on('message', (data, isBinary) => {
      inbound = inbound.then(async () => {
        if (controller.signal.aborted) return
        const active = await opening
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data)
        if (isBinary) {
          if (!route.auth || !('receiveBinary' in active)) throw new Error('binary frame is not allowed on this route')
          await active.receiveBinary(bytes)
          return
        }
        await active.receive(parseJson(bytes))
      }).catch((error: unknown) => {
        this.reportError(error)
        socket.close(1008, 'invalid protocol frame')
      })
    })
    socket.once('close', () => { controller.abort() })
    socket.once('error', () => { controller.abort() })
    try {
      session = await opening
      for await (const frame of session.frames) await send(socket, frame)
    } catch (error) {
      this.reportError(error)
      if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) {
        socket.close(1011, 'protocol unavailable')
      }
    } finally {
      controller.abort()
      await inbound.catch(() => {})
      await session?.close().catch(() => {})
      this.controllers.delete(controller)
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}
