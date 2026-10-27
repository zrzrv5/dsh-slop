// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachineSettings } from '../src/MachineSettings.tsx'
import { SlopUiProvider } from '../src/context.tsx'
import { createMockSlopClient } from '../src/mock.ts'
import type { SlopRemoteClient } from '../src/remote-client.ts'
import { createSlopStore } from '../src/store.ts'

afterEach(cleanup)

function renderSettings(client: SlopRemoteClient = createMockSlopClient()) {
  const store = createSlopStore(client)
  const view = render(<SlopUiProvider client={client} store={store}><MachineSettings /></SlopUiProvider>)
  return { ...view, store }
}

describe('Machine Settings without onboarding ownership', () => {
  it('keeps Machine setup in Chat instead of mounting a Settings workbench', async () => {
    const { store } = renderSettings()
    expect(await screen.findByText(/Machine setup starts in Chat/)).toBeDefined()
    expect(screen.getByText('/onboard-slop')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Connect a compute machine' })).toBeNull()
    expect(screen.queryByRole('table', { name: /scan budget/i })).toBeNull()
    store.destroy()
  })

  it('keeps corrections out of Settings and archives with both exact revisions', async () => {
    const client = createMockSlopClient()
    const call = vi.spyOn(client, 'call')
    const { store } = renderSettings(client)

    fireEvent.click(await screen.findByRole('button', { name: /Atlas cluster/ }))
    expect(screen.getByText(/read-only/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => { expect(call.mock.calls.some(([method]) => method === 'slop.machine.archive')).toBe(true) })
    const archive = call.mock.calls.find(([method]) => method === 'slop.machine.archive')
    expect(archive?.[1]).toMatchObject({
      schemaVersion: 1,
      machineId: '018f0000-0000-7000-8000-000000000002',
      expectedMachineRevision: 7,
      expectedAccessProfileRevision: 3,
    })
    store.destroy()
  })

  it('does not mount fixed capability probes', async () => {
    const client = createMockSlopClient()
    const call = vi.spyOn(client, 'call')
    const { store } = renderSettings(client)

    fireEvent.click(await screen.findByRole('button', { name: /Atlas cluster/ }))
    expect(screen.queryByRole('button', { name: 'Run fixed probe' })).toBeNull()
    expect(call.mock.calls.map(([method]) => method)).toEqual(expect.not.arrayContaining([
      'slop.machine.capabilities.list',
      'slop.machine.capabilities.probe',
    ]))
    store.destroy()
  })
})
