// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { MachineConnectionChatCard } from '../src/ChatPresentationCards.tsx'
import { SlopUiProvider } from '../src/context.tsx'
import { createFixtureSnapshot, createMockSlopClient } from '../src/mock.ts'
import { createSlopStore } from '../src/store.ts'
import type { EventFeedClient } from '../src/remote-client.ts'
import type { MachineConnectionPresentation } from '../src/types.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-25T13:00:00Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function machineNode(machineId: string, settled = false): ChatNode<'slop-machine-connection'> {
  return {
    key: 'slop-machine-connection:call-connection',
    kind: 'slop-machine-connection',
    id: machineId,
    target: 'chat',
    anchorSeq: 10.01,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data: { machineId, toolCallId: 'call-connection', settled },
  }
}

function namedMachineNode(machineName: string): ChatNode<'slop-machine-connection'> {
  return {
    ...machineNode('unused'),
    id: machineName,
    data: { machineName, toolCallId: 'call-connection', settled: false },
  }
}

describe('projection-backed chat presentation cards', () => {
  it('shows authentication on a new live Tool card when the old feed silently missed the challenge', async () => {
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const client = createMockSlopClient({ ...fixture, machineConnections: [] })
    const subscribe = client.events.subscribe
    let dropFeed: (() => void) | undefined
    vi.spyOn(client.events, 'subscribe').mockImplementation((...args) => {
      dropFeed = subscribe(...args)
      return dropFeed
    })
    const store = createSlopStore(client)
    await store.load()
    dropFeed?.() // No close/error notification reaches this still-open browser.
    const blocked: MachineConnectionPresentation = {
      ...base, revision: 4, actions: ['start-authentication'],
      connection: {
        state: 'blocked', challengeId: 'challenge-missed', challengeRevision: 1,
        reason: 'Authentication is required.', expiresAt: '2026-08-25T14:00:00Z',
        challenge: { kind: 'authentication', authentication: {
          flowState: 'not-started', carrierState: 'not-started', promptState: 'not-observed', writableAttachment: false,
        } },
      },
    }
    client.emit({ schemaVersion: 1, projection: 'machine-connection', change: 'upsert',
      id: blocked.id, revision: blocked.revision, cursor: '13', value: blocked })
    expect(store.getSnapshot().snapshot?.machineConnections).toEqual([])
    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={machineNode(base.machineId)} /></SlopUiProvider>)
    expect(await screen.findByLabelText('SSH response')).toBeTruthy()
    expect(store.getSnapshot().cursor).toBe('13')
    store.destroy()
  })

  it.each(['expired', 'settled'] as const)('does not reopen a %s sign-in from a retained snapshot', async state => {
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const blocked: MachineConnectionPresentation = {
      ...base, actions: ['start-authentication'],
      connection: {
        state: 'blocked', challengeId: 'challenge-ended', challengeRevision: 1,
        reason: 'Authentication is required.',
        expiresAt: state === 'expired' ? '2026-08-25T12:59:00Z' : '2026-08-25T14:00:00Z',
        challenge: { kind: 'authentication', authentication: {
          flowState: 'not-started', carrierState: 'not-started', promptState: 'not-observed', writableAttachment: false,
        } },
      },
    }
    const client = createMockSlopClient({ ...fixture, machineConnections: [blocked] })
    const call = vi.spyOn(client, 'call')
    const store = createSlopStore(client)
    await store.load()
    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={machineNode(base.machineId, state === 'settled')} /></SlopUiProvider>)
    expect(call.mock.calls.filter(([method]) => method === 'slop.authFlow.start')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Open protected sign-in' })).toBeNull()
    if (state === 'expired') expect(screen.getByText('Sign-in expired. Connect again in this Chat.')).toBeTruthy()
    store.destroy()
  })

  it('revalidates a silently disconnected feed when the browser becomes active', async () => {
    const client = createMockSlopClient()
    const store = createSlopStore(client)
    await store.load()
    const call = vi.spyOn(client, 'call')
    window.dispatchEvent(new Event('focus'))
    await store.load()
    expect(call).toHaveBeenCalledWith('slop.snapshot', { pageSize: 500 })
    store.destroy()
    call.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(call).not.toHaveBeenCalled()
  })
  it.each(['live', 'cursor-gap', 'disconnected'] as const)('shows a late authentication input without remounting the Chat after %s delivery', async delivery => {
    vi.useFakeTimers()
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]
    if (base === undefined) throw new Error('Fixture requires a Machine connection')
    const blocked = {
      ...base,
      freshness: 'current',
      revision: 4,
      actions: ['start-authentication'],
      connection: {
        state: 'blocked', challengeId: 'challenge-late-auth', challengeRevision: 4,
        reason: 'Authentication is required.', expiresAt: '2026-08-25T14:00:00.000Z',
        challenge: { kind: 'authentication', authentication: {
          flowState: 'not-started', carrierState: 'not-started', promptState: 'not-observed', writableAttachment: false,
        } },
      },
    } satisfies MachineConnectionPresentation
    const client = createMockSlopClient({ ...fixture, machineConnections: [] })
    const subscribe = client.events.subscribe
    let feedState: Parameters<EventFeedClient['subscribe']>[4]
    let disconnect: (() => void) | undefined
    vi.spyOn(client.events, 'subscribe').mockImplementation((...args) => {
      feedState = args[4]
      disconnect = subscribe(...args)
      return disconnect
    })
    const store = createSlopStore(client)
    await store.load()
    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={machineNode(base.machineId)} /></SlopUiProvider>)
    await act(async () => { await store.load() })
    expect(screen.queryByLabelText('SSH response')).toBeNull()
    await act(async () => {
      if (delivery === 'disconnected') {
        disconnect?.()
        feedState?.('offline')
      }
      client.emit({ schemaVersion: 1, projection: 'machine-connection', change: 'upsert', id: blocked.id,
        revision: blocked.revision, cursor: delivery === 'cursor-gap' ? '15' : '13', value: blocked })
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(screen.getByLabelText('SSH response')).toBeTruthy()
    expect(screen.getAllByLabelText('SSH response')).toHaveLength(1)
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', connected: true })
    store.destroy()
  })

  it('renders one exact actionable Machine challenge and follows its live authority revision', async () => {
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const blocked = {
      ...base,
      freshness: 'current' as const,
      connection: {
        state: 'blocked' as const,
        challengeId: 'challenge-atlas-1',
        challengeRevision: 4,
        challenge: {
          kind: 'host-trust' as const,
          host: 'atlas.example.edu',
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:atlas-test',
          change: 'first-use' as const,
        },
        reason: 'Review the exact host key before SSH.',
        expiresAt: '2026-08-25T14:00:00.000Z',
      },
      waitingSessionCount: 3,
      actions: ['trust-fingerprint', 'open-machine-settings'] as const,
      revision: 4,
    }
    const client = createMockSlopClient({ ...fixture, machineConnections: [blocked] })
    const call = vi.spyOn(client, 'call')
    const store = createSlopStore(client)
    const navigate = vi.fn()
    await store.load()
    render(<SlopUiProvider client={client} store={store} onNavigate={navigate}><MachineConnectionChatCard node={machineNode(blocked.machineId)} /></SlopUiProvider>)

    const card = document.querySelector<HTMLElement>('[data-slop-presentation="machine-connection"]')
    expect(card?.dataset.presentationId).toBe(blocked.id)
    expect(card?.dataset.presentationRevision).toBe('4')
    expect(screen.getByText('Host key review')).toBeTruthy()
    expect(screen.getByText(/3 Chats waiting/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Trust once' }))
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('slop.hostTrust.decide', {
        challengeId: 'challenge-atlas-1',
        expectedChallengeRevision: 4,
        decision: 'trust-once',
        fingerprint: 'SHA256:atlas-test',
      })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Open Machine settings' }))
    expect(navigate).toHaveBeenCalledWith({ kind: 'machines', machineId: blocked.machineId })

    act(() => {
      client.emit({
        schemaVersion: 1,
        cursor: '13',
        projection: 'machine-connection',
        id: blocked.id,
        revision: 5,
        change: 'upsert',
        value: {
          ...blocked,
          connection: { state: 'ready', observedAt: '2026-08-25T13:00:00.000Z', expiresAt: '2026-08-25T13:10:00.000Z' },
          waitingSessionCount: 0,
          actions: [],
          revision: 5,
          updatedAt: '2026-08-25T13:00:00.000Z',
        },
      })
    })
    await waitFor(() => { expect(screen.getByText('Machine connected')).toBeTruthy() })
    expect(document.querySelector<HTMLElement>('[data-slop-presentation="machine-connection"]')?.dataset.presentationRevision).toBe('5')
    store.destroy()
  })

  it('opens protected authentication automatically when the flow advances the challenge revision', async () => {
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const blocked = {
      ...base,
      freshness: 'current' as const,
      connection: {
        state: 'blocked' as const,
        challengeId: 'challenge-atlas-auth',
        challengeRevision: 4,
        challenge: {
          kind: 'authentication' as const,
          authentication: {
            flowState: 'not-started' as const,
            carrierState: 'not-started' as const,
            promptState: 'not-observed' as const,
            writableAttachment: false,
          },
        },
        reason: 'Authentication is required.',
        expiresAt: '2026-08-25T14:00:00.000Z',
      },
      actions: ['start-authentication'] as const,
      revision: 4,
    }
    const client = createMockSlopClient({ ...fixture, machineConnections: [blocked] })
    const call = vi.spyOn(client, 'call')
    const store = createSlopStore(client)
    await store.load()
    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={machineNode(blocked.machineId)} /></SlopUiProvider>)

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('slop.authFlow.start', {
        challengeId: 'challenge-atlas-auth',
        expectedChallengeRevision: 4,
      })
    })
    expect(call.mock.calls.filter(([method]) => method === 'slop.authFlow.start')).toHaveLength(1)
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Sign in to SSH' })).toBeTruthy() })
    expect(screen.queryByText('The protected authentication flow does not match this Machine challenge.')).toBeNull()
    expect(screen.getByLabelText('SSH response').getAttribute('data-slop-auth-flow')).toBe('auth-demo')
    store.destroy()
  })

  it('resolves one unique saved Machine name to its live authentication presentation', async () => {
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const blocked = {
      ...base,
      machineLabel: 'Nova',
      freshness: 'current' as const,
      connection: {
        state: 'blocked' as const,
        challengeId: 'challenge-nova-auth',
        challengeRevision: 2,
        challenge: {
          kind: 'authentication' as const,
          authentication: {
            flowState: 'not-started' as const,
            carrierState: 'not-started' as const,
            promptState: 'not-observed' as const,
            writableAttachment: false,
          },
        },
        reason: 'Authentication is required.',
        expiresAt: '2026-08-25T14:00:00.000Z',
      },
      actions: ['start-authentication'] as const,
      revision: 2,
    }
    const client = createMockSlopClient({ ...fixture, machineConnections: [blocked] })
    const call = vi.spyOn(client, 'call')
    const store = createSlopStore(client)
    await store.load()

    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={namedMachineNode('nova')} /></SlopUiProvider>)

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('slop.authFlow.start', {
        challengeId: 'challenge-nova-auth',
        expectedChallengeRevision: 2,
      })
    })
    expect(screen.getByText('Authentication required')).toBeTruthy()
    store.destroy()
  })

  it('drops a failed terminal as soon as the same authoritative presentation becomes ready', async () => {
    vi.useFakeTimers()
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const blocked = {
      ...base,
      freshness: 'current' as const,
      connection: {
        state: 'blocked' as const,
        challengeId: 'challenge-atlas-auth-ready',
        challengeRevision: 4,
        challenge: {
          kind: 'authentication' as const,
          authentication: {
            flowState: 'not-started' as const,
            carrierState: 'not-started' as const,
            promptState: 'not-observed' as const,
            writableAttachment: false,
          },
        },
        reason: 'Authentication is required.',
        expiresAt: '2026-08-25T14:00:00.000Z',
      },
      actions: ['start-authentication'] as const,
      revision: 4,
    }
    const client = createMockSlopClient({ ...fixture, machineConnections: [blocked] })
    Object.defineProperty(client, 'auth', {
      value: {
        open: (_carrierFlowId: string, _onOutput: (text: string) => void, onState?: (state: 'connecting' | 'attached' | 'closed' | 'error') => void) => {
          onState?.('attached')
          return { send: vi.fn(), close: vi.fn() }
        },
      },
    })
    const call = client.call.bind(client)
    vi.spyOn(client, 'call').mockImplementation(async (method, request) => method === 'slop.authFlow.status'
      ? { ok: true, value: { state: 'failed', resumed: false } }
      : await call(method, request))
    const store = createSlopStore(client)
    await store.load()
    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={machineNode(blocked.machineId)} /></SlopUiProvider>)

    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByText(/SSH rejected or closed this sign-in/)).toBeTruthy()

    act(() => {
      client.emit({
        schemaVersion: 1,
        cursor: '13',
        projection: 'machine-connection',
        id: blocked.id,
        revision: 5,
        change: 'upsert',
        value: {
          ...blocked,
          connection: { state: 'ready', observedAt: '2026-08-25T13:00:00.000Z', expiresAt: '2026-08-25T13:10:00.000Z' },
          waitingSessionCount: 0,
          actions: [],
          revision: 5,
          updatedAt: '2026-08-25T13:00:00.000Z',
        },
      })
    })

    expect(screen.getByText('Machine connected')).toBeTruthy()
    expect(screen.getByText('Authentication completed')).toBeTruthy()
    expect(screen.queryByText(/SSH rejected or closed this sign-in/)).toBeNull()
    expect(screen.queryByLabelText('SSH response')).toBeNull()
    store.destroy()
  })

  it('removes an old challenge card when a newer connection identity becomes current', async () => {
    const fixture = createFixtureSnapshot()
    const base = fixture.machineConnections[0]!
    const oldBlocked = {
      ...base,
      id: `${base.machineId}:sha256:old`,
      connectionIdentityDigest: 'sha256:old',
      freshness: 'current' as const,
      connection: {
        state: 'blocked' as const,
        challengeId: 'challenge-old-identity',
        challengeRevision: 18,
        challenge: { kind: 'reconnect' as const, reason: 'Old access settings require reconnection.' },
        reason: 'Old access settings require reconnection.',
        expiresAt: '2026-08-25T14:00:00.000Z',
      },
      actions: ['open-machine-settings'] as const,
      revision: 18,
      updatedAt: '2026-08-25T12:00:00.000Z',
    }
    const client = createMockSlopClient({ ...fixture, machineConnections: [oldBlocked] })
    const store = createSlopStore(client)
    await store.load()
    render(<SlopUiProvider client={client} store={store}><MachineConnectionChatCard node={machineNode(oldBlocked.machineId)} /></SlopUiProvider>)
    await act(async () => { await store.load() })
    expect(screen.getByText('Reconnect required')).toBeTruthy()

    const currentReady = {
      ...base,
      id: `${base.machineId}:sha256:current`,
      connectionIdentityDigest: 'sha256:current',
      freshness: 'current' as const,
      connection: { state: 'ready' as const, observedAt: '2026-08-25T13:00:00.000Z', expiresAt: '2026-08-25T13:10:00.000Z' },
      waitingSessionCount: 0,
      actions: [] as const,
      revision: 1,
      updatedAt: '2026-08-25T13:00:00.000Z',
    }
    act(() => {
      client.emit({
        schemaVersion: 1,
        cursor: '13',
        projection: 'machine-connection',
        id: currentReady.id,
        revision: currentReady.revision,
        change: 'upsert',
        value: currentReady,
      })
    })

    expect(screen.queryByText('Reconnect required')).toBeNull()
    expect(screen.queryByText('challenge-old-identity')).toBeNull()
    expect(document.querySelector('[data-slop-presentation="machine-connection"]')).toBeNull()
    store.destroy()
  })

})
