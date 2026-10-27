// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlopUiProvider, useSlopUi } from '../src/context.tsx'
import { createMockSlopClient } from '../src/mock.ts'
import { createSlopStore, type SlopStore } from '../src/store.ts'

afterEach(() => { cleanup() })

function StoreProbe({ label, stores }: { label: string; stores: Set<SlopStore> }): React.ReactNode {
  const { state, store } = useSlopUi()
  stores.add(store)
  return <span>{label}:{state.status}</span>
}

describe('plugin-lifetime SLOP store', () => {
  it('shares one load and feed across provider surfaces and keeps them alive through unmounts', async () => {
    const client = createMockSlopClient()
    const call = vi.spyOn(client, 'call')
    const originalSubscribe = client.events.subscribe
    const stopFeed = vi.fn()
    const subscribe = vi.spyOn(client.events, 'subscribe').mockImplementation((feedId, cursor, token, onEvent, onState) => {
      const stop = originalSubscribe(feedId, cursor, token, onEvent, onState)
      return () => {
        stopFeed()
        stop()
      }
    })
    const store = createSlopStore(client)

    await store.load()
    const stores = new Set<SlopStore>()
    const first = render(<SlopUiProvider client={client} store={store}><StoreProbe label="first" stores={stores} /></SlopUiProvider>)
    const second = render(<SlopUiProvider client={client} store={store}><StoreProbe label="second" stores={stores} /></SlopUiProvider>)

    expect(screen.getByText('first:ready')).toBeTruthy()
    expect(screen.getByText('second:ready')).toBeTruthy()
    expect(stores).toEqual(new Set([store]))
    expect(call.mock.calls.filter(([method]) => method === 'slop.snapshot')).toHaveLength(1)
    expect(subscribe).toHaveBeenCalledTimes(1)

    first.unmount()
    second.unmount()
    expect(stopFeed).not.toHaveBeenCalled()

    store.destroy()
    store.destroy()
    expect(stopFeed).toHaveBeenCalledTimes(1)
  })
})
