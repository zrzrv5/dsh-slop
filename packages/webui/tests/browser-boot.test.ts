import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserWebSocketUrl } from '../src/browser-boot.ts'

afterEach(() => vi.unstubAllGlobals())

describe('browser WebSocket destination', () => {
  it('uses the RC2 Desktop Host transport for authentication and events', () => {
    vi.stubGlobal('location', { protocol: 'dsh-app:', host: 'app' })
    vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://127.0.0.1:19387' })
    expect(browserWebSocketUrl('/dsh-slop/auth')).toBe('ws://127.0.0.1:19387/dsh-slop/auth')
    expect(browserWebSocketUrl('/dsh-slop/events')).toBe('ws://127.0.0.1:19387/dsh-slop/events')
  })

  it('refuses missing or foreign Desktop transports before sending a nonce', () => {
    vi.stubGlobal('location', { protocol: 'dsh-app:', host: 'app' })
    for (const streamBaseUrl of [undefined, 'https://example.com', 'http://user@127.0.0.1:19387', 'http://127.0.0.1:19387/foreign']) {
      vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl })
      expect(() => browserWebSocketUrl('/dsh-slop/auth')).toThrow()
    }
  })

  it('keeps ordinary browser and trusted HTTPS connections on their own origin', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3080' })
    expect(browserWebSocketUrl('/dsh-slop/events')).toBe('ws://localhost:3080/dsh-slop/events')
    vi.stubGlobal('location', { protocol: 'https:', host: 'harness.example.com' })
    expect(browserWebSocketUrl('/dsh-slop/auth')).toBe('wss://harness.example.com/dsh-slop/auth')
  })
})
