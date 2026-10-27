// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, Modal, Panel, SectionHeading, Tabs } from '../src/ui.tsx'

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

function NestedModalHarness() {
  const [outerOpen, setOuterOpen] = useState(false)
  const [innerOpen, setInnerOpen] = useState(false)

  return <>
    <button type="button" onClick={() => { setOuterOpen(true) }}>Launch dialog</button>
    <Modal
      open={outerOpen}
      title="Outer dialog"
      onClose={() => { setOuterOpen(false) }}
      footer={<Button variant="secondary" onClick={() => { setOuterOpen(false) }}>Done</Button>}
    >
      <button type="button" onClick={() => { setInnerOpen(true) }}>Open nested dialog</button>
      <Modal open={innerOpen} title="Inner dialog" onClose={() => { setInnerOpen(false) }} footer={<Button>Confirm</Button>}>
        Nested content
      </Modal>
    </Modal>
  </>
}

describe('shared UI accessibility primitives', () => {
  it('keeps Escape, focus, inert background state, and scroll locking scoped to the top modal', () => {
    const escapedToWindow = vi.fn()
    window.addEventListener('keydown', escapedToWindow)
    document.body.style.overflow = 'clip'

    const view = render(<NestedModalHarness />)
    const launcher = screen.getByRole('button', { name: 'Launch dialog' })
    launcher.focus()
    fireEvent.click(launcher)

    const outer = screen.getByRole('dialog', { name: 'Outer dialog' })
    const outerLayer = outer.closest<HTMLElement>('[data-slop-modal-layer]')
    expect(document.body.style.overflow).toBe('hidden')
    expect(view.container.inert).toBe(true)
    expect(view.container.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(within(outer).getByRole('button', { name: 'Close Outer dialog' }))

    const nestedLauncher = within(outer).getByRole('button', { name: 'Open nested dialog' })
    nestedLauncher.focus()
    fireEvent.click(nestedLauncher)
    const inner = screen.getByRole('dialog', { name: 'Inner dialog' })
    expect(outerLayer?.inert).toBe(true)
    expect(outerLayer?.getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(within(inner).getByRole('button', { name: 'Close Inner dialog' }))

    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Inner dialog' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Outer dialog' })).toBe(outer)
    expect(document.activeElement).toBe(nestedLauncher)
    expect(outerLayer?.inert).toBe(false)
    expect(escapedToWindow).not.toHaveBeenCalled()

    const first = within(outer).getByRole('button', { name: 'Close Outer dialog' })
    const last = within(outer).getByRole('button', { name: 'Done' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(last, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Outer dialog' })).toBeNull()
    expect(document.activeElement).toBe(launcher)
    expect(document.body.style.overflow).toBe('clip')
    expect(view.container.inert).toBe(false)
    expect(view.container.hasAttribute('aria-hidden')).toBe(false)
    window.removeEventListener('keydown', escapedToWindow)
  })

  it('implements automatic, wrapping keyboard activation for horizontal tabs', () => {
    function TabsHarness() {
      const [active, setActive] = useState('jobs')
      return <Tabs
        active={active}
        onChange={setActive}
        ariaLabel="Compute sections"
        items={[
          { id: 'jobs', label: 'Jobs' },
          { id: 'artifacts', label: 'Artifacts', count: 2 },
          { id: 'history', label: 'History' },
        ]}
      />
    }

    render(<TabsHarness />)
    const tablist = screen.getByRole('tablist', { name: 'Compute sections' })
    const tabs = within(tablist).getAllByRole('tab')
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1])

    tabs[0]?.focus()
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(tabs[2])
    expect(tabs[2]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, -1, 0])

    fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0])
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(tabs[2])
    fireEvent.keyDown(tabs[2] as HTMLElement, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(tabs[0])
  })

  it('uses a page heading followed by panel and nested-panel headings', () => {
    render(<>
      <SectionHeading title="Page title" />
      <Panel>
        <SectionHeading title="Panel title" />
        <Panel><SectionHeading title="Nested panel title" /></Panel>
      </Panel>
    </>)

    expect(screen.getByRole('heading', { name: 'Page title', level: 1 })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Panel title', level: 2 })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Nested panel title', level: 3 })).toBeDefined()
  })
})
