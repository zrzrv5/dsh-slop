import type {
  SetupMachineAuthentication,
  SetupMachineAuthenticationDraft,
  SetupMachineCardDraft,
  SetupMachineCardInput,
  SetupMachineCardValues,
  SetupMachineChatSubmission,
  SetupMachineScheduler,
} from './machine-setup-types.ts'

export const SETUP_MACHINE_CHAT_ENVELOPE_OPEN = '<dsh-slop-machine-setup>'
export const SETUP_MACHINE_CHAT_ENVELOPE_CLOSE = '</dsh-slop-machine-setup>'

export const EMPTY_SETUP_MACHINE_CARD_DRAFT: Readonly<SetupMachineCardDraft> = {
  machineAlias: '',
  sshTarget: '',
  authentication: { kind: 'unselected' },
  scheduler: '',
  homePath: '',
  workPath: '',
  scratchPath: '',
  customNotes: '',
  deepDiscovery: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function decodedSetupMachineInput(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.startsWith(SETUP_MACHINE_CHAT_ENVELOPE_OPEN) && trimmed.endsWith(SETUP_MACHINE_CHAT_ENVELOPE_CLOSE)) {
    const encoded = trimmed.slice(SETUP_MACHINE_CHAT_ENVELOPE_OPEN.length, -SETUP_MACHINE_CHAT_ENVELOPE_CLOSE.length)
    try { return JSON.parse(encoded) as unknown } catch { return trimmed }
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed) as unknown } catch { return trimmed }
  }
  return trimmed
}

function decodedTaggedSetupMachineSubmission(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith(SETUP_MACHINE_CHAT_ENVELOPE_OPEN) || !trimmed.endsWith(SETUP_MACHINE_CHAT_ENVELOPE_CLOSE)) return undefined
  const encoded = trimmed.slice(SETUP_MACHINE_CHAT_ENVELOPE_OPEN.length, -SETUP_MACHINE_CHAT_ENVELOPE_CLOSE.length)
  try {
    const decoded: unknown = JSON.parse(encoded)
    return decoded
  } catch { return undefined }
}

function scheduler(value: unknown): SetupMachineScheduler | '' {
  return value === 'slurm' || value === 'pbs' || value === 'none' || value === 'unknown' ? value : ''
}

function authentication(value: unknown, keyPath: unknown): SetupMachineAuthenticationDraft {
  if (value === 'requires-2fa') return { kind: 'requires-2fa' }
  if (value === 'passwordless-key') return { kind: 'passwordless-key', keyPath: stringValue(keyPath) }
  if (!isRecord(value)) return { kind: 'unselected' }
  if (value.kind === 'requires-2fa') return { kind: 'requires-2fa' }
  if (value.kind === 'passwordless-key') return { kind: 'passwordless-key', keyPath: stringValue(value.keyPath) }
  return { kind: 'unselected' }
}

function draftFromRecord(value: Record<string, unknown>): SetupMachineCardDraft {
  const paths = isRecord(value.paths) ? value.paths : {}
  return {
    machineAlias: stringValue(value.machineAlias),
    sshTarget: stringValue(value.sshTarget),
    authentication: authentication(value.authentication, value.keyPath),
    scheduler: scheduler(value.scheduler),
    homePath: stringValue(paths.home) || stringValue(value.homePath),
    workPath: stringValue(paths.work) || stringValue(value.workPath),
    scratchPath: stringValue(paths.scratch) || stringValue(value.scratchPath),
    customNotes: stringValue(value.customNotes),
    deepDiscovery: value.deepDiscovery === true,
  }
}

export function isSetupMachineCardReady(draft: SetupMachineCardDraft): boolean {
  if (draft.sshTarget.trim().length === 0 || draft.scheduler === '' || draft.authentication.kind === 'unselected') return false
  return draft.authentication.kind !== 'passwordless-key' || draft.authentication.keyPath.trim().length > 0
}

