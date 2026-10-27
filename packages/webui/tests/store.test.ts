import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockSlopClient } from '../src/mock.ts'
import { createSlopStore } from '../src/store.ts'
import type { EventFeedClient } from '../src/remote-client.ts'

afterEach(() => { vi.useRealTimers() })

describe('SLOP projection store', () => {
  it('replays contiguous events and automatically recovers a cursor gap', async () => {
    vi.useFakeTimers()
    const client = createMockSlopClient()
    const store = createSlopStore(client)
    await store.load()
    expect(store.getSnapshot().status).toBe('ready')
    expect(store.getSnapshot().cursor).toBe('12')

    const connection = store.getSnapshot().snapshot?.machineConnections[0]
    expect(connection).toBeDefined()
    if (connection === undefined) return
    client.emit({
      schemaVersion: 1,
      projection: 'machine-connection',
      change: 'upsert',
      id: connection.id,
      revision: connection.revision + 1,
      cursor: '13',
      value: { ...connection, freshness: 'current', revision: connection.revision + 1 },
    })
    expect(store.getSnapshot().snapshot?.machineConnections[0]?.freshness).toBe('current')
    expect(store.getSnapshot().cursor).toBe('13')

    client.emit({
      schemaVersion: 1,
      projection: 'machine-connection',
      change: 'upsert',
      id: connection.id,
      revision: connection.revision + 2,
      cursor: '15',
      value: { ...connection, freshness: 'current', revision: connection.revision + 2 },
    })
    expect(store.getSnapshot().status).toBe('resync-required')
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', connected: true, cursor: '15' })
    expect(store.getSnapshot().snapshot?.machineConnections[0]?.revision).toBe(connection.revision + 2)
    store.destroy()
  })

  it('preserves replay delivered synchronously during subscription', async () => {
    const client = createMockSlopClient()
    const subscribe = client.events.subscribe
    vi.spyOn(client.events, 'subscribe').mockImplementation((...args) => {
      const stop = subscribe(...args)
      client.emit({ schemaVersion: 1, projection: 'machine-connection', change: 'remove', id: 'gone', revision: 1, cursor: '13' })
      return stop
    })
    const store = createSlopStore(client)
    await store.load()
    expect(store.getSnapshot().cursor).toBe('13')
    store.destroy()
  })

  it('reconnects after a dropped feed and ignores callbacks from its old subscription', async () => {
    vi.useFakeTimers()
    const client = createMockSlopClient()
    const callbacks: Parameters<EventFeedClient['subscribe']>[] = []
    const subscribe = client.events.subscribe
    vi.spyOn(client.events, 'subscribe').mockImplementation((...args) => {
      callbacks.push(args)
      return subscribe(...args)
    })
    const store = createSlopStore(client)
    await store.load()
    callbacks[0]?.[4]?.('offline')
    expect(store.getSnapshot()).toMatchObject({ status: 'offline', connected: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(callbacks).toHaveLength(2)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', connected: true })
    callbacks[0]?.[4]?.('offline')
    expect(store.getSnapshot().status).toBe('ready')
    store.destroy()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(callbacks).toHaveLength(2)
  })

  it('retains an immediate subscription failure and retries with bounded backoff', async () => {
    vi.useFakeTimers()
    const client = createMockSlopClient()
    const subscribe = vi.spyOn(client.events, 'subscribe').mockImplementation((_feed, _cursor, _token, _event, onState) => {
      onState?.('offline')
      return () => {}
    })
    const store = createSlopStore(client)
    await store.load()
    expect(store.getSnapshot()).toMatchObject({ status: 'offline', connected: false })
    await vi.advanceTimersByTimeAsync(499)
    expect(subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(3)
    store.destroy()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a failed initial baseline but never subscribes after disposal during a load', async () => {
    vi.useFakeTimers()
    const client = createMockSlopClient()
    const call = vi.spyOn(client, 'call').mockResolvedValueOnce({ ok: false, error: { code: 'UNAVAILABLE', message: 'Host restarting', retryable: true } })
    const subscribe = vi.spyOn(client.events, 'subscribe')
    const store = createSlopStore(client)
    await store.load()
    expect(store.getSnapshot().status).toBe('offline')
    await vi.advanceTimersByTimeAsync(500)
    expect(store.getSnapshot().status).toBe('ready')
    expect(call).toHaveBeenCalledTimes(2)
    const pending = store.load()
    store.destroy()
    await pending
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
