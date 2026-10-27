import { ChatCard } from './ChatCard.tsx'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react'
import {
  buildSetupMachineCardValues,
  formatSetupMachineChatSubmission,
  parseSetupMachineCardInput,
} from './machine-setup-draft.ts'
import type {
  SetupMachineAuthenticationDraft,
  SetupMachineCardDraft,
  SetupMachineCardInput,
  SetupMachineCardValues,
  SetupMachineScheduler,
} from './machine-setup-types.ts'
import { Button, Checkbox, Notice, SelectInput, Disclosure, TextArea, TextInput } from './ui.tsx'

function schedulerFromInput(value: string): SetupMachineScheduler | '' {
  if (value === 'slurm' || value === 'pbs' || value === 'none' || value === 'unknown') return value
  return ''
}

function authenticationFromInput(value: string): SetupMachineAuthenticationDraft {
  if (value === 'requires-2fa') return { kind: 'requires-2fa' }
  if (value === 'passwordless-key') return { kind: 'passwordless-key', keyPath: '' }
  return { kind: 'unselected' }
}

function authenticationInputValue(authentication: SetupMachineAuthenticationDraft): string {
  return authentication.kind === 'unselected' ? '' : authentication.kind
}

function authenticationLabel(values: SetupMachineCardValues): string {
  return values.authentication.kind === 'requires-2fa' ? 'Password or 2FA' : 'SSH key'
}

function schedulerLabel(scheduler: SetupMachineScheduler): string {
  switch (scheduler) {
    case 'slurm': return 'Slurm'
    case 'pbs': return 'PBS'
    case 'none': return 'None'
    case 'unknown': return 'Unknown'
    default: {
      const exhaustive: never = scheduler
      return exhaustive
    }
  }
}

export interface SetupMachineSubmissionCardProps {
  readonly cardId: string
  readonly values: SetupMachineCardValues
}

export interface SetupMachineSubmissionMarkerProps {
  readonly messageId: string
}

/**
 * Browser-only marker for the tagged user message emitted by Connect. The
 * marker lets CSS suppress the protocol envelope while the original Setup
 * card remains the sole visible card in the Chat.
 */
export function SetupMachineSubmissionMarker({ messageId }: SetupMachineSubmissionMarkerProps): ReactNode {
  return <span
    aria-hidden="true"
    className="slop-setup-submission-marker"
    data-setup-machine-message-id={messageId}
  />
}

/** Compact transcript projection for a Setup Machine message already submitted to this Chat. */
export function SetupMachineSubmissionCard({ cardId, values }: SetupMachineSubmissionCardProps): ReactNode {
  return <div className="slop-setup-thread" data-command-id={cardId} data-setup-machine-submission="">
    <ChatCard className="slop-setup-card slop-setup-card-compact" aria-label="Submitted Machine setup">
      <div className="slop-machine-summary"><strong>{values.machineAlias ?? values.sshTarget}</strong><span>Connection requested</span><code>{values.sshTarget}</code></div>
      <Disclosure title="Connection details">
        <dl className="slop-setup-summary">
          <div><dt>Authentication</dt><dd>{authenticationLabel(values)}</dd></div>
          {values.authentication.kind === 'passwordless-key' ? <div><dt>Local key file path</dt><dd>{values.authentication.keyPath}</dd></div> : null}
          <div><dt>Scheduler</dt><dd>{schedulerLabel(values.scheduler)}</dd></div>
          {Object.entries(values.paths).map(([role, path]) => <div key={role}><dt>{role}</dt><dd>{path}</dd></div>)}
        </dl>
        {values.customNotes ? <p>{values.customNotes}</p> : null}
      </Disclosure>
    </ChatCard>
  </div>
}

function updateDraft(
  setCard: Dispatch<SetStateAction<SetupMachineCardInput>>,
  change: (draft: SetupMachineCardDraft) => SetupMachineCardDraft,
): void {
  setCard(current => current.kind === 'draft' ? { kind: 'draft', draft: change(current.draft) } : current)
}

export interface SetupMachineCardProps {
  cardId: string
  input: unknown
  useInput: CommandRowProps['useInput']
  inputActions: CommandRowProps['inputActions']
  commandError?: string
}

/** Interactive Setup Machine card shared by user and Agent invocation. Connect
 * submits one ordinary user message to this Chat. */
