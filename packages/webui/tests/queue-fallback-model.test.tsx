// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUEUE_FALLBACK_SCOPE, QueueFallbackModel, type QueueFallbackModelSource, type QueueFallbackModelValues, type QueueFallbackModelView } from '../src/QueueFallbackModel.tsx'
import { QUEUE_SETTINGS_NAMESPACE, createQueueFallbackSource } from '../src/client/queue-fallback-source.ts'

afterEach(cleanup)

const inherit: QueueFallbackModelView = { provider: '', model: '', reasoningEffort: '', revision: 3, writable: true }

const input = async (label: RegExp): Promise<HTMLInputElement> => await screen.findByLabelText<HTMLInputElement>(label)

describe('Queue fallback worker model', () => {
  it('loads the saved route and offers configured providers as suggestions', async () => {
    const source: QueueFallbackModelSource = {
      load: async () => ({ ...inherit, provider: 'deepseek', model: 'deepseek-chat' }),
      save: vi.fn(),
      listProviders: async () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'local-mlx', name: 'Local MLX' }],
    }
    render(<QueueFallbackModel source={source} />)

    expect((await input(/^Provider route/u)).value).toBe('deepseek')
    expect((await input(/^Model/u)).value).toBe('deepseek-chat')
    expect((await input(/^Reasoning effort/u)).value).toBe('')
    expect(screen.getByText(QUEUE_FALLBACK_SCOPE)).toBeDefined()
    await waitFor(() => { expect(document.querySelectorAll('datalist option')).toHaveLength(2) })
    const provider = await input(/^Provider route/u)
    expect(document.getElementById(provider.getAttribute('list') ?? '')?.tagName).toBe('DATALIST')
  })

  it('saves trimmed values against the revision it read', async () => {
    const save = vi.fn(async (values: QueueFallbackModelValues, revision: number): Promise<QueueFallbackModelView> => ({ ...values, revision: revision + 1, writable: true }))
    render(<QueueFallbackModel source={{ load: async () => inherit, save }} />)

    fireEvent.change(await input(/^Provider route/u), { target: { value: ' local-mlx ' } })
    fireEvent.change(await input(/^Model/u), { target: { value: 'qwen' } })
    fireEvent.change(await input(/^Reasoning effort/u), { target: { value: 'low' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save fallback model' }))

    await waitFor(() => { expect(save).toHaveBeenCalledWith({ provider: 'local-mlx', model: 'qwen', reasoningEffort: 'low' }, 3) })
    expect(await screen.findByText('Saved.')).toBeDefined()
    expect((await input(/^Provider route/u)).value).toBe('local-mlx')
  })

  it('clears the fields to inherit the Chat model and reports a refused save', async () => {
    const save = vi.fn(async () => { throw new Error('settings/conflict') })
    render(<QueueFallbackModel source={{ load: async () => ({ ...inherit, provider: 'deepseek', model: 'deepseek-chat' }), save }} />)

    fireEvent.change(await input(/^Provider route/u), { target: { value: '' } })
    fireEvent.change(await input(/^Model/u), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save fallback model' }))

    await waitFor(() => { expect(save).toHaveBeenCalledWith({ provider: '', model: '', reasoningEffort: '' }, 3) })
    expect(await screen.findByText('settings/conflict')).toBeDefined()
  })

  it('ignores a failing provider list, disables a read-only profile and retries a failed load', async () => {
    const load = vi.fn<() => Promise<QueueFallbackModelView>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ...inherit, writable: false })
    render(<QueueFallbackModel source={{ load, save: vi.fn(), listProviders: async () => { throw new Error('no llm') } }} />)

    expect(await screen.findByText('offline')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /retry/iu }))
    expect((await input(/^Provider route/u)).disabled).toBe(true)
    expect(screen.getByText('This profile does not accept setting changes.')).toBeDefined()
    expect(screen.queryByText('no llm')).toBeNull()
  })
})

describe('Queue fallback settings source', () => {
  const described = (value: unknown, writable = true) => ({ ok: true, value: { writable, namespaces: [{ ns: QUEUE_SETTINGS_NAMESPACE, value, revision: 9 }] } })

  it('reads the three fallback keys and treats absent or invalid values as inherit', async () => {
    const source = createQueueFallbackSource({ describe: async () => described({ fallbackProvider: 'deepseek', fallbackModel: 7 }), update: vi.fn() })
    await expect(source.load()).resolves.toEqual({ provider: 'deepseek', model: '', reasoningEffort: '', revision: 9, writable: true })
  })

  it('writes all three keys with the expected revision', async () => {
    const update = vi.fn(async () => ({ ok: true, value: { ns: QUEUE_SETTINGS_NAMESPACE, value: { fallbackProvider: '', fallbackModel: 'm', fallbackReasoningEffort: '' }, revision: 10 } }))
    const source = createQueueFallbackSource({ describe: vi.fn(), update })
    await expect(source.save({ provider: '', model: 'm', reasoningEffort: '' }, 9)).resolves.toEqual({ provider: '', model: 'm', reasoningEffort: '', revision: 10, writable: true })
    expect(update).toHaveBeenCalledWith(QUEUE_SETTINGS_NAMESPACE, { fallbackProvider: '', fallbackModel: 'm', fallbackReasoningEffort: '' }, 9)
  })

  it('reports a disabled Queue and lists providers only when the LLM Remote answers', async () => {
    const missing = createQueueFallbackSource({ describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }), update: vi.fn() })
    await expect(missing.load()).rejects.toThrow(/Queue is not enabled/u)
    await expect(missing.listProviders?.()).resolves.toEqual([])

    const listed = createQueueFallbackSource({ describe: vi.fn(), update: vi.fn() }, () => ({ listProviders: async () => ({ ok: true, value: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 3 }] }) }))
    await expect(listed.listProviders?.()).resolves.toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
  })
})
