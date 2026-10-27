import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

describe('/setupmachine conversation scope', () => {
  it('keeps command history and mounts setup as an active Chat business node on one store', async () => {
    const injected: string[] = []
    const registered: Array<{ name: string; options: Record<string, unknown> }> = []
    const disposeRemote = vi.fn()
    const snapshot = vi.fn(async () => ({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'No baseline in this focused fixture.', retryable: false } }))
    const ctx = {
      reflect: { provide: vi.fn() },
      remote: { $mount: vi.fn(async () => disposeRemote) },
      get: vi.fn((key: string) => key === 'remote.slop' ? { snapshot } : undefined),
      settingsScope: { bind: vi.fn(() => ({ getSnapshot: () => ({ status: 'ready', value: undefined }) })) },
      uiConversation: { events: { register: vi.fn() } },
      on: vi.fn(),
      slots: {
        entriesOfSlot: () => [{ options: { key: 'read' }, component: () => null }],
        inject: vi.fn((name: string, factory: () => unknown) => { injected.push(name); factory() }),
        register: vi.fn((spec: Record<string, unknown>) => { registered.push({ name: String(spec.name), options: spec }) }),
      },
    }

    const dispose = await apply(ctx as never)

    expect(snapshot).not.toHaveBeenCalled()
    expect(injected).toContain('conversation.chat.commandview')
    expect(registered).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'conversation.chat.commandview', options: expect.objectContaining({ key: 'setupmachine' }) })]))
    expect(registered.filter(item => item.name === 'conversation.chat.node').map(item => item.options['key'])).toEqual([
      'slop-setup-machine',
      'slop-queue-notice',
      'slop-setup-machine-submission',
      'slop-machine-info',
      'slop-machine-connection',
      'slop-machine-transfer-progress',
    ])
    expect(ctx.uiConversation.events.register).toHaveBeenCalledTimes(6)
    // Settings are one DSH-SLOP section; components add tabs instead of sections.
    expect(registered.filter(item => item.name === 'settings.section').map(item => [item.options['id'], item.options['label']])).toEqual([['dsh-slop', 'DSH-SLOP']])
    expect(ctx.on).not.toHaveBeenCalled()
    expect(disposeRemote).not.toHaveBeenCalled()
    await dispose()
    await dispose()
    expect(disposeRemote).toHaveBeenCalledTimes(1)
  })
})
