import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Readable, type Duplex } from 'node:stream'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { PrincipalContext, SlopWebSocketSession } from '@dsh-slop/core'
import { ProductWebSocketGateway, type ProductWebSocketRoute } from '../src/websocket.ts'

const openServers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => { resolve() }))))
})

async function listen(route: ProductWebSocketRoute, nonce = 'nonce-value') {
  const gateway = new ProductWebSocketGateway(nonce, { principalId: 'local-owner', source: 'browser' } as PrincipalContext, [route])
  const server = createServer()
  server.on('upgrade', (request, socket, head) => { gateway.upgrade(route, request, socket, head) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  openServers.push(server)
  const port = (server.address() as AddressInfo).port
  return { gateway, url: `ws://127.0.0.1:${String(port)}${route.path}` }
}

const integrationDescribe = process.env['DSH_SLOP_INTEGRATION'] === '1' ? describe : describe.skip

describe('product WebSocket gateway admission', () => {
  it('rejects a missing nonce protocol with a fake socket and never opens the provider', () => {
    let opened = false
    let response = ''
    const route: ProductWebSocketRoute = {
      path: '/dsh-slop/events',
      auth: false,
      open: () => {
        opened = true
        return { async receive() {}, frames: (async function* () {})(), async close() {} }
      },
    }
    const gateway = new ProductWebSocketGateway(
      'nonce-value',
      { principalId: 'local-owner', source: 'browser' } as PrincipalContext,
      [route],
    )
    const request = new Readable({ read() {} }) as IncomingMessage
    request.url = route.path
    request.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
    request.socket = { remoteAddress: '127.0.0.1' } as Socket
    const socket = { end(value: string) { response = value } } as unknown as Duplex
    gateway.upgrade(route, request, socket, Buffer.alloc(0))
    expect(response).toContain('HTTP/1.1 403 Forbidden')
    expect(opened).toBe(false)
  })

})

integrationDescribe('product WebSocket gateway [integration: loopback socket]', () => {
  it('requires the per-boot nonce protocol and pumps JSON frames', async () => {
    const received: unknown[] = []
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const session: SlopWebSocketSession<unknown> = {
      async receive(frame) { received.push(frame); release() },
      frames: (async function* () {
        yield { kind: 'subscribed', firstCursor: '1' }
        await held
      })(),
      async close() {},
    }
    const route: ProductWebSocketRoute = {
      path: '/dsh-slop/events',
      auth: false,
      open: () => session,
    }
    const { gateway, url } = await listen(route)
    const socket = new WebSocket(url, 'dsh-slop.v1.nonce-value', { origin: url.replace('ws:', 'http:').replace('/dsh-slop/events', '') })
    const message = new Promise<unknown>((resolve, reject) => {
      socket.once('error', reject)
      socket.once('message', data => { resolve(JSON.parse(data.toString()) as unknown) })
    })
    const closed = new Promise<string>(resolve => {
      socket.once('close', (code, reason) => { resolve(`${String(code)}:${reason.toString()}`) })
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    if (socket.readyState !== WebSocket.OPEN) throw new Error(`early close ${await closed}`)
    await new Promise<void>((resolve, reject) => {
      socket.send(
        JSON.stringify({ kind: 'subscribe', feedId: 'main', asOfCursor: '0', snapshotToken: 'token' }),
        error => { if (error == null) resolve(); else reject(error) },
      )
    })
    await expect(message).resolves.toEqual({ kind: 'subscribed', firstCursor: '1' })
    await expect.poll(() => received).toEqual([
      { kind: 'subscribe', feedId: 'main', asOfCursor: '0', snapshotToken: 'token' },
    ])
    if (socket.readyState === WebSocket.OPEN) socket.close()
    await gateway.close()
  })

  it('rejects a missing nonce subprotocol before opening a product session', async () => {
    let opened = false
    const route: ProductWebSocketRoute = {
      path: '/dsh-slop/events',
      auth: false,
      open: () => {
        opened = true
        return { async receive() {}, frames: (async function* () {})(), async close() {} }
      },
    }
    const { gateway, url } = await listen(route)
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(url)
      socket.once('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0) })
    })
    expect(status).toBe(403)
    expect(opened).toBe(false)
    await gateway.close()
  })
})
