import { describe, expect, it } from 'vitest'
import {
  EMPTY_SETUP_MACHINE_CARD_DRAFT,
  SETUP_MACHINE_CHAT_ENVELOPE_CLOSE,
  SETUP_MACHINE_CHAT_ENVELOPE_OPEN,
  buildSetupMachineCardValues,
  formatSetupMachineChatSubmission,
  isSetupMachineCardReady,
  parseSetupMachineCardInput,
  parseSetupMachineChatSubmission,
} from '../src/machine-setup-draft.ts'
import type { SetupMachineCardDraft } from '../src/machine-setup-types.ts'

const readyDraft: SetupMachineCardDraft = {
  ...EMPTY_SETUP_MACHINE_CARD_DRAFT,
  sshTarget: 'alice@login.cluster.example.edu',
  authentication: { kind: 'requires-2fa' },
  scheduler: 'slurm',
}

describe('Setup Machine Chat submission contract', () => {
  it('gates Connect only on target, authentication, branch key path, and scheduler', () => {
    expect(isSetupMachineCardReady(readyDraft)).toBe(true)
    expect(isSetupMachineCardReady({ ...readyDraft, machineAlias: '', homePath: '', workPath: '', scratchPath: '', customNotes: '' })).toBe(true)
    expect(isSetupMachineCardReady({ ...readyDraft, sshTarget: '  ' })).toBe(false)
    expect(isSetupMachineCardReady({ ...readyDraft, authentication: { kind: 'unselected' } })).toBe(false)
    expect(isSetupMachineCardReady({ ...readyDraft, scheduler: '' })).toBe(false)
    expect(isSetupMachineCardReady({ ...readyDraft, authentication: { kind: 'passwordless-key', keyPath: '  ' } })).toBe(false)
    expect(isSetupMachineCardReady({ ...readyDraft, authentication: { kind: 'passwordless-key', keyPath: '~/.ssh/id_ed25519' } })).toBe(true)
    expect(buildSetupMachineCardValues(readyDraft)).not.toHaveProperty('machineAlias')
  })

  it('normalizes authorized values without adding excluded fields', () => {
    const values = buildSetupMachineCardValues({
      ...readyDraft,
      machineAlias: ' Nova ',
      homePath: ' /home/alice ',
      customNotes: ' Account mat123, queue debug. ',
      deepDiscovery: true,
    })
    expect(values).toEqual({
      machineAlias: 'Nova',
      sshTarget: 'alice@login.cluster.example.edu',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: { home: '/home/alice' },
      customNotes: 'Account mat123, queue debug.',
      deepDiscovery: true,
    })
    expect(values).not.toHaveProperty('vpn')
    expect(values).not.toHaveProperty('account')
    expect(values).not.toHaveProperty('queue')
  })

  it('round-trips one tagged current-Chat message without emitting raw markup from notes', () => {
    const values = buildSetupMachineCardValues({
      ...readyDraft,
      authentication: { kind: 'passwordless-key', keyPath: '~/.ssh/id_nova' },
      customNotes: 'Do not persist <one-time codes>.',
    })
    if (values === undefined) throw new Error('Ready card did not build submitted values.')
    const message = formatSetupMachineChatSubmission(values)
    expect(message.startsWith(SETUP_MACHINE_CHAT_ENVELOPE_OPEN)).toBe(true)
    expect(message.endsWith(SETUP_MACHINE_CHAT_ENVELOPE_CLOSE)).toBe(true)
    expect(message).toContain('"action":"connect-in-current-chat"')
    expect(message).toContain('"continuation":"call-slop-machine-connect"')
    expect(message).toContain('"workflow":"Call slop_machine_connect')
    expect(message).not.toContain('<one-time codes>')
    expect(parseSetupMachineCardInput(message)).toEqual({ kind: 'submitted', values })
    expect(parseSetupMachineChatSubmission(message)).toEqual(values)
    expect(parseSetupMachineChatSubmission(JSON.stringify({ schemaVersion: 1, kind: 'machine-setup', ...values }))).toBeUndefined()
    expect(parseSetupMachineChatSubmission(`${message}\nextra text`)).toBeUndefined()
  })

  it('parses exact Agent prefill but leaves the card unsubmitted', () => {
    expect(parseSetupMachineCardInput({
      machineAlias: 'Nova',
      sshTarget: 'nova-login',
      authentication: 'requires-2fa',
      scheduler: 'unknown',
      workPath: '/work/alice',
      deepDiscovery: true,
    })).toEqual({
      kind: 'draft',
      draft: {
        machineAlias: 'Nova',
        sshTarget: 'nova-login',
        authentication: { kind: 'requires-2fa' },
        scheduler: 'unknown',
        homePath: '',
        workPath: '/work/alice',
        scratchPath: '',
        customNotes: '',
        deepDiscovery: true,
      },
    })
  })
})
