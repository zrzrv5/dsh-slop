import {
  type AccessChallenge,
  type AuthAttachmentLease,
  type AuthCarrierObservation,
  type AuthFlow,
  type AuthPromptObservation,
  type ConnectionObservation,
  type PendingConnectionWaiter,
} from './domain/access.ts'
import type { Machine } from './domain/inventory.ts'
import {
  machineConnectionPresentationSchema,
  type MachineConnectionPresentation,
} from './domain/presentation.ts'
import type { Instant, Revision, Sha256 } from './primitives.ts'

export interface AccessPresentationAuthState {
  readonly flow?: AuthFlow
  readonly carrier?: AuthCarrierObservation
  readonly prompt?: AuthPromptObservation
  readonly attachmentLeases?: readonly AuthAttachmentLease[]
}

interface PresentationIdentity {
  readonly machine: Machine
  readonly connectionIdentityDigest: Sha256
  readonly revision: Revision
  readonly updatedAt: Instant
}

interface BlockedPresentationInput extends PresentationIdentity, AccessPresentationAuthState {
  readonly challenge: AccessChallenge
  readonly waiters: readonly PendingConnectionWaiter[]
}

interface ReadyPresentationInput extends PresentationIdentity {
  readonly observation: ConnectionObservation & { readonly state: 'ready' }
}

interface DisconnectedPresentationInput extends PresentationIdentity {
  readonly reason: string
  readonly retryable: boolean
}

export function machineConnectionPresentationId(machine: Machine, connectionIdentityDigest: Sha256): string {
  return `${machine.id}:${connectionIdentityDigest}`
}

function effectiveFlowState(flow: AuthFlow | undefined, updatedAt: Instant): 'not-started' | AuthFlow['state'] {
  if (flow === undefined) return 'not-started'
  if (Date.parse(flow.expiresAt) <= Date.parse(updatedAt) && !['ready', 'failed', 'expired', 'cancelled'].includes(flow.state)) {
    return 'expired'
  }
  return flow.state
}

function authenticationDetails(
  auth: AccessPresentationAuthState,
  updatedAt: Instant,
): {
  readonly flowId?: AuthFlow['id']
  readonly flowState: 'not-started' | AuthFlow['state']
  readonly carrierState: 'not-started' | AuthCarrierObservation['state']
  readonly promptState: AuthPromptObservation['state']
  readonly writableAttachment: boolean
} {
  const flow = auth.flow
  const flowState = effectiveFlowState(flow, updatedAt)
  const writableAttachment = flow !== undefined
    && flowState !== 'expired'
    && (auth.attachmentLeases ?? []).some(lease =>
      lease.authFlowId === flow.id && lease.state === 'active' && Date.parse(lease.expiresAt) > Date.parse(updatedAt))
  return {
    ...(flow === undefined ? {} : { flowId: flow.id }),
    flowState,
    carrierState: auth.carrier?.state ?? 'not-started',
    promptState: auth.prompt?.state ?? 'not-observed',
    writableAttachment,
  }
}

function blockedActions(
  challenge: AccessChallenge,
  auth: AccessPresentationAuthState,
  updatedAt: Instant,
): MachineConnectionPresentation['actions'] {
  switch (challenge.requirement.kind) {
    case 'host-trust': return ['inspect-trust', 'trust-fingerprint', 'cancel-session-wait']
    case 'authentication': {
      const flowState = effectiveFlowState(auth.flow, updatedAt)
      if (flowState === 'not-started') return ['start-authentication', 'cancel-session-wait']
      if (flowState === 'failed' || flowState === 'expired' || flowState === 'cancelled') {
        return ['start-new-flow', 'cancel-session-wait']
      }
      const details = authenticationDetails(auth, updatedAt)
      if (!details.writableAttachment && (flowState === 'created' || flowState === 'waiting-attachment')) {
        return ['retry-carrier', 'cancel-session-wait']
      }
      if (auth.carrier?.state === 'detached' || auth.carrier?.state === 'rejected' || auth.carrier?.state === 'unavailable') {
        return ['retry-carrier', 'cancel-session-wait']
      }
      return ['cancel-session-wait']
    }
    case 'reconnect': return ['open-machine-settings', 'cancel-session-wait']
    default: {
      const exhaustive: never = challenge.requirement
      return exhaustive
    }
  }
}

