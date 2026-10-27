// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueueSettings } from '../src/QueueSettings.tsx'

const QUEUE_PATH = '/dsh-slop/queue-settings'
const NONCE = 'abcdefghijklmnopqrstuvwxyz012345'

const readyView = {
  schemaVersion: 1,
  settings: {
    schemaVersion: 1,
    revision: 2,
    profile: 'normal',
    initialCheckSeconds: 60,
    automaticMinimumSeconds: 120,
    stableMinimumSeconds: 300,
    walltimeDivisor: 4,
    durationMaximumSeconds: 43_200,
    maximumDetectionDelaySeconds: 7_200,
    queuedMaximumSeconds: 3_600,
    fallbackEnabled: true,
    defaultDelivery: 'notify',
    defaultConditions: ['any-state-change'],
    updatedAt: '2026-09-03T12:00:00.000Z',
  },
  items: [{
    id: 'job-1',
    label: 'Simulation',
    state: 'running',
    observerKind: 'slurm',
    observerId: '123',
    updatedAt: '2026-09-03T12:00:00.000Z',
    revision: 3,
    intervalSource: 'global',
    observationSource: 'code',
    delivery: 'notify',
    lastCheckAt: '2026-09-03T12:00:00.000Z',
    nextCheckAt: '2026-09-03T13:00:00.000Z',
    nextCheckReason: 'walltime-aware stable-running cadence',
    consecutiveFailures: 0,
    timing: { walltimeSeconds: 14_400, elapsedSeconds: 600, expectedRemainingSeconds: 13_800 },
  }],
} as const

function boot(nonce = NONCE): Record<string, string> {
  return {
    csrfNonce: nonce,
    browserBootstrapPath: '/dsh-slop/browser-bootstrap',
    knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings',
    queueSettingsBridgePath: QUEUE_PATH,
  }
}

function response(value: unknown): Pick<Response, 'json' | 'ok' | 'status'> {
  return { ok: true, status: 200, json: async () => value }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('__DSH_SLOP_BOOT__', boot())
})

describe('Queue settings', () => {
  it('shows effective cadence, probe provenance, and per-item timing', async () => {
    const fetch = vi.fn(async () => response(readyView))
    vi.stubGlobal('fetch', fetch)

    render(<QueueSettings />)

    fireEvent.click(await screen.findByRole('button', { name: /Task overrides/ }))
    expect(screen.queryByRole('textbox', { name: 'Override interval (minutes)' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Simulation' }))
    expect(screen.getByText(/Last observation code/)).toBeDefined()
    expect(screen.getByText(/Walltime 4h/)).toBeDefined()
    expect(screen.getByDisplayValue('Normal')).toBeDefined()
    expect(fetch).toHaveBeenCalledWith(QUEUE_PATH, expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'x-dsh-slop-csrf': NONCE }),
    }))
  })

  it('saves a custom walltime cadence and an item override with revisions', async () => {
    const fetch = vi.fn(async () => response(readyView))
    vi.stubGlobal('fetch', fetch)
    render(<QueueSettings />)

    const stable = await screen.findByRole('textbox', { name: 'Stable-running minimum (minutes)' })
    fireEvent.change(stable, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save custom cadence' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(QUEUE_PATH, expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"stableMinimumSeconds":600'),
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: /Task overrides/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Settings for Simulation' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Override interval (minutes)' }), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(QUEUE_PATH, expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ scope: 'item', id: 'job-1', expectedRevision: 3, userIntervalSeconds: 1_200 }),
      }))
    })
  })

  it('keeps overrides collapsed and filters single-row tasks without exposing edit forms', async () => {
    const items = [
      readyView.items[0],
      { ...readyView.items[0], id: 'done', label: 'Finished calculation', state: 'completed' },
      { ...readyView.items[0], id: 'failed', label: 'Failed calculation', state: 'failed' },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => response({ ...readyView, items })))
    render(<QueueSettings />)
    const disclosure = await screen.findByRole('button', { name: /Task overrides/ })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('table', { name: 'Recent task overrides' })).toBeNull()
    fireEvent.click(disclosure)
    const table = screen.getByRole('table', { name: 'Recent task overrides' })
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    expect(within(table).queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Running/ }))
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).getByText('Simulation')).toBeDefined()
    expect(within(table).queryByText('Finished calculation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Queued/ }))
    expect(within(table).getByText('No queued tasks updated in the last 14 days.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    expect(within(table).getAllByRole('row')).toHaveLength(4)
  })
})
