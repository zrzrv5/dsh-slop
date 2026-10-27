// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { ChatJobs, observationAge } from '../src/ChatJobs.tsx'
import { RemoteShellView, remoteShellModel } from '../src/RemoteShellView.tsx'
import { decodeChatQueue } from '../src/chat-queue-client.ts'
import { machineChipDetails, machineChipStatus } from '../src/ChatMachineChips.tsx'
import { SlopUiProvider } from '../src/context.tsx'
import { createFixtureSnapshot, createMockSlopClient } from '../src/mock.ts'
import { createSlopStore } from '../src/store.ts'
import { HeaderStatus } from '../src/chat-status-registration.tsx'
import { parseMachineId } from '../src/types.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function shell(output: unknown, overrides: Partial<Extract<ToolCallBlock, { kind: 'tool-result' }>> = {}): ToolCallBlock {
  const argsRaw = JSON.stringify({ machineId: 'nova', command: 'echo hello', workdir: '/work' })
  return { kind: 'tool-result', seq: 2, time: 2500, callId: 'shell-1', name: 'slop_machine_shell', args: PartialArguments.fromText(argsRaw), call: { name: 'slop_machine_shell', argsRaw }, callTime: 1000,
    content: [{ type: 'text', text: JSON.stringify(output) }], isError: false, subCalls: [], ...overrides }
}

