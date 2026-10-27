// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BEHAVIOR_PRESETS, DEFAULT_BEHAVIOR_LEVELS, behaviorTrait } from '@dsh-slop/runtime-base/behavior-catalog'
import { BEHAVIOR_APPLIES_TO, BehaviorSettings, type BehaviorSettingsPatch, type BehaviorSettingsSource, type BehaviorSettingsView } from '../src/BehaviorSettings.tsx'
import { BEHAVIOR_SETTINGS_NAMESPACE, createBehaviorSettingsSource } from '../src/client/behavior-source.ts'

afterEach(cleanup)

const initial: BehaviorSettingsView = { levels: DEFAULT_BEHAVIOR_LEVELS, overrides: {}, revision: 4, writable: true }

/** A save that applies the patch the way the Host does and bumps the revision. */
function acceptingSave() {
  return vi.fn(async (patch: BehaviorSettingsPatch, revision: number): Promise<BehaviorSettingsView> => {
    const { promptOverrides, ...levels } = patch
    return { levels: { ...initial.levels, ...levels }, overrides: promptOverrides ?? initial.overrides, revision: revision + 1, writable: true }
  })
}

const select = async (label: RegExp): Promise<HTMLSelectElement> => await screen.findByLabelText<HTMLSelectElement>(label)

