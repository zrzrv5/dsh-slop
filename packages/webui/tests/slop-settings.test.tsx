// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlopSettings } from '../src/SlopSettings.tsx'
import { createSettingsTabRegistry, type SlopSettingsTabRegistry } from '../src/settings-tabs.ts'
import { apply as applyCallbacks } from '../src/client/webhook.tsx'

afterEach(cleanup)

function registryWith(...ids: readonly string[]): { tabs: SlopSettingsTabRegistry; dispose: Record<string, () => void> } {
  const tabs = createSettingsTabRegistry()
  const dispose: Record<string, () => void> = {}
  const orders: Record<string, number> = { behavior: 10, machines: 20, knowledge: 30, queue: 40, callbacks: 50 }
  for (const id of ids) {
    const label = id[0]?.toUpperCase() + id.slice(1)
    dispose[id] = tabs.register({ id, order: orders[id] ?? 99, label, render: () => <p>{label} panel</p> })
  }
  return { tabs, dispose }
}

const tabNames = (): string[] => within(screen.getByRole('tablist', { name: 'DSH-SLOP settings' })).getAllByRole('tab').map(tab => tab.textContent ?? '')

describe('DSH-SLOP settings section', () => {
  it('shows only registered tabs, in order, with the first one selected', () => {
    const { tabs } = registryWith('queue', 'behavior', 'machines')
    render(<SlopSettings tabs={tabs} />)

    expect(tabNames()).toEqual(['Behavior', 'Machines', 'Queue'])
    const panel = screen.getByRole('tabpanel')
    expect(panel.textContent).toBe('Behavior panel')
    expect(panel.getAttribute('aria-labelledby')).toBe(screen.getByRole('tab', { name: 'Behavior' }).id)
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-controls')).toBe(panel.id)
  })

  it('switches panels on click and with the arrow keys', () => {
    const { tabs } = registryWith('behavior', 'machines', 'knowledge')
    render(<SlopSettings tabs={tabs} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Knowledge' }))
    expect(screen.getByRole('tabpanel').textContent).toBe('Knowledge panel')
    expect(screen.getByRole('tab', { name: 'Knowledge' }).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Knowledge' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tabpanel').textContent).toBe('Behavior panel')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Behavior' }))

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Behavior' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tabpanel').textContent).toBe('Knowledge panel')
  })

  it('adds a tab when its component registers and drops it when the registration is disposed', () => {
    const { tabs, dispose } = registryWith('behavior', 'machines')
    render(<SlopSettings tabs={tabs} />)

    let disposeCallbacks: () => void = () => undefined
    act(() => { disposeCallbacks = tabs.register({ id: 'callbacks', order: 50, label: 'Callbacks', render: () => <p>Callbacks panel</p> }) })
    expect(tabNames()).toEqual(['Behavior', 'Machines', 'Callbacks'])

    fireEvent.click(screen.getByRole('tab', { name: 'Machines' }))
    act(() => { dispose.machines?.() })
    expect(tabNames()).toEqual(['Behavior', 'Callbacks'])
    expect(screen.getByRole('tabpanel').textContent).toBe('Behavior panel')
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true')

    act(() => { disposeCallbacks() })
    act(() => { disposeCallbacks() })
    expect(tabNames()).toEqual(['Behavior'])
  })

  it('remembers the selected tab when the section is opened again', () => {
    const { tabs } = registryWith('behavior', 'queue')
    const first = render(<SlopSettings tabs={tabs} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Queue' }))
    first.unmount()

    render(<SlopSettings tabs={tabs} />)
    expect(screen.getByRole('tabpanel').textContent).toBe('Queue panel')
  })

  it('keeps the registry snapshot stable between changes', () => {
    const tabs = createSettingsTabRegistry()
    const listener = vi.fn()
    tabs.subscribe(listener)
    const dispose = tabs.register({ id: 'behavior', order: 10, label: 'Behavior', render: () => null })
    expect(tabs.snapshot()).toBe(tabs.snapshot())
    expect(listener).toHaveBeenCalledTimes(1)
    dispose()
    expect(tabs.snapshot()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('registers a component tab for the lifetime of its client plugin', () => {
    const tabs = createSettingsTabRegistry()
    const disposers: Array<() => void> = []
    const ctx = { slopUi: { client: {}, store: {}, settingsTabs: tabs }, effect: (execute: () => () => void) => { disposers.push(execute()) } }

    applyCallbacks(ctx as never)
    expect(tabs.snapshot().map(tab => [tab.id, tab.label])).toEqual([['callbacks', 'Callbacks']])

    for (const dispose of disposers) dispose()
    expect(tabs.snapshot()).toEqual([])
  })
})
