// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthTerminal } from '../src/AuthTerminal.tsx'
import type { AuthTerminalClient, SlopRemoteClient } from '../src/remote-client.ts'

type CarrierState = 'connecting' | 'attached' | 'closed' | 'error'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function makeClient(auth: AuthTerminalClient, status: 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired' = 'pending'): SlopRemoteClient {
  return {
    auth,
    call: vi.fn(async (method: string) => {
      if (method === 'slop.authFlow.status') return { ok: true as const, value: { state: status, resumed: status === 'ready' } }
      if (method === 'slop.authFlow.cancel') return { ok: true as const, value: { cancelled: true as const } }
      return { ok: false as const, error: { code: 'FAILED', message: `Unexpected call: ${method}`, retryable: false } }
    }),
  } as unknown as SlopRemoteClient
}

describe('protected SSH terminal', () => {
  it('renders the host prompt and enables protected response only after attachment', () => {
    const send = vi.fn()
    const client = makeClient({
      open: (_flowId, onOutput, onState) => {
        onOutput('(alice@login.example.edu) Verification code: ')
        onState?.('attached')
        return { send, close: vi.fn() }
      },
    })
    render(<AuthTerminal client={client} authFlowId="auth-flow-1" carrierFlowId="carrier-flow-1" embedded onClose={() => {}} onReady={async () => {}} />)

    expect(screen.getByText('(alice@login.example.edu) Verification code:')).toBeDefined()
    const response = screen.getByLabelText('SSH response') as HTMLInputElement
    expect(response.disabled).toBe(false)
    fireEvent.change(response, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send response' }))
    expect(send).toHaveBeenCalledWith('123456\n')
    expect(response.value).toBe('')
  })

  it('never disguises a failed terminal carrier as a host that is still waiting', () => {
    const client = makeClient({
      open: (_flowId, _onOutput, onState) => {
        onState?.('error')
        onState?.('closed')
        return { send: vi.fn(), close: vi.fn() }
      },
    })
    render(<AuthTerminal client={client} authFlowId="auth-flow-error" carrierFlowId="carrier-flow-error" embedded onClose={() => {}} onReady={async () => {}} />)

    expect(screen.queryByText('Waiting for the SSH prompt…')).toBeNull()
    expect(screen.getByText('No host prompt was received because the protected terminal connection failed.')).toBeDefined()
    expect(screen.getByText(/could not connect/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload DSH' })).toBeDefined()
    expect((screen.getByLabelText('SSH response') as HTMLInputElement).disabled).toBe(true)
  })

  it('turns a silent carrier handshake into an actionable timeout instead of waiting forever', async () => {
    vi.useFakeTimers()
    const client = makeClient({
      open: (_flowId, _onOutput, onState) => {
        onState?.('connecting')
        return { send: vi.fn(), close: vi.fn() }
      },
    })
    render(<AuthTerminal client={client} authFlowId="auth-flow-silent" carrierFlowId="carrier-flow-silent" embedded onClose={() => {}} onReady={async () => {}} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    expect(screen.getByText('The protected SSH terminal did not finish connecting.')).toBeDefined()
    expect(screen.getByText(/connection is taking too long/i)).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reconnect terminal' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload DSH' })).toBeDefined()
  })

  it('reopens the same flow and recovers the replayed host prompt after disconnect', async () => {
    const stateCallbacks: Array<(state: CarrierState) => void> = []
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const open = vi.fn((_flowId: string, onOutput: (text: string) => void, onState?: (state: CarrierState) => void) => {
      if (onState !== undefined) stateCallbacks.push(onState)
      if (stateCallbacks.length === 1) onState?.('attached')
      else {
        onOutput('(alice@login.example.edu) Password: ')
        onState?.('attached')
      }
      const close = vi.fn()
      closes.push(close)
      return { send: vi.fn(), close }
    })
    const client = makeClient({ open })
    render(<AuthTerminal client={client} authFlowId="auth-flow-reconnect" carrierFlowId="carrier-flow-reconnect" embedded onClose={() => {}} onReady={async () => {}} />)

    act(() => { stateCallbacks[0]?.('closed') })
    expect(screen.getAllByText(/terminal disconnected/i)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect terminal' }))

    await waitFor(() => { expect(open).toHaveBeenCalledTimes(2) })
    expect(closes[0]).toHaveBeenCalled()
    expect(open.mock.calls[1]?.[0]).toBe('carrier-flow-reconnect')
    expect(screen.getByText('(alice@login.example.edu) Password:')).toBeDefined()
  })

  it('shows an expired auth lifecycle explicitly and invokes readiness once', async () => {
    vi.useFakeTimers()
    const onReady = vi.fn(async () => {})
    const close = vi.fn()
    const expired = makeClient({ open: (_flowId, _onOutput, onState) => { onState?.('attached'); return { send: vi.fn(), close } } }, 'expired')
    const first = render(<AuthTerminal client={expired} authFlowId="auth-flow-expired" carrierFlowId="carrier-flow-expired" embedded onClose={() => {}} onReady={onReady} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByText('SSH sign-in expired before it completed.')).toBeDefined()
    expect(screen.getByText(/expired.*start a new sign-in/i)).toBeDefined()
    expect(close).toHaveBeenCalled()
    expect(onReady).not.toHaveBeenCalled()

    first.unmount()
    const ready = makeClient({ open: (_flowId, _onOutput, onState) => { onState?.('attached'); return { send: vi.fn(), close: vi.fn() } } }, 'ready')
    render(<AuthTerminal client={ready} authFlowId="auth-flow-ready" carrierFlowId="carrier-flow-ready" embedded retainCompletion onClose={() => {}} onReady={onReady} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Authentication completed')).toBeDefined()
    expect(screen.queryByLabelText('SSH response')).toBeNull()
  })

  it('keeps the protected carrier id separate from lifecycle status and cancellation', async () => {
    vi.useFakeTimers()
    const open = vi.fn((_carrierFlowId: string, _onOutput: (text: string) => void, onState?: (state: CarrierState) => void) => {
      onState?.('attached')
      return { send: vi.fn(), close: vi.fn() }
    })
    const onClose = vi.fn()
    const client = makeClient({ open })
    render(<AuthTerminal client={client} authFlowId="auth-lifecycle-1" carrierFlowId="protected-carrier-1" embedded onClose={onClose} onReady={async () => {}} />)

    expect(open).toHaveBeenCalledWith('protected-carrier-1', expect.any(Function), expect.any(Function))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(client.call).toHaveBeenCalledWith('slop.authFlow.status', { authFlowId: 'auth-lifecycle-1' })

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel sign-in' })) })
    expect(client.call).toHaveBeenCalledWith('slop.authFlow.cancel', { authFlowId: 'auth-lifecycle-1' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