function blockedReason(challenge: AccessChallenge): string {
  switch (challenge.requirement.kind) {
    case 'host-trust': return 'Host fingerprint review is required.'
    case 'authentication': return 'Authentication is required.'
    case 'reconnect': return challenge.requirement.reason
    default: {
      const exhaustive: never = challenge.requirement
      return exhaustive
    }
  }
}

function challengeDetails(
  challenge: AccessChallenge,
  auth: AccessPresentationAuthState,
  updatedAt: Instant,
): MachineConnectionPresentation['connection'] & { readonly state: 'blocked' } {
  const requirement = challenge.requirement
  const base = {
    state: 'blocked' as const,
    challengeId: challenge.id,
    challengeRevision: challenge.revision,
    reason: blockedReason(challenge),
    expiresAt: challenge.expiresAt,
  }
  switch (requirement.kind) {
    case 'host-trust': return {
      ...base,
      challenge: {
        kind: 'host-trust',
        host: requirement.host,
        algorithm: requirement.algorithm,
        fingerprint: requirement.fingerprint,
        change: requirement.change,
      },
    }
    case 'authentication': return {
      ...base,
      challenge: { kind: 'authentication', authentication: authenticationDetails(auth, updatedAt) },
    }
    case 'reconnect': return { ...base, challenge: { kind: 'reconnect', reason: requirement.reason } }
    default: {
      const exhaustive: never = requirement
      return exhaustive
    }
  }
}

export function buildBlockedMachineConnectionPresentation(input: BlockedPresentationInput): MachineConnectionPresentation {
  const now = Date.parse(input.updatedAt)
  const waitingSessionCount = new Set(input.waiters
    .filter(waiter => Date.parse(waiter.expiresAt) > now)
    .map(waiter => waiter.sessionId)).size
  return machineConnectionPresentationSchema.parse({
    schemaVersion: 1,
    id: machineConnectionPresentationId(input.machine, input.connectionIdentityDigest),
    ownerPrincipalId: input.machine.ownerPrincipalId,
    machineId: input.machine.id,
    machineLabel: input.machine.name,
    connectionIdentityDigest: input.connectionIdentityDigest,
    freshness: 'current',
    connection: challengeDetails(input.challenge, input, input.updatedAt),
    waitingSessionCount,
    actions: blockedActions(input.challenge, input, input.updatedAt),
    revision: input.revision,
    updatedAt: input.updatedAt,
  })
}

export function buildReadyMachineConnectionPresentation(input: ReadyPresentationInput): MachineConnectionPresentation {
  return machineConnectionPresentationSchema.parse({
    schemaVersion: 1,
    id: machineConnectionPresentationId(input.machine, input.connectionIdentityDigest),
    ownerPrincipalId: input.machine.ownerPrincipalId,
    machineId: input.machine.id,
    machineLabel: input.machine.name,
    connectionIdentityDigest: input.connectionIdentityDigest,
    freshness: 'current',
    connection: {
      state: 'ready',
      observedAt: input.observation.observedAt,
      expiresAt: input.observation.expiresAt,
    },
    waitingSessionCount: 0,
    actions: [],
    revision: input.revision,
    updatedAt: input.updatedAt,
  })
}

export function buildDisconnectedMachineConnectionPresentation(input: DisconnectedPresentationInput): MachineConnectionPresentation {
  return machineConnectionPresentationSchema.parse({
    schemaVersion: 1,
    id: machineConnectionPresentationId(input.machine, input.connectionIdentityDigest),
    ownerPrincipalId: input.machine.ownerPrincipalId,
    machineId: input.machine.id,
    machineLabel: input.machine.name,
    connectionIdentityDigest: input.connectionIdentityDigest,
    freshness: 'current',
    connection: { state: 'disconnected', reason: input.reason, retryable: input.retryable },
    waitingSessionCount: 0,
    actions: input.retryable ? ['open-machine-settings'] : [],
    revision: input.revision,
    updatedAt: input.updatedAt,
  })
}
