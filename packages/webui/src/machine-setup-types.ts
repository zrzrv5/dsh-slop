export type SetupMachineScheduler = 'slurm' | 'pbs' | 'none' | 'unknown'

export type SetupMachineAuthenticationDraft =
  | { kind: 'unselected' }
  | { kind: 'requires-2fa' }
  | { kind: 'passwordless-key'; keyPath: string }

export type SetupMachineAuthentication = Exclude<SetupMachineAuthenticationDraft, { kind: 'unselected' }>

/** Editable values owned by one Setup Machine card before Connect. */
export interface SetupMachineCardDraft {
  machineAlias: string
  sshTarget: string
  authentication: SetupMachineAuthenticationDraft
  scheduler: SetupMachineScheduler | ''
  homePath: string
  workPath: string
  scratchPath: string
  customNotes: string
  deepDiscovery: boolean
}

/** Values authorized by the user when they select Connect. */
export interface SetupMachineCardValues {
  machineAlias?: string
  sshTarget: string
  authentication: SetupMachineAuthentication
  scheduler: SetupMachineScheduler
  paths: {
    home?: string
    work?: string
    scratch?: string
  }
  customNotes?: string
  deepDiscovery: boolean
}

/** Tagged text envelope submitted through the current Chat composer. */
export interface SetupMachineChatSubmission extends SetupMachineCardValues {
  setupCallId?: string
  schemaVersion: 1
  kind: 'machine-setup'
  action: 'connect-in-current-chat'
  continuation: 'call-slop-machine-connect'
  workflow: string
}

export type SetupMachineCardInput =
  | { kind: 'draft'; draft: SetupMachineCardDraft }
  | { kind: 'submitted'; values: SetupMachineCardValues }