describe('Agent behavior settings', () => {
  it('shows the preset, every trait level and the new-session timing', async () => {
    const source: BehaviorSettingsSource = { load: vi.fn(async () => initial), save: vi.fn() }
    render(<BehaviorSettings source={source} />)

    expect((await select(/^Preset/u)).value).toBe('balanced')
    expect((await select(/^Follow-through/u)).value).toBe('authorized')
    expect((await select(/^Errors/u)).value).toBe('triage')
    expect((await select(/^Reporting/u)).value).toBe('standard')
    expect(screen.getByText(BEHAVIOR_APPLIES_TO)).toBeDefined()
    expect(screen.getByText(/without asking whether to continue/u)).toBeDefined()
  })

  it('saves against the revision it read and confirms the new-session timing', async () => {
    const save = acceptingSave()
    render(<BehaviorSettings source={{ load: async () => initial, save }} />)

    fireEvent.change(await select(/^Follow-through/u), { target: { value: 'confirm' } })

    await waitFor(() => { expect(save).toHaveBeenCalledWith({ followThrough: 'confirm' }, 4) })
    expect(await screen.findByText('Saved. New sessions will use this level.')).toBeDefined()
    expect(screen.getByText(BEHAVIOR_APPLIES_TO)).toBeDefined()
    expect((await select(/^Follow-through/u)).value).toBe('confirm')
    // One trait away from Balanced is a custom mix, which cannot be chosen directly.
    const preset = await select(/^Preset/u)
    expect(preset.value).toBe('custom')
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'Custom' }).disabled).toBe(true)
  })

  it('writes every level of a preset in one update with the read revision', async () => {
    const save = acceptingSave()
    render(<BehaviorSettings source={{ load: async () => initial, save }} />)

    fireEvent.change(await select(/^Preset/u), { target: { value: 'autopilot' } })

    const autopilot = BEHAVIOR_PRESETS.find(preset => preset.id === 'autopilot')
    await waitFor(() => { expect(save).toHaveBeenCalledWith({ ...autopilot?.levels }, 4) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Saved. New sessions will use this preset.')).toBeDefined()
    expect((await select(/^Follow-through/u)).value).toBe('autonomous')
    expect((await select(/^Reporting/u)).value).toBe('brief')
  })

  it('shows a change at once and restores the previous level when the save is refused', async () => {
    let refuse: (error: Error) => void = () => undefined
    const save = vi.fn(async () => await new Promise<BehaviorSettingsView>((_resolve, reject) => { refuse = reject }))
    render(<BehaviorSettings source={{ load: async () => initial, save }} />)

    fireEvent.change(await select(/^Follow-through/u), { target: { value: 'autonomous' } })
    expect((await select(/^Follow-through/u)).value).toBe('autonomous')
    expect((await select(/^Follow-through/u)).disabled).toBe(true)

    refuse(new Error('Settings changed; reload and try again.'))
    expect(await screen.findByText('Settings changed; reload and try again.')).toBeDefined()
    expect((await select(/^Follow-through/u)).value).toBe('authorized')
  })

  it('edits the prompt text of the selected level and writes it as an override', async () => {
    const save = acceptingSave()
    render(<BehaviorSettings source={{ load: async () => initial, save }} />)
    await select(/^Errors/u)

    const toggles = screen.getAllByRole('button', { name: /Edit prompt text/u })
    expect(toggles).toHaveLength(6)
    fireEvent.click(toggles[1] as HTMLElement)
    expect(screen.getByText(behaviorTrait('errors').description)).toBeDefined()
    const editor = screen.getByLabelText<HTMLTextAreaElement>(/Errors prompt text/u)
    expect(editor.value).toBe(behaviorTrait('errors').levels.find(level => level.id === 'triage')?.text)
    expect(screen.getByText(/Sent to the model word for word at the start of new sessions/u)).toBeDefined()

    fireEvent.change(editor, { target: { value: '  Errors: stop and ask me.  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }))

    await waitFor(() => { expect(save).toHaveBeenCalledWith({ promptOverrides: { 'errors.triage': 'Errors: stop and ask me.' } }, 4) })
    expect(await screen.findByText('Saved. New sessions will use this text.')).toBeDefined()
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Errors prompt text/u).value).toBe('Errors: stop and ask me.')
    expect(screen.getByRole('button', { name: /Hide prompt text \(edited\)/u })).toBeDefined()
  })

  it('resets an edited level to its default text and keeps other overrides', async () => {
    const edited: BehaviorSettingsView = { ...initial, overrides: { 'errors.triage': 'Custom errors.', 'scope.strict': 'Custom scope.' } }
    const save = vi.fn(async (patch: BehaviorSettingsPatch, revision: number): Promise<BehaviorSettingsView> => ({ ...edited, overrides: patch.promptOverrides ?? edited.overrides, revision: revision + 1 }))
    render(<BehaviorSettings source={{ load: async () => edited, save }} />)

    // Errors and Scope have overrides for their selected levels.
    const toggles = await screen.findAllByRole('button', { name: /Edit prompt text \(edited\)/u })
    expect(toggles).toHaveLength(2)
    fireEvent.click(toggles[0] as HTMLElement)
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Errors prompt text/u).value).toBe('Custom errors.')
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    // The Host merges patches, so the cleared key is written as an empty string rather than dropped.
    await waitFor(() => { expect(save).toHaveBeenCalledWith({ promptOverrides: { 'errors.triage': '', 'scope.strict': 'Custom scope.' } }, 4) })
    expect(await screen.findByText('Restored the default text for new sessions.')).toBeDefined()
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Errors prompt text/u).value).toBe(behaviorTrait('errors').levels.find(level => level.id === 'triage')?.text)
  })

  it('treats saving empty text as a reset to the default', async () => {
    const edited: BehaviorSettingsView = { ...initial, overrides: { 'reporting.standard': 'Say little.' } }
    const save = vi.fn(async (patch: BehaviorSettingsPatch, revision: number): Promise<BehaviorSettingsView> => ({ ...edited, overrides: patch.promptOverrides ?? {}, revision: revision + 1 }))
    render(<BehaviorSettings source={{ load: async () => edited, save }} />)

    fireEvent.click((await screen.findAllByRole('button', { name: /Edit prompt text/u }))[5] as HTMLElement)
    fireEvent.change(screen.getByLabelText(/Reporting prompt text/u), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save text' }))

    await waitFor(() => { expect(save).toHaveBeenCalledWith({ promptOverrides: { 'reporting.standard': '' } }, 4) })
  })

  it('disables the controls when the profile is read-only', async () => {
    render(<BehaviorSettings source={{ load: async () => ({ ...initial, writable: false }), save: vi.fn() }} />)
    expect((await select(/^Follow-through/u)).disabled).toBe(true)
    expect((await select(/^Preset/u)).disabled).toBe(true)
    expect(screen.getByText('This profile does not accept setting changes.')).toBeDefined()
  })

  it('offers a retry when the settings cannot be loaded', async () => {
    const load = vi.fn<() => Promise<BehaviorSettingsView>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(initial)
    render(<BehaviorSettings source={{ load, save: vi.fn() }} />)

    expect(await screen.findByText('offline')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /retry/iu }))
    expect(await select(/^Follow-through/u)).toBeDefined()
  })
})

