// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SetupMachineCard, SetupMachineSubmissionCard, SetupMachineSubmissionMarker } from '../src/SetupConversationCard.tsx'
import { parseSetupMachineCardInput } from '../src/machine-setup-draft.ts'
import type { SetupMachineCardProps } from '../src/SetupConversationCard.tsx'

afterEach(() => { cleanup() })

interface ComposerStateOverride {
  draft?: string
  phase?: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

function inputElement(label: string): HTMLInputElement {
  const element = screen.getByLabelText(label)
  if (!(element instanceof HTMLInputElement)) throw new Error(`${label} is not an input.`)
  return element
}

function selectElement(label: string): HTMLSelectElement {
  const element = screen.getByLabelText(label)
  if (!(element instanceof HTMLSelectElement)) throw new Error(`${label} is not a select.`)
  return element
}

function buttonElement(label: string): HTMLButtonElement {
  const element = screen.getByRole('button', { name: label })
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${label} is not a button.`)
  return element
}

function renderCard(input: unknown = {}, composer: ComposerStateOverride = {}) {
  const setDraft = vi.fn()
  const submit = vi.fn()
  const inputActions: SetupMachineCardProps['inputActions'] = {
    setDraft,
    persistDraft: vi.fn(),
    submit,
    addAttachments: vi.fn(() => true),
    removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(),
    captureInsertion: vi.fn(),
    insertText: vi.fn(),
  }
  const useInput: SetupMachineCardProps['useInput'] = selector => selector({
    draft: composer.draft ?? '',
    attachmentIds: [],
    draftRev: 0,
    phase: composer.phase ?? 'plain',
    occurrences: [],
    queue: [],
  })
  const view = render(<SetupMachineCard
    cardId="setup-card-1"
    input={input}
    useInput={useInput}
    inputActions={inputActions}
  />)
  return { ...view, setDraft, submit }
}

function chooseRequiredFields(authentication: 'requires-2fa' | 'passwordless-key' = 'requires-2fa'): void {
  fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'alice@login.cluster.example.edu' } })
  fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: authentication } })
  fireEvent.change(screen.getByLabelText('Scheduler'), { target: { value: 'slurm' } })
}

describe('Setup Machine Chat card', () => {
  it('uses an invisible marker for the submitted protocol message', () => {
    const { container } = render(<SetupMachineSubmissionMarker messageId="message-setup-1" />)

    expect(container.querySelector('[data-setup-machine-message-id="message-setup-1"]')).not.toBeNull()
    expect(screen.queryByRole('article')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders a projected submission as compact read-only transcript content', () => {
    const { container } = render(<SetupMachineSubmissionCard
      cardId="message-setup-1"
      values={{
        machineAlias: 'Nova',
        sshTarget: 'alice@login.cluster.example.edu',
        authentication: { kind: 'requires-2fa' },
        scheduler: 'slurm',
        paths: { work: '/work/alice' },
        deepDiscovery: false,
      }}
    />)

    const record = screen.getByRole('article', { name: 'Submitted Machine setup' })
    expect(within(record).getByText('Nova')).toBeDefined()
    expect(within(record).getByText('alice@login.cluster.example.edu')).toBeDefined()
    expect(container.querySelector('[data-setup-machine-submission]')).not.toBeNull()
    expect(container.textContent).not.toContain('<dsh-slop-machine-setup>')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('starts inline with the accepted fields and no preselected choices', () => {
    const { container } = renderCard()

    expect(screen.getByRole('article', { name: 'Setup Machine' })).toBeDefined()
    expect(container.querySelector('[data-setup-machine-entry]')).not.toBeNull()
    expect(screen.getByLabelText('Machine alias')).toBeDefined()
    expect(screen.getByLabelText('SSH target')).toBeDefined()
    expect(screen.getByLabelText('Home path')).toBeDefined()
    expect(screen.getByLabelText('Work path')).toBeDefined()
    expect(screen.getByLabelText('Scratch path')).toBeDefined()
    expect(screen.getByLabelText('Custom notes')).toBeDefined()
    expect(selectElement('Authentication').value).toBe('')
    expect(selectElement('Scheduler').value).toBe('')
    fireEvent.click(screen.getByText('Paths and discovery'))
    const deepDiscovery = screen.getByRole('checkbox', { name: /Deep Discovery/ })
    if (!(deepDiscovery instanceof HTMLInputElement)) throw new Error('Deep Discovery is not a checkbox.')
    expect(deepDiscovery.checked).toBe(false)
    expect(buttonElement('Connect').disabled).toBe(true)
    expect(screen.queryByLabelText(/VPN/i)).toBeNull()
    expect(screen.queryByLabelText(/Account/i)).toBeNull()
    expect(screen.queryByLabelText(/Queue/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /cancel|close/i })).toBeNull()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('uses only the four accepted validation conditions', () => {
    renderCard()
    const connect = buttonElement('Connect')

    fireEvent.change(screen.getByLabelText('SSH target'), { target: { value: 'cluster-alias' } })
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'requires-2fa' } })
    expect(connect.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Scheduler'), { target: { value: 'unknown' } })
    expect(connect.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Home path'), { target: { value: 'relative path with spaces' } })
    fireEvent.change(screen.getByLabelText('Custom notes'), { target: { value: 'Account qan, queue debug.' } })
    expect(connect.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'passwordless-key' } })
    expect(screen.getByLabelText('Local key file path')).toBeDefined()
    expect(connect.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Local key file path'), { target: { value: '~/.ssh/id_ed25519' } })
    expect(connect.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'requires-2fa' } })
    expect(screen.queryByLabelText('Local key file path')).toBeNull()
    expect(connect.disabled).toBe(false)
  })

  it('shows Agent prefill without submitting it', () => {
    const { setDraft, submit } = renderCard({
      machineAlias: 'Nova',
      sshTarget: 'alice@login.cluster.example.edu',
      authentication: { kind: 'passwordless-key', keyPath: '~/.ssh/nova' },
      scheduler: 'pbs',
      paths: { home: '/home/alice', work: '/work/alice' },
      customNotes: 'Use allocation mat123.',
      deepDiscovery: true,
    })

    expect(inputElement('Machine alias').value).toBe('Nova')
    expect(inputElement('Local key file path').value).toBe('~/.ssh/nova')
    expect(selectElement('Scheduler').value).toBe('pbs')
    fireEvent.click(screen.getByText('Paths and discovery'))
    const deepDiscovery = screen.getByRole('checkbox', { name: /Deep Discovery/ })
    if (!(deepDiscovery instanceof HTMLInputElement)) throw new Error('Deep Discovery is not a checkbox.')
    expect(deepDiscovery.checked).toBe(true)
    expect(buttonElement('Connect').disabled).toBe(false)
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('submits one tagged structured message to the current Chat and becomes read-only', () => {
    const { setDraft, submit } = renderCard()
    chooseRequiredFields('passwordless-key')
    fireEvent.change(screen.getByLabelText('Machine alias'), { target: { value: ' Nova ' } })
    fireEvent.change(screen.getByLabelText('Local key file path'), { target: { value: ' ~/.ssh/id_nova ' } })
    fireEvent.change(screen.getByLabelText('Work path'), { target: { value: ' /work/alice ' } })
    fireEvent.change(screen.getByLabelText('Custom notes'), { target: { value: ' Use allocation mat123. ' } })
    fireEvent.click(screen.getByText('Paths and discovery'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Deep Discovery/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(setDraft).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
    const setDraftOrder = setDraft.mock.invocationCallOrder.at(0)
    const submitOrder = submit.mock.invocationCallOrder.at(0)
    if (setDraftOrder === undefined || submitOrder === undefined) throw new Error('Chat submission actions did not run.')
    expect(setDraftOrder).toBeLessThan(submitOrder)
    const message: unknown = setDraft.mock.calls[0]?.[0]
    const parsed = parseSetupMachineCardInput(message)
    expect(parsed).toEqual({
      kind: 'submitted',
      values: {
        machineAlias: 'Nova',
        sshTarget: 'alice@login.cluster.example.edu',
        authentication: { kind: 'passwordless-key', keyPath: '~/.ssh/id_nova' },
        scheduler: 'slurm',
        paths: { work: '/work/alice' },
        customNotes: 'Use allocation mat123.',
        deepDiscovery: true,
      },
    })

    const record = screen.getByRole('article', { name: 'Submitted Machine setup' })
    expect(within(record).getByText('Nova')).toBeDefined()
    expect(within(record).getByText('alice@login.cluster.example.edu')).toBeDefined()
    expect(within(record).getByText('~/.ssh/id_nova')).toBeDefined()
    expect(within(record).getByText('Use allocation mat123.')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(within(record).queryByText(/progress|connecting|run/i)).toBeNull()
  })

  it('does not overwrite another composer draft', () => {
    const { setDraft, submit } = renderCard({}, { draft: 'Keep this draft' })
    chooseRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(screen.getByText(/Send or clear the message/)).toBeDefined()
    expect(setDraft).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDefined()
  })
})
