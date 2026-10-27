import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDshRemoteClient, decodeSlopFeedEvent } from '../src/client/remote-adapter.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('DSH generated remote adapter', () => {
  it('detects a silent event socket while accepting heartbeats and disposing its watchdog', async () => {
    vi.useFakeTimers()
    class Socket {
      static current: Socket
      readonly listeners = new Map<string, (event: unknown) => void>()
      close = vi.fn()
      send = vi.fn()
      constructor() { Socket.current = this }
      addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, listener) }
      emit(kind: string, data?: unknown): void { this.listeners.get(kind)?.({ data: JSON.stringify(data) }) }
    }
    vi.stubGlobal('WebSocket', Socket)
    vi.stubGlobal('__DSH_SLOP_BOOT__', {
      csrfNonce: 'watchdog-nonce-1', browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings', queueSettingsBridgePath: '/dsh-slop/queue-settings',
    })
    const states = vi.fn()
    const events = vi.fn()
    const client = createDshRemoteClient({ remote: { slop: {} } })
    const stop = client.events!.subscribe('slop', '9', 'snapshot-1', events, states)
    Socket.current.emit('open')
    Socket.current.emit('message', { kind: 'subscribed' })
    await vi.advanceTimersByTimeAsync(20_000)
    Socket.current.emit('message', { kind: 'heartbeat', cursor: '9' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(states.mock.calls).toEqual([['subscribed']])
    expect(events).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(states).toHaveBeenLastCalledWith('offline')
    expect(Socket.current.close).toHaveBeenCalledOnce()
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('accepts only dedicated, identity-matched projection events', () => {
    expect(decodeSlopFeedEvent({
      schemaVersion: 1,
      feedId: 'slop',
      cursor: '8',
      domain: 'execution',
      entityId: '018f0000-0000-7000-8000-000000000001',
      revision: 2,
      kind: 'scheduler.observed',
      payload: { state: 'RUNNING' },
    })).toBe('resync-required')
    expect(decodeSlopFeedEvent({
      schemaVersion: 1,
      cursor: '9', projection: 'machine-connection', change: 'upsert', id: '018f0000-0000-7000-8000-000000000002', revision: 3,
      value: { schemaVersion: 1, id: '018f0000-0000-7000-8000-000000000002', revision: 3 },
    })).toMatchObject({ projection: 'machine-connection', change: 'upsert', cursor: '9' })
    expect(decodeSlopFeedEvent({
      schemaVersion: 1,
      cursor: '10', projection: 'machine-connection', change: 'upsert', id: 'attempt-a', revision: 4,
      value: { schemaVersion: 1, id: 'attempt-b', revision: 4 },
    })).toBe('resync-required')
  })

  it('calls the nested generated slop namespace', async () => {
    const remote = { slop: { machine: { list: async (request: unknown) => ({ ok: true, value: request }) } } }
    const client = createDshRemoteClient({ remote })
    const result = await client.call('slop.machine.list', { search: 'atlas' })
    expect(result).toEqual({ ok: true, value: { search: 'atlas' } })
  })

  it('calls DSH Typert literal dotted properties and unwraps carrier plus domain results', async () => {
    const remote = { slop: { 'machine.list': async (request: unknown) => ({ ok: true, value: { ok: true, value: [request] } }) } }
    const client = createDshRemoteClient({ remote })
    const result = await client.call('slop.machine.list', { search: 'cedar' })
    expect(result).toEqual({ ok: true, value: [{ search: 'cedar' }] })
  })

  it('preserves an inner domain failure instead of treating it as a successful value', async () => {
    const remote = { slop: { 'machine.list': async () => ({ ok: true, value: { ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'not mounted', retryable: false } } }) } }
    const client = createDshRemoteClient({ remote })
    const result = await client.call('slop.machine.list', {})
    expect(result).toEqual({ ok: false, error: { code: 'UNAVAILABLE', message: 'not mounted', retryable: false } })
  })

  it('reports an absent generated capability as a typed failure', async () => {
    const client = createDshRemoteClient({ remote: { slop: {} } })
    const result = await client.call('slop.machine.list', {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('UNAVAILABLE')
  })

  it('refreshes a stale boot nonce before reconnecting the shared event feed', async () => {
    const previousBoot = (globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__
    const previousWebSocket = globalThis.WebSocket
    const previousFetch = globalThis.fetch
    class FakeWebSocket {
      static instances: FakeWebSocket[] = []
      readonly sent: unknown[] = []
      readonly listeners = new Map<string, Array<(event: any) => void>>()
      constructor(readonly _url: string, readonly protocol?: string | string[]) { FakeWebSocket.instances.push(this) }
      addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(value: unknown): void { this.sent.push(value) }
      close(): void {}
      emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    }
    ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = {
      csrfNonce: 'stale-feed-nonce-1',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      csrfNonce: 'fresh-feed-nonce-1',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }))) as typeof fetch
    try {
      const client = createDshRemoteClient({ remote: { slop: {} } })
      const states: string[] = []
      const stop = client.events?.subscribe('slop', '9', 'snapshot-1', () => {}, state => { states.push(state) })
      expect(FakeWebSocket.instances[0]?.protocol).toBe('dsh-slop.v1.stale-feed-nonce-1')
      FakeWebSocket.instances[0]?.emit('error')
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })
      expect(FakeWebSocket.instances[1]?.protocol).toBe('dsh-slop.v1.fresh-feed-nonce-1')
      FakeWebSocket.instances[1]?.emit('open')
      FakeWebSocket.instances[1]?.emit('message', { data: JSON.stringify({ kind: 'subscribed' }) })
      expect(FakeWebSocket.instances[1]?.sent).toEqual([JSON.stringify({ kind: 'subscribe', feedId: 'slop', asOfCursor: '9', snapshotToken: 'snapshot-1' })])
      expect(states).toEqual(['subscribed'])
      stop?.()
    } finally {
      ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = previousBoot
      globalThis.WebSocket = previousWebSocket
      globalThis.fetch = previousFetch
    }
  })

  it('attaches authentication to the nonce-protected binary auth carrier', () => {
    const previousBoot = (globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__
    const previousWebSocket = globalThis.WebSocket
    class FakeWebSocket {
      static readonly OPEN = 1
      static instances: FakeWebSocket[] = []
      readonly sent: unknown[] = []
      readonly listeners = new Map<string, Array<(event: any) => void>>()
      binaryType = ''
      readyState = FakeWebSocket.OPEN
      closed = false
      constructor(readonly url: string, readonly protocols?: string | string[]) { FakeWebSocket.instances.push(this) }
      addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(value: unknown): void { this.sent.push(value) }
      close(): void { this.closed = true }
      emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    }
    ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = {
      csrfNonce: 'auth-nonce-value-1',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    try {
      const client = createDshRemoteClient({ remote: { slop: {} } })
      const output: string[] = []
      const states: string[] = []
      const terminal = client.auth?.open('flow-owner-1', text => { output.push(text) }, state => { states.push(state) })
      expect(terminal).toBeDefined()
      const socket = FakeWebSocket.instances[0]
      expect(socket?.url.endsWith('/dsh-slop/auth')).toBe(true)
      expect(socket?.protocols).toBe('dsh-slop.v1.auth-nonce-value-1')
      expect(socket?.binaryType).toBe('arraybuffer')
      socket?.emit('open')
      expect(socket?.sent[0]).toBe(JSON.stringify({ kind: 'subscribe', flowId: 'flow-owner-1' }))
      socket?.emit('message', { data: JSON.stringify({ kind: 'subscribed' }) })
      socket?.emit('message', { data: new TextEncoder().encode('Password:').buffer })
      expect(states).toEqual(['connecting', 'attached'])
      expect(output).toEqual(['Password:'])
      terminal?.send('one-time-secret\n')
      expect(socket?.sent[1]).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(socket?.sent[1] as Uint8Array)).toBe('one-time-secret\n')
      socket?.emit('error')
      socket?.emit('close', { code: 1006, reason: '' })
      expect(states.at(-1)).toBe('error')
      terminal?.close()
      expect(socket?.closed).toBe(true)
    } finally {
      ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = previousBoot
      globalThis.WebSocket = previousWebSocket
    }
  })

  it('refreshes a stale boot nonce once before failing the protected auth carrier', async () => {
    const previousBoot = (globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__
    const previousWebSocket = globalThis.WebSocket
    const previousFetch = globalThis.fetch
    class FakeWebSocket {
      static readonly OPEN = 1
      static instances: FakeWebSocket[] = []
      readonly sent: unknown[] = []
      readonly listeners = new Map<string, Array<(event: any) => void>>()
      binaryType = ''
      readyState = FakeWebSocket.OPEN
      closed = false
      constructor(readonly url: string, readonly protocols?: string | string[]) { FakeWebSocket.instances.push(this) }
      addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(value: unknown): void { this.sent.push(value) }
      close(): void { this.closed = true }
      emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    }
    ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = {
      csrfNonce: 'stale-auth-nonce',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      csrfNonce: 'fresh-auth-nonce-2',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }), {
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
    try {
      const client = createDshRemoteClient({ remote: { slop: {} } })
      const output: string[] = []
      const states: string[] = []
      const terminal = client.auth?.open('flow-owner-retry', text => { output.push(text) }, state => { states.push(state) })
      const stale = FakeWebSocket.instances[0]
      expect(stale?.protocols).toBe('dsh-slop.v1.stale-auth-nonce')

      stale?.emit('error')
      stale?.emit('close', { code: 1006, reason: '' })
      await vi.waitFor(() => { expect(FakeWebSocket.instances).toHaveLength(2) })

      const fresh = FakeWebSocket.instances[1]
      expect(globalThis.fetch).toHaveBeenCalledWith('/dsh-slop/browser-bootstrap', expect.objectContaining({ method: 'GET', cache: 'no-store' }))
      expect(fresh?.protocols).toBe('dsh-slop.v1.fresh-auth-nonce-2')
      expect((globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__).toEqual({
        csrfNonce: 'fresh-auth-nonce-2',
        browserBootstrapPath: '/dsh-slop/browser-bootstrap',
        knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
        queueSettingsBridgePath: '/dsh-slop/queue-settings',
      })
      fresh?.emit('open')
      fresh?.emit('message', { data: JSON.stringify({ kind: 'subscribed' }) })
      fresh?.emit('message', { data: new TextEncoder().encode('Password:').buffer })

      expect(states).toEqual(['connecting', 'attached'])
      expect(output).toEqual(['Password:'])
      expect(fresh?.sent[0]).toBe(JSON.stringify({ kind: 'subscribe', flowId: 'flow-owner-retry' }))
      terminal?.close()
    } finally {
      ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = previousBoot
      globalThis.WebSocket = previousWebSocket
      globalThis.fetch = previousFetch
    }
  })

  it('stops after one protected auth carrier retry', async () => {
    const previousBoot = (globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__
    const previousWebSocket = globalThis.WebSocket
    const previousFetch = globalThis.fetch
    class FailingWebSocket {
      static readonly OPEN = 1
      static instances: FailingWebSocket[] = []
      readonly listeners = new Map<string, Array<(event: any) => void>>()
      binaryType = ''
      readyState = 0
      constructor(readonly _url: string, readonly _protocol?: string | string[]) { FailingWebSocket.instances.push(this) }
      addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]) }
      send(): void {}
      close(): void {}
      emit(type: string, event: unknown = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    }
    ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = {
      csrfNonce: 'stale-auth-nonce',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }
    globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      csrfNonce: 'fresh-auth-nonce-3',
      browserBootstrapPath: '/dsh-slop/browser-bootstrap',
      knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
      queueSettingsBridgePath: '/dsh-slop/queue-settings',
    }))) as typeof fetch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = createDshRemoteClient({ remote: { slop: {} } })
      const states: string[] = []
      client.auth?.open('flow-owner-fail', () => {}, state => { states.push(state) })
      FailingWebSocket.instances[0]?.emit('error')
      FailingWebSocket.instances[0]?.emit('close', { code: 1006, reason: '' })
      await vi.waitFor(() => { expect(FailingWebSocket.instances).toHaveLength(2) })

      FailingWebSocket.instances[1]?.emit('error')
      FailingWebSocket.instances[1]?.emit('close', { code: 1006, reason: '' })
      await vi.waitFor(() => { expect(states.at(-1)).toBe('error') })

      expect(FailingWebSocket.instances).toHaveLength(2)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith('DSH-SLOP auth terminal retry closed (1006).')
    } finally {
      warn.mockRestore()
      ;(globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__ = previousBoot
      globalThis.WebSocket = previousWebSocket
      globalThis.fetch = previousFetch
    }
  })
})
