import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { admitLocalRequest, HttpAdmissionError, readJsonBody, writeJson } from '../src/admission.ts'

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const input = new Readable({ read() {} }) as IncomingMessage
  input.method = 'POST'
  input.headers = {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'content-type': 'application/json',
    'x-dsh-slop-csrf': 'boot-token',
  }
  input.socket = { remoteAddress: '127.0.0.1' } as Socket
  Object.assign(input, overrides)
  return input
}

function emitBody(input: IncomingMessage, body: string): void {
  queueMicrotask(() => {
    input.push(Buffer.from(body))
    input.push(null)
  })
}

describe('local browser admission', () => {
  it('accepts an exact loopback same-origin request and nonce', () => {
    expect(() => admitLocalRequest(request(), 'boot-token')).not.toThrow()
  })

  it('accepts one exact HTTPS authority through a loopback proxy', () => {
    const authority = 'host.example.net:3080'
    expect(() => admitLocalRequest(request({
      headers: {
        host: authority,
        origin: `https://${authority}`,
        'x-dsh-slop-csrf': 'boot-token',
      },
    }), 'boot-token', true, [authority])).not.toThrow()
  })

  it('accepts a port-less trusted HTTPS host on any served port', () => {
    const hostname = 'host.example.net'
    for (const port of ['3080', '443']) {
      const authority = `${hostname}:${port}`
      expect(() => admitLocalRequest(request({
        headers: {
          host: authority,
          origin: `https://${authority}`,
          'x-dsh-slop-csrf': 'boot-token',
        },
      }), 'boot-token', true, [hostname])).not.toThrow()
    }
  })

  it.each([
    [{ socket: { remoteAddress: '10.0.0.2' } as Socket }, 'loopback client required'],
    [{ headers: { host: 'attacker.example', 'x-dsh-slop-csrf': 'boot-token' } }, 'trusted host required'],
    [{ headers: { host: '127.0.0.1:3080', origin: 'https://evil.test', 'x-dsh-slop-csrf': 'boot-token' } }, 'same origin required'],
    [{ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site', 'x-dsh-slop-csrf': 'boot-token' } }, 'cross-site request refused'],
    [{ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'x-dsh-slop-csrf': 'wrong' } }, 'invalid request nonce'],
  ])('rejects requests outside the trust fence', (overrides, message) => {
    expect(() => admitLocalRequest(request(overrides as Partial<IncomingMessage>), 'boot-token'))
      .toThrow(message as string)
  })

  it('rejects HTTP, malformed authorities, and authority drift for trusted remote hosts', () => {
    const authority = 'host.example.net:3080'
    for (const { input, trustedHosts } of [
      {
        input: request({ headers: { host: authority, origin: `http://${authority}`, 'x-dsh-slop-csrf': 'boot-token' } }),
        trustedHosts: [authority],
      },
      {
        input: request({ headers: { host: authority, origin: `https://${authority}`, 'x-dsh-slop-csrf': 'boot-token' } }),
        trustedHosts: [`https://${authority}`],
      },
      {
        input: request({ headers: { host: 'other.example.net:3080', origin: 'https://other.example.net:3080', 'x-dsh-slop-csrf': 'boot-token' } }),
        trustedHosts: [authority],
      },
    ]) {
      expect(() => admitLocalRequest(input, 'boot-token', true, trustedHosts)).toThrow(HttpAdmissionError)
    }
  })

  it('rejects non-canonical Host values before loopback classification', () => {
    for (const host of [
      'attacker@127.0.0.1:3080',
      '127.0.0.1:3080/evil',
      '2130706433',
      '0x7f000001',
      '127.1',
      ' localhost:3080',
    ]) {
      expect(() => admitLocalRequest(request({
        headers: {
          host,
          'x-dsh-slop-csrf': 'boot-token',
        },
      }), 'boot-token')).toThrow('invalid host header')
    }
  })

  it('parses a bounded JSON object', async () => {
    const input = request()
    emitBody(input, '{"decision":"grant"}')
    await expect(readJsonBody(input)).resolves.toEqual({ decision: 'grant' })
  })

  it('accepts PUT only when the route explicitly requests it', async () => {
    const input = request({ method: 'PUT' })
    emitBody(input, '{"homeRoot":"/tmp/knowledge"}')
    await expect(readJsonBody(input, 'PUT')).resolves.toEqual({ homeRoot: '/tmp/knowledge' })

    await expect(readJsonBody(request({ method: 'PUT' }))).rejects.toMatchObject({ status: 405 })
  })

  it('rejects invalid media types and oversized declared bodies', async () => {
    const media = request({ headers: { 'content-type': 'text/plain' } })
    await expect(readJsonBody(media)).rejects.toMatchObject({ status: 415 })
    const oversized = request({ headers: { 'content-type': 'application/json', 'content-length': '9000' } })
    await expect(readJsonBody(oversized)).rejects.toMatchObject({ status: 413 })
  })

  it('rejects malformed UTF-8 before JSON parsing', async () => {
    const input = request()
    queueMicrotask(() => {
      input.push(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
      input.push(null)
    })
    await expect(readJsonBody(input)).rejects.toMatchObject({ status: 400 })
  })

  it('writes no-store JSON responses', () => {
    const headers: Record<string, string> = {}
    let body = ''
    const response = {
      writeHead(status: number, values: Record<string, string>) {
        expect(status).toBe(403)
        Object.assign(headers, values)
      },
      end(value: string) { body = value },
    } as unknown as ServerResponse
    writeJson(response, 403, { error: 'forbidden' })
    expect(headers['cache-control']).toBe('no-store')
    expect(JSON.parse(body)).toEqual({ error: 'forbidden' })
  })

  it('retains a stable error class for route handlers', () => {
    const error = new HttpAdmissionError(403, 'denied')
    expect(error).toMatchObject({ name: 'HttpAdmissionError', status: 403, message: 'denied' })
  })
})