describe('settings Remote source', () => {
  const described = (value: unknown, revision = 7, writable = true) => ({ ok: true, value: { writable, hasDocument: false, namespaces: [
    { ns: 'llm-deepseek', value: {}, revision: 1 },
    { ns: BEHAVIOR_SETTINGS_NAMESPACE, value, revision },
  ] } })

  it('reads the levels and prompt overrides of the runtime namespace', async () => {
    const value = { followThrough: 'confirm', errors: 'resolve', verification: 'always', checking: 'lean', scope: 'improve', reporting: 'brief', promptOverrides: { 'errors.resolve': 'Fix it.' } }
    const source = createBehaviorSettingsSource({ describe: async () => described(value), update: vi.fn() })
    await expect(source.load()).resolves.toEqual({
      levels: { followThrough: 'confirm', errors: 'resolve', verification: 'always', checking: 'lean', scope: 'improve', reporting: 'brief' },
      overrides: { 'errors.resolve': 'Fix it.' },
      revision: 7,
      writable: true,
    })
  })

  it('falls back to defaults for unknown levels and malformed overrides', async () => {
    const source = createBehaviorSettingsSource({ describe: async () => described({ followThrough: 'reckless', errors: 3, promptOverrides: { 'errors.triage': 5 } }), update: vi.fn() })
    await expect(source.load()).resolves.toEqual({ levels: DEFAULT_BEHAVIOR_LEVELS, overrides: {}, revision: 7, writable: true })

    const listed = createBehaviorSettingsSource({ describe: async () => described({ promptOverrides: ['text'] }), update: vi.fn() })
    await expect(listed.load()).resolves.toMatchObject({ overrides: {} })
  })

  it('writes the patch as namespace keys with the expected revision', async () => {
    const update = vi.fn(async () => ({ ok: true, value: { ns: BEHAVIOR_SETTINGS_NAMESPACE, value: { followThrough: 'autonomous', promptOverrides: { 'scope.strict': 'Only this.' } }, revision: 8 } }))
    const source = createBehaviorSettingsSource({ describe: vi.fn(), update })
    await expect(source.save({ followThrough: 'autonomous', promptOverrides: { 'scope.strict': 'Only this.' } }, 7)).resolves.toEqual({
      levels: { ...DEFAULT_BEHAVIOR_LEVELS, followThrough: 'autonomous' },
      overrides: { 'scope.strict': 'Only this.' },
      revision: 8,
      writable: true,
    })
    expect(update).toHaveBeenCalledWith(BEHAVIOR_SETTINGS_NAMESPACE, { followThrough: 'autonomous', promptOverrides: { 'scope.strict': 'Only this.' } }, 7)
  })

  it('surfaces a stale-write refusal and a missing runtime', async () => {
    const stale = createBehaviorSettingsSource({ describe: vi.fn(), update: async () => ({ ok: false, error: { message: 'settings/conflict' } }) })
    await expect(stale.save({ followThrough: 'confirm' }, 1)).rejects.toThrow('settings/conflict')

    const missing = createBehaviorSettingsSource({ describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }), update: vi.fn() })
    await expect(missing.load()).rejects.toThrow(/not enabled/u)
  })

  it('reports a read-only profile', async () => {
    const source = createBehaviorSettingsSource({ describe: async () => described({ followThrough: 'authorized' }, 2, false), update: vi.fn() })
    await expect(source.load()).resolves.toMatchObject({ writable: false })
  })
})
