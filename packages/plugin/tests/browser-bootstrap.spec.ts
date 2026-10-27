import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { BROWSER_BOOTSTRAP_PATH, serveBrowserBootstrap } from '../src/browser-bootstrap.ts'

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const input = new Readable({ read() {} }) as IncomingMessage
  input.method = 'GET'
  input.url = BROWSER_BOOTSTRAP_PATH
  input.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  input.socket = { remoteAddress: '127.0.0.1' } as Socket
  Object.assign(input, overrides)
  return input
}

function response(): { value: ServerResponse; read: () => { status?: number; headers: Record<string, string>; body: unknown } } {
  let status: number | undefined
  const headers: Record<string, string> = {}
  let body: unknown
  return {
    value: {
      writeHead(next: number, nextHeaders: Record<string, string>) { status = next; Object.assign(headers, nextHeaders) },
      end(value: string) { body = JSON.parse(value) as unknown },
    } as unknown as ServerResponse,
    read: () => ({ ...(status === undefined ? {} : { status }), headers, body }),
  }
}

describe('browser bootstrap refresh route', () => {
  it('returns the complete current public boot config without requiring the stale nonce', () => {
    const output = response()
    serveBrowserBootstrap(request(), output.value, 'fresh-auth-nonce-4')
    expect(output.read()).toMatchObject({
      status: 200,
      headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
      body: {
        csrfNonce: 'fresh-auth-nonce-4',
        browserBootstrapPath: '/dsh-slop/browser-bootstrap',
        knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
        queueSettingsBridgePath: '/dsh-slop/queue-settings',
      },
    })
  })

  it('returns the bootstrap for one exact trusted HTTPS authority', () => {
    const authority = 'host.example.net:3080'
    const output = response()
    serveBrowserBootstrap(request({
      headers: { host: authority, origin: `https://${authority}` },
    }), output.value, 'fresh-auth-nonce-4', [authority])
    expect(output.read().status).toBe(200)
  })

  it('keeps refresh same-origin, loopback, GET-only, and query-free', () => {
    for (const input of [
      request({ method: 'POST' }),
      request({ url: `${BROWSER_BOOTSTRAP_PATH}?leak=1` }),
      request({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.test' } }),
    ]) {
      const output = response()
      serveBrowserBootstrap(input, output.value, 'fresh-auth-nonce-4')
      expect(output.read().status).not.toBe(200)
    }
  })

  it('does not disclose the boot nonce through a normalized loopback alias', () => {
    for (const host of ['2130706433:3080', 'attacker@127.0.0.1:3080', '127.0.0.1:3080/evil']) {
      const output = response()
      serveBrowserBootstrap(request({ headers: { host } }), output.value, 'fresh-auth-nonce-4')
      expect(output.read().status).toBe(403)
    }
  })
})