describe('Chat status and shell', () => {
  it('uses compact observation ages and handles missing or future timestamps', () => {
    const now = Date.parse('2026-09-17T12:00:00Z')
    expect(observationAge('2026-09-17T11:59:45Z', now)).toBe('15 s ago')
    expect(observationAge('2026-09-17T11:55:00Z', now)).toBe('5 min ago')
    expect(observationAge('2026-09-17T10:00:00Z', now)).toBe('2 hr ago')
    expect(observationAge('2026-09-18T10:00:00Z', now)).toBe('0 s ago')
    expect(observationAge(undefined, now)).toBe('—')
  })

  it('refreshes the selected observation with a protected request and shows the new state', async () => {
    vi.stubGlobal('__DSH_SLOP_BOOT__', { csrfNonce: 'abcdefghijklmnopqrstuvwxyz012345', browserBootstrapPath: '/dsh-slop/browser-bootstrap', knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings', queueSettingsBridgePath: '/dsh-slop/queue-settings' })
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, sessionId: 'one', items: [{ id: 'q1', label: 'Pilot', state: init.method === 'PUT' ? 'completed' : 'running', target: { kind: 'local' }, observerId: '123', observerKind: 'slurm', relation: 'owned', observedAt: new Date(Date.now() - 5000).toISOString() }] }) }))
    vi.stubGlobal('fetch', fetcher)
    const client = createMockSlopClient(); const store = createSlopStore(client); await store.load()
    render(<SlopUiProvider client={client} store={store}><ChatJobs sessionId="one" /></SlopUiProvider>)
    fireEvent.click(await screen.findByRole('button', { name: /1 job/ }))
    const refresh = screen.getByRole('button', { name: 'Refresh Pilot' })
    expect(refresh.parentElement?.textContent).toContain('s ago')
    fireEvent.click(refresh)
    await waitFor(() => expect(screen.getByRole('table').textContent).toContain('completed'))
    expect(fetcher).toHaveBeenLastCalledWith('/dsh-slop/queue-settings', expect.objectContaining({ method: 'PUT', credentials: 'same-origin', body: JSON.stringify({ scope: 'chat-refresh', sessionId: 'one', id: 'q1' }), headers: expect.objectContaining({ 'x-dsh-slop-csrf': 'abcdefghijklmnopqrstuvwxyz012345' }) }))
    store.destroy()
  })
  it('adds chips to the native header without replacing its content and preserves drafts on Connect', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target, borderBoxSize: [{ inlineSize: 120, blockSize: 24 }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      disconnect() {}
    })
    const client = createMockSlopClient(); const store = createSlopStore(client); await store.load()
    const inventory = await client.call('slop.machine.list', {})
    if (!inventory.ok) throw new Error('inventory')
    const saved = inventory.value.find(machine => machine.kind === 'ssh')
    if (!saved) throw new Error('fixture')
    const extra = Array.from({ length: 4 }, (_, index) => {
      const id = parseMachineId(`018f0000-0000-7000-8000-00000000000${index + 3}`)
      if (!id) throw new Error('fixture id')
      return { ...saved, id, name: `Saved Machine ${index + 3}` }
    })
    vi.spyOn(client, 'call').mockResolvedValueOnce({ ok: true, value: [...inventory.value, ...extra] })
    const setDraft = vi.fn(); const submit = vi.fn()
    const input = { draft: 'Keep my draft', phase: 'plain', attachmentIds: [] }
    const props = { client, store, sessionId: 'chat', useInput: (select: (value: typeof input) => unknown) => select(input), inputActions: { setDraft, submit } }
    const rendered = render(<header><div>Native title and tabs</div><div><HeaderStatus {...props as unknown as Parameters<typeof HeaderStatus>[0]} /></div></header>)
    const chips = await screen.findAllByRole('button', { name: /Not connected|Stale|Connected/ })
    expect(screen.getByRole('button', { name: /Saved Machine 6/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^\+\d+$/ })).toBeNull()
    const chip = chips[0]; if (!chip) throw new Error('fixture')
    fireEvent.mouseEnter(chip)
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', expect.stringContaining('researcher@atlas.example.edu'))
    expect(submit).not.toHaveBeenCalled()
    fireEvent.mouseLeave(chip)
    fireEvent.click(chip)
    const connect = screen.queryByRole('button', { name: 'Connect in this Chat' })
    if (connect) fireEvent.click(connect)
    expect(screen.getByText(/Your draft has been kept/)).toBeTruthy()
    expect(setDraft).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
    input.draft = ''
    fireEvent.click(chip); fireEvent.click(chip)
    const retry = screen.queryByRole('button', { name: 'Connect in this Chat' })
    if (retry) fireEvent.click(retry)
    expect(setDraft).toHaveBeenCalledWith(expect.stringContaining('using slop_machine_connect with machineId'))
    expect(submit).toHaveBeenCalledOnce()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Local workstation Ready/ }))
    expect(screen.getByRole('dialog', { name: 'Local workstation' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Native title and tabs')).toBeTruthy()
    expect(screen.getByLabelText('Machines').closest('header')?.textContent).toContain('Native title and tabs')
    rendered.unmount(); expect(screen.queryByLabelText('Machines')).toBeNull(); store.destroy()
  })

  it('uses the same presentation for native and nested PTC results and retains failure output', () => {
    const result = { ok: true, value: { exitCode: 2, timedOut: false, stdout: '', stderr: 'missing input' } }
    const native = remoteShellModel(shell(result))
    expect(native).toMatchObject({ command: 'echo hello', workdir: '/work', status: 'Failed', exitCode: 2, stderr: 'missing input', duration: 1500 })
    expect(remoteShellModel(shell(result, { parentCallId: 'code-1' }))).toEqual(native)
    expect(remoteShellModel(shell({ ok: true, value: { exitCode: 0, stdout: 'job FAILED', stderr: '' } })).status).toBe('Completed')
    expect(remoteShellModel(shell({ ok: true, value: { exitCode: 0, timedOut: true } })).status).toBe('Timed out')
    expect(remoteShellModel(shell({ ok: false, error: { message: 'Access expired' } }))).toMatchObject({ status: 'Failed', error: 'Access expired' })
  })

  it('shows a preparing shell call before arguments arrive', async () => {
    const block: ToolCallBlock = { phase: 'preparing', callId: 'shell-preparing', name: 'slop_machine_shell', args: new PartialArguments(), turn: 1, step: 1, time: 1000, subCalls: [] }
    expect(remoteShellModel(block)).toMatchObject({ preparing: true, argsRaw: '', command: undefined, status: 'Preparing' })
    const client = createMockSlopClient(); const store = createSlopStore(client); await store.load()
    render(<SlopUiProvider client={client} store={store}><RemoteShellView block={block} /></SlopUiProvider>)
    expect(screen.getByText('Preparing remote shell…')).toBeTruthy()
    block.args.append('{"command":"echo hel')
    expect(remoteShellModel(block)).toMatchObject({ preparing: true, command: 'echo hel' })
    block.args.append('lo"}')
    expect(remoteShellModel(block).command).toBe('echo hello')
    store.destroy()
  })

  it('reads parsed PTC argument views even without a raw call head', () => {
    const block = shell({ ok: true, value: { exitCode: 0 } }, { call: null, parentCallId: 'ptc', args: PartialArguments.fromObject({ command: 'hostname', machineId: 'nova' }) })
    expect(remoteShellModel(block)).toMatchObject({ command: 'hostname', machineId: 'nova', status: 'Completed' })
  })

  it('renders commands and stderr without treating output as markup', async () => {
    const client = createMockSlopClient(); const store = createSlopStore(client); await store.load()
    render(<SlopUiProvider client={client} store={store}><RemoteShellView block={shell({ ok: true, value: { exitCode: 1, stdout: '', stderr: '<script>bad()</script>' } })} /></SlopUiProvider>)
    expect(screen.getByText('echo hello')).toBeTruthy()
    const disclosure = screen.getByRole('button', { name: /Remote shell/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure.textContent).toContain('Failed')
    expect(screen.queryByText('<script>bad()</script>')).toBeNull()
    fireEvent.click(disclosure)
    expect(screen.getByText('<script>bad()</script>')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    fireEvent.keyDown(disclosure, { key: 'Enter' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    cleanup(); store.destroy()
  })

  it('does not show an expired or offline connection as ready', async () => {
    const fixture = createFixtureSnapshot(); const client = createMockSlopClient(fixture)
    const result = await client.call('slop.machine.list', {})
    if (!result.ok) throw new Error('inventory')
    const machine = result.value.find(item => item.kind === 'ssh'); const row = fixture.machineConnections[0]
    if (!machine || !row) throw new Error('fixture')
    expect(machineChipDetails(machine)).toMatchObject({ scheduled: true, endpoint: 'researcher@atlas.example.edu', scheduler: 'slurm' })
    expect(machineChipDetails({ ...machine, scheduler: 'none' }).scheduled).toBe(false)
    expect(machineChipDetails({ ...machine, scheduler: 'direct' })).toMatchObject({ scheduled: false, scheduler: 'none' })
    expect(machineChipDetails({ ...machine, scheduler: 'unknown' }).scheduled).toBe(false)
    const ready = { ...row, freshness: 'current' as const, connection: { state: 'ready' as const, observedAt: '2026-09-05T10:00:00Z', expiresAt: '2026-09-05T10:01:00Z' } }
    expect(machineChipStatus(machine, ready, true, Date.parse('2026-09-05T10:02:00Z')).label).toBe('Stale')
    expect(machineChipStatus(machine, ready, false, 0).label).toBe('Status unavailable')
  })

  it('fails closed on a response for another Chat', () => {
    expect(() => decodeChatQueue({ schemaVersion: 1, sessionId: 'other', items: [] }, 'current')).toThrow()
    expect(() => decodeChatQueue({ schemaVersion: 1, sessionId: 'current', items: [{ state: 'invented' }] }, 'current')).toThrow()
  })

  it('expands Jobs inline until toggled and clears rows on session change', async () => {
    vi.stubGlobal('__DSH_SLOP_BOOT__', { csrfNonce: 'abcdefghijklmnopqrstuvwxyz012345', browserBootstrapPath: '/dsh-slop/browser-bootstrap', knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings', queueSettingsBridgePath: '/dsh-slop/queue-settings' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ schemaVersion: 1, sessionId: new URL(url, 'http://localhost').searchParams.get('sessionId'), items: url.includes('sessionId=one') ? [{ id: 'q1', label: 'Simulation', state: 'running', target: { kind: 'local' }, observerId: '12', observerKind: 'process', relation: 'owned', evidence: 'still running', elapsedSeconds: 8 }] : [] }) })))
    const client = createMockSlopClient(); const store = createSlopStore(client); await store.load()
    const view = (sessionId: string) => <SlopUiProvider client={client} store={store}><ChatJobs key={sessionId} sessionId={sessionId} /></SlopUiProvider>
    const rendered = render(view('one'))
    const summary = await screen.findByRole('button', { name: /1 job/ })
    expect(summary.textContent).toContain('1 machine · Host')
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(summary.hasAttribute('aria-haspopup')).toBe(false)
    expect(screen.queryByRole('table')).toBeNull()
    summary.focus()
    fireEvent.click(summary)
    const panel = screen.getByRole('region', { name: 'Jobs in this Chat' })
    expect(panel.id).toBe(summary.getAttribute('aria-controls'))
    expect(panel.contains(screen.getByRole('table'))).toBe(true)
    expect(screen.getByRole('region', { name: 'Jobs' }).contains(panel)).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(summary)
    fireEvent.click(screen.getByRole('button', { name: 'Simulation' }))
    expect(screen.getByText('still running')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.pointerDown(document.body)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('table')).toBeNull()
    fireEvent.click(summary)
    expect(screen.getByText('still running')).toBeTruthy()
    rendered.rerender(view('two'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /1 job/ })).toBeNull())
    cleanup(); store.destroy()
  })
})