export function SetupMachineCard({ cardId, input, useInput, inputActions, commandError }: SetupMachineCardProps): ReactNode {
  const [card, setCard] = useState<SetupMachineCardInput>(() => parseSetupMachineCardInput(input))
  useEffect(() => {
    const restored = parseSetupMachineCardInput(input)
    if (restored.kind === 'submitted') setCard(restored)
  }, [input])
  const [submitError, setSubmitError] = useState<string>()
  const composerDraft = useInput((input: InputState) => input.draft)
  const composerPhase = useInput((input: InputState) => input.phase)
  const composerAttachmentCount = useInput((input: InputState) => input.attachmentIds.length)

  if (card.kind === 'submitted') return <SetupMachineSubmissionCard cardId={cardId} values={card.values} />

  const values = buildSetupMachineCardValues(card.draft)
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (values === undefined) return
    if (composerPhase !== 'plain') {
      setSubmitError('Chat is submitting another message. Try Connect again when it finishes.')
      return
    }
    if (composerDraft.length > 0 || composerAttachmentCount > 0) {
      setSubmitError('Send or clear the message already in the Chat composer before connecting.')
      return
    }
    setSubmitError(undefined)
    inputActions.setDraft(formatSetupMachineChatSubmission(values, cardId))
    inputActions.submit()
    setCard({ kind: 'submitted', values })
  }

  return <div className="slop-setup-thread" data-command-id={cardId} data-setup-machine-entry="">
    <ChatCard className="slop-setup-card" aria-label="Setup Machine">
      <header className="slop-setup-card-header">
        <h3>Connect a machine</h3>
      </header>
      {commandError === undefined ? null : <Notice tone="danger">The setup command failed: {commandError}</Notice>}
      {submitError === undefined ? null : <Notice tone="warning">{submitError}</Notice>}
      <form className="slop-setup-form" onSubmit={submit}>
        <div className="slop-setup-form-grid">
          <TextInput
            label="Machine alias"
            aria-label="Machine alias"
            autoComplete="off"
            placeholder="Research cluster"
            value={card.draft.machineAlias}
            hint="Optional. This name does not change the SSH target."
            onChange={event => { updateDraft(setCard, draft => ({ ...draft, machineAlias: event.target.value })) }}
          />
          <TextInput
            label="SSH target"
            aria-label="SSH target"
            autoComplete="off"
            placeholder="alice@login.cluster.example.edu"
            value={card.draft.sshTarget}
            hint="Enter user@host or a Host alias from ~/.ssh/config."
            required
            onChange={event => { updateDraft(setCard, draft => ({ ...draft, sshTarget: event.target.value })) }}
          />
          <SelectInput
            label="Authentication"
            aria-label="Authentication"
            value={authenticationInputValue(card.draft.authentication)}
            options={[
              { value: '', label: 'Choose authentication' },
              { value: 'requires-2fa', label: 'Password or 2FA' },
              { value: 'passwordless-key', label: 'SSH key' },
            ]}
            required
            onChange={event => { updateDraft(setCard, draft => ({ ...draft, authentication: authenticationFromInput(event.target.value) })) }}
          />
          <SelectInput
            label="Scheduler"
            aria-label="Scheduler"
            value={card.draft.scheduler}
            options={[
              { value: '', label: 'Choose scheduler' },
              { value: 'slurm', label: 'Slurm' },
              { value: 'pbs', label: 'PBS' },
              { value: 'none', label: 'None' },
              { value: 'unknown', label: 'Unknown' },
            ]}
            required
            onChange={event => { updateDraft(setCard, draft => ({ ...draft, scheduler: schedulerFromInput(event.target.value) })) }}
          />
          {card.draft.authentication.kind !== 'passwordless-key' ? null : <div className="slop-setup-field-wide"><TextInput
            label="Local key file path"
            aria-label="Local key file path"
            autoComplete="off"
            placeholder="~/.ssh/id_ed25519"
            value={card.draft.authentication.keyPath}
            required
            onChange={event => { updateDraft(setCard, draft => draft.authentication.kind === 'passwordless-key'
              ? { ...draft, authentication: { kind: 'passwordless-key', keyPath: event.target.value } }
              : draft) }}
          /></div>}
        </div>
        <Disclosure title="Paths and discovery">
          <div className="slop-setup-form-grid">
          <TextInput label="Home path" aria-label="Home path" autoComplete="off" placeholder="/home/alice" value={card.draft.homePath} onChange={event => { updateDraft(setCard, draft => ({ ...draft, homePath: event.target.value })) }} />
          <TextInput label="Work path" aria-label="Work path" autoComplete="off" placeholder="/work/alice" value={card.draft.workPath} onChange={event => { updateDraft(setCard, draft => ({ ...draft, workPath: event.target.value })) }} />
          <TextInput label="Scratch path" aria-label="Scratch path" autoComplete="off" placeholder="/scratch/alice" value={card.draft.scratchPath} onChange={event => { updateDraft(setCard, draft => ({ ...draft, scratchPath: event.target.value })) }} />
          <div className="slop-setup-field-wide"><TextArea
            label="Custom notes"
            aria-label="Custom notes"
            rows={4}
            placeholder="Accounts, allocations, queues, or anything else the Agent should know"
            value={card.draft.customNotes}
            onChange={event => { updateDraft(setCard, draft => ({ ...draft, customNotes: event.target.value })) }}
          /></div>
        </div>
        <Checkbox
          label="Deep Discovery"
          hint="Inspect selected projects after connecting and propose Machine Info."
          checked={card.draft.deepDiscovery}
          onChange={checked => { updateDraft(setCard, draft => ({ ...draft, deepDiscovery: checked })) }}
        />
        </Disclosure>
        <div className="slop-setup-actions"><Button type="submit" disabled={values === undefined}>Connect</Button></div>
      </form>
    </ChatCard>
  </div>
}