export function buildSetupMachineCardValues(draft: SetupMachineCardDraft): SetupMachineCardValues | undefined {
  if (!isSetupMachineCardReady(draft) || draft.scheduler === '' || draft.authentication.kind === 'unselected') return undefined
  const home = draft.homePath.trim()
  const work = draft.workPath.trim()
  const scratch = draft.scratchPath.trim()
  const customNotes = draft.customNotes.trim()
  const machineAlias = draft.machineAlias.trim()
  const authorizedAuthentication: SetupMachineAuthentication = draft.authentication.kind === 'requires-2fa'
    ? { kind: 'requires-2fa' }
    : { kind: 'passwordless-key', keyPath: draft.authentication.keyPath.trim() }
  return {
    ...(machineAlias.length === 0 ? {} : { machineAlias }),
    sshTarget: draft.sshTarget.trim(),
    authentication: authorizedAuthentication,
    scheduler: draft.scheduler,
    paths: {
      ...(home.length === 0 ? {} : { home }),
      ...(work.length === 0 ? {} : { work }),
      ...(scratch.length === 0 ? {} : { scratch }),
    },
    ...(customNotes.length === 0 ? {} : { customNotes }),
    deepDiscovery: draft.deepDiscovery,
  }
}

/** Parse exact Agent prefill or a previously submitted tagged Chat envelope. */
export function parseSetupMachineCardInput(value: unknown): SetupMachineCardInput {
  const decoded = decodedSetupMachineInput(value)
  if (typeof decoded === 'string') {
    return { kind: 'draft', draft: { ...EMPTY_SETUP_MACHINE_CARD_DRAFT, machineAlias: decoded } }
  }
  if (!isRecord(decoded)) return { kind: 'draft', draft: { ...EMPTY_SETUP_MACHINE_CARD_DRAFT } }
  const draft = draftFromRecord(decoded)
  if (decoded.schemaVersion === 1 && decoded.kind === 'machine-setup') {
    const values = buildSetupMachineCardValues(draft)
    if (values !== undefined) return { kind: 'submitted', values }
  }
  return { kind: 'draft', draft }
}

/** Decode only the exact tagged, complete, non-secret Chat submission. */
export function parseSetupMachineChatSubmission(value: unknown): SetupMachineCardValues | undefined {
  const decoded = decodedTaggedSetupMachineSubmission(value)
  if (!isRecord(decoded) || decoded.schemaVersion !== 1 || decoded.kind !== 'machine-setup') return undefined
  return buildSetupMachineCardValues(draftFromRecord(decoded))
}

export function setupMachineSubmissionCallId(value: unknown): string | undefined {
  const decoded = decodedTaggedSetupMachineSubmission(value)
  if (!isRecord(decoded) || parseSetupMachineChatSubmission(value) === undefined) return undefined
  return typeof decoded.setupCallId === 'string' && decoded.setupCallId.length > 0 && decoded.setupCallId.length <= 512 ? decoded.setupCallId : undefined
}

export function formatSetupMachineChatSubmission(values: SetupMachineCardValues, setupCallId?: string): string {
  const submission: SetupMachineChatSubmission = {
    schemaVersion: 1,
    ...(setupCallId === undefined ? {} : { setupCallId }),
    kind: 'machine-setup',
    action: 'connect-in-current-chat',
    continuation: 'call-slop-machine-connect',
    workflow: values.deepDiscovery
      ? 'Call slop_machine_connect with sshTarget, authentication, scheduler, paths, and machineAlias only when present in this submission. Then immediately call slop_machine_connect again with only the returned machineId. After access is confirmed ready, use the deep-discover skill (the /deep-discover workflow) for this Machine, with customNotes as scope context.'
      : 'Call slop_machine_connect with sshTarget, authentication, scheduler, paths, and machineAlias only when present in this submission. Then immediately call slop_machine_connect again with only the returned machineId. Continue ordinary Chat after access is ready.',
    ...values,
  }
  return `${SETUP_MACHINE_CHAT_ENVELOPE_OPEN}${JSON.stringify(submission).replaceAll('<', '\\u003c')}${SETUP_MACHINE_CHAT_ENVELOPE_CLOSE}`
}
