import { z } from 'zod'
import {
  type AuthorityMutation,
  type AuthorityRecord,
  LOCAL_OWNER_PRINCIPAL_ID,
  type ProjectionMutation,
  type RelationalAuthority,
  resolveLocalOwnerPrincipal,
} from './authority.ts'
import { canonicalSha256, createUuidV7, type JsonValue } from './canonical.ts'
import {
  accessChallengeSchema,
  authAttachmentLeaseSchema,
  authCarrierObservationSchema,
  authFlowSchema,
  authPromptObservationSchema,
  connectionLeaseSchema,
  connectionObservationSchema,
  hostTrustDecisionSchema,
  pendingConnectionWaiterSchema,
  type AccessChallenge,
  type AuthAttachmentLease,
  type AuthFlow,
  type ConnectionLease,
  type ConnectionObservation,
  type PendingConnectionWaiter,
} from './domain/access.ts'
import {
  accessProfileSchema,
  machineSchema,
  type AccessProfile,
  type Machine,
} from './domain/inventory.ts'
import {
  machineConnectionPresentationSchema,
  type MachineConnectionPresentation,
} from './domain/presentation.ts'
import {
  type AccessPresentationAuthState,
  buildBlockedMachineConnectionPresentation,
  buildDisconnectedMachineConnectionPresentation,
  buildReadyMachineConnectionPresentation,
  machineConnectionPresentationId,
} from './access-coordinator-presentation.ts'
import {
  AccessConflictError,
  AccessNotFoundError,
  AccessOrderingError,
  AuthAttachmentConflictError,
  acquireAuthAttachmentRequestSchema,
  cancelConnectionWaiterRequestSchema,
  disconnectedConnectionObservationRequestSchema,
  observeAuthPromptRequestSchema,
  readyConnectionObservationRequestSchema,
  recordHostTrustDecisionRequestSchema,
  releaseAuthAttachmentRequestSchema,
  replaceConnectionRequirementRequestSchema,
  requireConnectionRequestSchema,
  resolveAccessChallengeRequestSchema,
  startAuthFlowRequestSchema,
  type AccessCoordinatorOptions,
  type AuthAttachmentResult,
  type AuthFlowResult,
  type AuthPromptResult,
  type HostTrustDecisionResult,
  type RequireConnectionRequest,
  type RequireConnectionResult,
  type ReplaceConnectionRequirementResult,
  type ResolveAccessChallengeResult,
} from './access-coordinator-contracts.ts'
import { jsonValueSchema } from './schemas.ts'
import {
  accessChallengeIdSchema,
  authAttachmentLeaseIdSchema,
  authFlowIdSchema,
  connectionLeaseIdSchema,
  connectionObservationIdSchema,
  connectionWaiterIdSchema,
  machineIdSchema,
  revisionSchema,
  toInstant,
  type Instant,
  type Revision,
  type Sha256,
} from './primitives.ts'

export * from './access-coordinator-contracts.ts'

const MACHINE_DOMAIN = 'machine'
const ACCESS_PROFILE_DOMAIN = 'access-profile'
const OBSERVATION_DOMAIN = 'connection-observation'
const CHALLENGE_DOMAIN = 'access-challenge'
const WAITER_DOMAIN = 'connection-waiter'
const LEASE_DOMAIN = 'connection-lease'
const TRUST_DECISION_DOMAIN = 'host-trust-decision'
const AUTH_FLOW_DOMAIN = 'auth-flow'
const ATTACHMENT_LEASE_DOMAIN = 'auth-attachment-lease'
const CARRIER_DOMAIN = 'auth-carrier-observation'
const PROMPT_DOMAIN = 'auth-prompt-observation'

const DEFAULT_CHALLENGE_TTL_MS = 10 * 60_000
const DEFAULT_WAITER_TTL_MS = 10 * 60_000
const DEFAULT_CONNECTION_LEASE_TTL_MS = 5 * 60_000
const DEFAULT_AUTH_FLOW_TTL_MS = 10 * 60_000
const DEFAULT_ATTACHMENT_LEASE_TTL_MS = 2 * 60_000
const durationSchema = z.number().int().positive().max(24 * 60 * 60_000)

interface Stored<Value> {
  readonly record: AuthorityRecord
  readonly value: Value
}

interface LoadedTarget {
  readonly machine: Machine
  readonly machineRecord: AuthorityRecord
  readonly accessProfile: AccessProfile
  readonly accessProfileRecord: AuthorityRecord
  readonly connectionIdentityDigest: Sha256
}

interface ProjectionVersion {
  readonly expected: number
  readonly next: Revision
  readonly current?: MachineConnectionPresentation
}

function asJson(value: unknown): JsonValue {
  const detached: unknown = JSON.parse(JSON.stringify(value))
  return jsonValueSchema.parse(detached)
}

function storedValue<Value>(record: AuthorityRecord, schema: z.ZodType<Value>, label: string): Stored<Value> {
  const value = schema.parse(record.value)
  if (record.ownerPrincipalId !== LOCAL_OWNER_PRINCIPAL_ID) {
    throw new AccessConflictError(`${label} owner does not match the resolved principal.`)
  }
  return { record, value }
}

function futureInstant(now: Date, durationMs: number, ceiling?: Instant): Instant {
  const requested = now.getTime() + durationMs
  const timestamp = ceiling === undefined ? requested : Math.min(requested, Date.parse(ceiling))
  return toInstant(new Date(timestamp))
}

function isFuture(instant: Instant, now: Date): boolean {
  return Date.parse(instant) > now.getTime()
}

function abortError(): Error {
  const error = new Error('The pending connection request was aborted.')
  error.name = 'AbortError'
  return error
}

function isActiveAuthFlow(flow: AuthFlow, now: Date): boolean {
  return ['created', 'waiting-attachment', 'interactive', 'verifying'].includes(flow.state)
    && isFuture(flow.expiresAt, now)
}

/** Derives the shared identity from normalized, non-secret access configuration. */
export function connectionIdentityDigestFor(machineInput: Machine, accessProfileInput: AccessProfile): Sha256 {
  const machine = machineSchema.parse(machineInput)
  const accessProfile = accessProfileSchema.parse(accessProfileInput)
  if (machine.ownerPrincipalId !== accessProfile.ownerPrincipalId || machine.accessProfileId !== accessProfile.id) {
    throw new AccessConflictError('Machine and AccessProfile do not identify one owner-scoped target.')
  }
  const access = accessProfile.kind === 'local'
    ? { kind: 'local' as const }
    : accessProfile.target.kind === 'config-alias'
      ? {
          kind: 'ssh-config-alias' as const,
          alias: accessProfile.target.alias.trim().toLowerCase(),
          controlOwnership: accessProfile.controlOwnership,
        }
      : {
          kind: 'ssh-endpoint' as const,
          host: accessProfile.target.host.trim().toLowerCase(),
          user: accessProfile.target.user?.trim() ?? null,
          port: accessProfile.target.port,
          controlOwnership: accessProfile.controlOwnership,
        }
  return canonicalSha256({
    schemaVersion: 1,
    ownerPrincipalId: machine.ownerPrincipalId,
    machineId: machine.id,
    accessProfileId: accessProfile.id,
    access,
  })
}

/** Coordinates lazy connection blockers and leases without accepting caller authority. */
export class AccessCoordinator {
  private readonly now: () => Date
  private readonly challengeTtlMs: number
  private readonly waiterTtlMs: number
  private readonly connectionLeaseTtlMs: number
  private readonly authFlowTtlMs: number
  private readonly attachmentLeaseTtlMs: number

  constructor(
    private readonly authority: RelationalAuthority,
    options: AccessCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.challengeTtlMs = durationSchema.parse(options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS)
    this.waiterTtlMs = durationSchema.parse(options.waiterTtlMs ?? DEFAULT_WAITER_TTL_MS)
    this.connectionLeaseTtlMs = durationSchema.parse(options.connectionLeaseTtlMs ?? DEFAULT_CONNECTION_LEASE_TTL_MS)
    this.authFlowTtlMs = durationSchema.parse(options.authFlowTtlMs ?? DEFAULT_AUTH_FLOW_TTL_MS)
    this.attachmentLeaseTtlMs = durationSchema.parse(options.attachmentLeaseTtlMs ?? DEFAULT_ATTACHMENT_LEASE_TTL_MS)
  }

  requireConnection(input: unknown, signal?: AbortSignal): RequireConnectionResult {
    if (signal?.aborted === true) throw abortError()
    const request = requireConnectionRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const target = this.loadTarget(request.machineId, request.expectedMachineRevision, request.expectedAccessProfileRevision)
    const matching = this.matchingChallenges(target, request.generation)
    const pending = matching.filter(item => item.value.lifecycle.state === 'pending' && isFuture(item.value.expiresAt, now))
    if (pending.length > 1) throw new AccessConflictError('More than one active AccessChallenge exists for this connection generation.')

    const challenge = pending[0]
    if (challenge !== undefined) {
      const duplicate = this.waitersForChallenge(challenge.value).find(item => item.value.toolCallId === request.toolCallId)
      if (duplicate !== undefined) {
        this.assertMatchingWaiter(duplicate.value, request, challenge.value)
        const presentation = this.requireCurrentPresentation(target)
        this.bindAbort(duplicate.value.id, signal)
        return { kind: 'blocked', challenge: challenge.value, waiter: duplicate.value, presentation }
      }
      return this.addWaiter(target, request, challenge, now, at, signal)
    }

    const ready = this.latestReadyObservation(target, request.generation, now, request.minimumRemainingSeconds ?? 0)
    if (ready !== undefined) return this.issueImmediateLease(target, request, ready, now, at)

    if (request.requirement.kind === 'authentication'
      && target.accessProfile.kind === 'ssh'
      && !this.hasHostTrustBasis(target, request.generation)) {
      throw new AccessOrderingError('Host trust must be resolved before an authentication challenge can start.')
    }
    return this.createChallenge(target, request, matching, now, at, signal)
  }

  recordReadyObservation(input: unknown): ConnectionObservation & { readonly state: 'ready' } {
    const request = readyConnectionObservationRequestSchema.parse(input)
    const now = this.currentDate()
    const observedAt = toInstant(now)
    const connectedAt = request.connectedAt ?? observedAt
    if (Date.parse(request.expiresAt) <= now.getTime() || Date.parse(request.expiresAt) <= Date.parse(connectedAt)) {
      throw new AccessConflictError('A ready ConnectionObservation must expire after both connection and observation time.')
    }
    const target = this.loadTarget(request.machineId, request.expectedMachineRevision, request.expectedAccessProfileRevision)
    const observation = connectionObservationSchema.parse({
      schemaVersion: 1,
      id: connectionObservationIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      machineId: target.machine.id,
      machineRevision: target.machine.revision,
      accessProfileId: target.accessProfile.id,
      accessProfileRevision: target.accessProfile.revision,
      connectionIdentityDigest: target.connectionIdentityDigest,
      generation: request.generation,
      state: 'ready',
      connectedAt,
      observedAt,
      expiresAt: request.expiresAt,
    })
    if (observation.state !== 'ready') throw new AccessConflictError('Ready observation construction failed.')

    const pending = this.activeChallenge(target, request.generation, now)
    const projection = pending === undefined
      ? this.readyProjection(target, observation, observedAt)
      : this.blockedProjection(target, pending.value, this.waitersForChallenge(pending.value).map(item => item.value), observedAt)
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [{ kind: 'insert', domain: OBSERVATION_DOMAIN, id: observation.id, value: asJson(observation) }],
      projections: [projection.mutation],
    })
    return observation
  }

  /** Record a real failed provider observation for an exact reconnect requirement. */
  recordDisconnectedObservation(input: unknown): ConnectionObservation & { readonly state: 'disconnected' } {
    const request = disconnectedConnectionObservationRequestSchema.parse(input)
    const now = this.currentDate()
    const observedAt = toInstant(now)
    const target = this.loadTarget(
      request.machineId,
      request.expectedMachineRevision,
      request.expectedAccessProfileRevision,
    )
    const observation = connectionObservationSchema.parse({
      schemaVersion: 1,
      id: connectionObservationIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      machineId: target.machine.id,
      machineRevision: target.machine.revision,
      accessProfileId: target.accessProfile.id,
      accessProfileRevision: target.accessProfile.revision,
      connectionIdentityDigest: target.connectionIdentityDigest,
      generation: request.generation,
      state: 'disconnected',
      reason: request.reason,
      retryable: request.retryable,
      observedAt,
    })
    if (observation.state !== 'disconnected') {
      throw new AccessConflictError('Disconnected observation construction failed.')
    }

    const pending = this.activeChallenge(target, request.generation, now)
    const projection = pending === undefined
      ? this.disconnectedProjection(target, observation.reason, observation.retryable, observedAt)
      : this.blockedProjection(
          target,
          pending.value,
          this.waitersForChallenge(pending.value).map(item => item.value),
          observedAt,
        )
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [{ kind: 'insert', domain: OBSERVATION_DOMAIN, id: observation.id, value: asJson(observation) }],
      projections: [projection.mutation],
    })
    return observation
  }

  /** Advance only causal reconnect blockers or post-auth regressions while preserving exact waiters. */
  replaceConnectionRequirement(input: unknown): ReplaceConnectionRequirementResult {
    const request = replaceConnectionRequirementRequestSchema.parse(input)
    const stored = this.requireChallenge(request.challengeId)
    const current = stored.value
    const now = this.currentDate()
    if (stored.record.revision !== request.expectedChallengeRevision
      || current.revision !== request.expectedChallengeRevision) {
      throw new AccessConflictError('AccessChallenge revision changed before its requirement could advance.')
    }
    if (current.lifecycle.state !== 'pending' || !isFuture(current.expiresAt, now)) {
      throw new AccessConflictError('Only a live pending AccessChallenge can advance its requirement.')
    }
    const permitted = current.requirement.kind === 'reconnect'
      ? request.requirement.kind === 'host-trust'
        || request.requirement.kind === 'authentication'
        || request.requirement.kind === 'reconnect'
      : current.requirement.kind === 'authentication'
        ? request.requirement.kind === 'host-trust' || request.requirement.kind === 'reconnect'
        : false
    if (!permitted) {
      throw new AccessOrderingError('The requested connection-blocker transition is not causally permitted.')
    }
    const target = this.loadTarget(current.machineId)
    if (target.accessProfile.id !== current.accessProfileId
      || target.connectionIdentityDigest !== current.connectionIdentityDigest) {
      throw new AccessConflictError('Connection identity changed before the requirement could advance.')
    }
    if (request.requirement.kind === 'authentication'
      && target.accessProfile.kind === 'ssh'
      && !this.hasHostTrustBasis(target, current.generation, current.id)) {
      throw new AccessOrderingError('Host trust must be resolved before authentication can start.')
    }
    const challenge = accessChallengeSchema.parse({
      ...current,
      revision: revisionSchema.parse(current.revision + 1),
      requirement: request.requirement,
    })
    const at = toInstant(now)
    const projection = this.blockedProjection(
      target,
      challenge,
      this.waitersForChallenge(current).map(item => item.value),
      at,
    )
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [{
        kind: 'replace',
        domain: CHALLENGE_DOMAIN,
        id: challenge.id,
        expectedRevision: stored.record.revision,
        value: asJson(challenge),
      }],
      projections: [projection.mutation],
      audit: [{
        kind: 'access.challenge-requirement-advanced',
        subjectDomain: CHALLENGE_DOMAIN,
        subjectId: challenge.id,
        details: { from: current.requirement.kind, to: challenge.requirement.kind },
      }],
    })
    return { challenge, presentation: projection.presentation }
  }

  resolveChallenge(input: unknown): ResolveAccessChallengeResult {
    const request = resolveAccessChallengeRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const challengeStored = this.requireChallenge(request.challengeId)
    const challenge = challengeStored.value
    if (challengeStored.record.revision !== request.expectedChallengeRevision || challenge.revision !== request.expectedChallengeRevision) {
      throw new AccessConflictError('AccessChallenge revision changed before resolution.')
    }
    if (challenge.lifecycle.state !== 'pending') throw new AccessConflictError(`AccessChallenge is ${challenge.lifecycle.state}.`)
    if (!isFuture(challenge.expiresAt, now)) throw new AccessConflictError('AccessChallenge expired before resolution.')

    const target = this.loadTarget(challenge.machineId)
    if (target.accessProfile.id !== challenge.accessProfileId
      || target.connectionIdentityDigest !== challenge.connectionIdentityDigest) {
      throw new AccessConflictError('Machine or AccessProfile identity changed while access was blocked.')
    }
    const observationStored = this.requireObservation(request.readyObservationId)
    const observation = observationStored.value
    if (observation.state !== 'ready') throw new AccessConflictError('Challenge resolution requires a ready ConnectionObservation.')
    if (observation.machineId !== target.machine.id
      || observation.machineRevision !== target.machine.revision
      || observation.accessProfileId !== target.accessProfile.id
      || observation.accessProfileRevision !== target.accessProfile.revision
      || observation.connectionIdentityDigest !== target.connectionIdentityDigest
      || observation.generation !== challenge.generation) {
      throw new AccessConflictError('Ready observation dependencies do not match the current challenge target.')
    }
    if (!isFuture(observation.expiresAt, now)) throw new AccessConflictError('Ready ConnectionObservation expired before challenge resolution.')
    if (challenge.requirement.kind === 'authentication') {
      if (!this.hasHostTrustBasis(target, challenge.generation, challenge.id)) {
        throw new AccessOrderingError('Authentication cannot resolve without a prior fingerprint-bound host-trust decision.')
      }
    }

    const waiterRows = this.waitersForChallenge(challenge)
    const validWaiters: Stored<PendingConnectionWaiter>[] = []
    const skippedWaiterIds: PendingConnectionWaiter['id'][] = []
    for (const waiter of waiterRows) {
      if (this.waiterMatchesCurrentTarget(waiter.value, target, challenge, now)) validWaiters.push(waiter)
      else skippedWaiterIds.push(waiter.value.id)
    }
    const leases = validWaiters.map(waiter => this.connectionLease(target, observation, waiter.value, now, at))
    const resolvedChallenge = accessChallengeSchema.parse({
      ...challenge,
      revision: revisionSchema.parse(challenge.revision + 1),
      lifecycle: { state: 'resolved', settledAt: at },
      waiterIds: [],
    })
    const mutations: AuthorityMutation[] = [{
      kind: 'replace',
      domain: CHALLENGE_DOMAIN,
      id: challenge.id,
      expectedRevision: challengeStored.record.revision,
      value: asJson(resolvedChallenge),
    }]
    for (const waiter of waiterRows) {
      mutations.push({ kind: 'remove', domain: WAITER_DOMAIN, id: waiter.value.id, expectedRevision: waiter.record.revision })
    }
    for (const lease of leases) mutations.push({ kind: 'insert', domain: LEASE_DOMAIN, id: lease.id, value: asJson(lease) })
    mutations.push(...this.settleAuthentication(challenge, at, now))
    const projection = this.readyProjection(target, observation, at)
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations,
      projections: [projection.mutation],
    })
    return {
      kind: 'resolved',
      challenge: resolvedChallenge,
      observation,
      leases,
      skippedWaiterIds,
      presentation: projection.presentation,
    }
  }

  cancelWaiter(input: unknown): boolean {
    const request = cancelConnectionWaiterRequestSchema.parse(input)
    const waiterStored = this.optionalStored(WAITER_DOMAIN, request.waiterId, pendingConnectionWaiterSchema, 'Connection waiter')
    if (waiterStored === undefined) return false
    const challengeStored = this.optionalStored(CHALLENGE_DOMAIN, waiterStored.value.challengeId, accessChallengeSchema, 'AccessChallenge')
    const mutations: AuthorityMutation[] = [{
      kind: 'remove',
      domain: WAITER_DOMAIN,
      id: waiterStored.value.id,
      expectedRevision: waiterStored.record.revision,
    }]
    const projections: ProjectionMutation[] = []
    if (challengeStored !== undefined && challengeStored.value.lifecycle.state === 'pending') {
      const now = this.currentDate()
      const at = toInstant(now)
      const waiterIds = challengeStored.value.waiterIds.filter(id => id !== waiterStored.value.id)
      const expired = !isFuture(challengeStored.value.expiresAt, now)
      const challenge = accessChallengeSchema.parse({
        ...challengeStored.value,
        revision: revisionSchema.parse(challengeStored.value.revision + 1),
        waiterIds,
        ...(expired ? { lifecycle: { state: 'expired', settledAt: at } }
          : waiterIds.length === 0 ? { lifecycle: { state: 'cancelled', settledAt: at, reason: 'No Chat is waiting for this connection.' } }
            : {}),
      })
      mutations.push({
        kind: 'replace',
        domain: CHALLENGE_DOMAIN,
        id: challenge.id,
        expectedRevision: challengeStored.record.revision,
        value: asJson(challenge),
      })
      try {
        const target = this.loadTarget(challenge.machineId)
        if (target.accessProfile.id === challenge.accessProfileId
          && target.connectionIdentityDigest === challenge.connectionIdentityDigest) {
          const remainingWaiters = this.waitersForChallenge(challenge)
            .filter(item => item.value.id !== waiterStored.value.id)
            .map(item => item.value)
          projections.push(challenge.lifecycle.state === 'pending'
            ? this.blockedProjection(target, challenge, remainingWaiters, at).mutation
            : this.disconnectedProjection(target, expired
              ? 'Sign-in expired. Connect again in this Chat.'
              : 'Connection request ended. Connect again in this Chat.', true, at).mutation)
        }
      } catch (error) {
        if (!(error instanceof AccessNotFoundError) && !(error instanceof AccessConflictError)) throw error
      }
    }
    this.authority.transact({ principalId: resolveLocalOwnerPrincipal(), mutations, projections })
    return true
  }

  decideHostTrust(input: unknown): HostTrustDecisionResult {
    const request = recordHostTrustDecisionRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const challengeStored = this.requireChallenge(request.challengeId)
    const current = challengeStored.value
    if (current.revision !== request.expectedChallengeRevision || challengeStored.record.revision !== request.expectedChallengeRevision) {
      throw new AccessConflictError('AccessChallenge revision changed before the host-trust decision.')
    }
    if (current.lifecycle.state !== 'pending' || !isFuture(current.expiresAt, now)) {
      throw new AccessConflictError('Host trust can be decided only for a live pending challenge.')
    }
    if (current.requirement.kind !== 'host-trust') throw new AccessOrderingError('The current challenge is not a host-trust decision.')
    if (request.fingerprint !== current.requirement.fingerprint) {
      throw new AccessConflictError('Host-trust fingerprint does not match the presented challenge revision.')
    }
    const target = this.loadTarget(current.machineId)
    if (target.connectionIdentityDigest !== current.connectionIdentityDigest || target.accessProfile.id !== current.accessProfileId) {
      throw new AccessConflictError('Connection identity changed before the host-trust decision.')
    }
    const decision = hostTrustDecisionSchema.parse({
      schemaVersion: 1,
      challengeId: current.id,
      challengeRevision: current.revision,
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      decision: request.decision,
      fingerprint: request.fingerprint,
      decidedAt: at,
    })
    const accepted = request.decision !== 'reject'
    const challenge = accessChallengeSchema.parse(accepted
      ? {
          ...current,
          revision: revisionSchema.parse(current.revision + 1),
          requirement: { kind: 'authentication' },
        }
      : {
          ...current,
          revision: revisionSchema.parse(current.revision + 1),
          lifecycle: { state: 'cancelled', settledAt: at, reason: 'Host fingerprint rejected.' },
          waiterIds: [],
        })
    const waiterRows = this.waitersForChallenge(current)
    const mutations: AuthorityMutation[] = [
      {
        kind: 'insert',
        domain: TRUST_DECISION_DOMAIN,
        id: `${current.id}:${current.revision}`,
        value: asJson(decision),
      },
      {
        kind: 'replace',
        domain: CHALLENGE_DOMAIN,
        id: current.id,
        expectedRevision: challengeStored.record.revision,
        value: asJson(challenge),
      },
    ]
    let projection: { readonly mutation: ProjectionMutation; readonly presentation: MachineConnectionPresentation }
    if (accepted) {
      projection = this.blockedProjection(target, challenge, waiterRows.map(item => item.value), at)
    } else {
      for (const waiter of waiterRows) {
        mutations.push({ kind: 'remove', domain: WAITER_DOMAIN, id: waiter.value.id, expectedRevision: waiter.record.revision })
      }
      projection = this.disconnectedProjection(target, 'Host fingerprint was rejected.', false, at)
    }
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations,
      projections: [projection.mutation],
    })
    return { decision, challenge, presentation: projection.presentation }
  }

  startAuthFlow(input: unknown): AuthFlowResult {
    const request = startAuthFlowRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const challengeStored = this.requireChallenge(request.challengeId)
    const current = challengeStored.value
    if (current.revision !== request.expectedChallengeRevision || challengeStored.record.revision !== request.expectedChallengeRevision) {
      throw new AccessConflictError('AccessChallenge revision changed before authentication started.')
    }
    if (current.lifecycle.state !== 'pending' || !isFuture(current.expiresAt, now)) {
      throw new AccessConflictError('Sign-in expired or this connection request ended. Connect again in this Chat.')
    }
    if (current.requirement.kind !== 'authentication') throw new AccessOrderingError('Host trust must be resolved before authentication starts.')
    const target = this.loadTarget(current.machineId)
    if (target.connectionIdentityDigest !== current.connectionIdentityDigest) {
      throw new AccessConflictError('Connection identity changed before authentication started.')
    }
    if (target.accessProfile.kind === 'ssh'
      && !this.hasHostTrustBasis(target, current.generation, current.id)) {
      throw new AccessOrderingError('Host trust must be resolved before authentication starts.')
    }
    const activeFlows = this.listStored(AUTH_FLOW_DOMAIN, authFlowSchema, 'AuthFlow')
      .filter(item => item.value.challengeId === current.id && isActiveAuthFlow(item.value, now))
    if (activeFlows.length > 1) throw new AccessConflictError('More than one active AuthFlow exists for this AccessChallenge.')
    const active = activeFlows[0]
    if (active !== undefined) {
      const presentation = this.requireCurrentPresentation(target)
      return { flow: active.value, challenge: current, presentation }
    }

    const flow = authFlowSchema.parse({
      schemaVersion: 1,
      id: authFlowIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      challengeId: current.id,
      machineId: current.machineId,
      connectionIdentityDigest: current.connectionIdentityDigest,
      revision: 1,
      state: 'waiting-attachment',
      createdAt: at,
      expiresAt: futureInstant(now, this.authFlowTtlMs, current.expiresAt),
    })
    const carrier = authCarrierObservationSchema.parse({
      schemaVersion: 1,
      authFlowId: flow.id,
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      revision: 1,
      state: 'connecting',
      observedAt: at,
    })
    const challenge = accessChallengeSchema.parse({
      ...current,
      revision: revisionSchema.parse(current.revision + 1),
      requirement: { kind: 'authentication', authFlowId: flow.id },
    })
    const projection = this.blockedProjection(
      target,
      challenge,
      this.waitersForChallenge(current).map(item => item.value),
      at,
      { flow, carrier, attachmentLeases: [] },
    )
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [
        { kind: 'insert', domain: AUTH_FLOW_DOMAIN, id: flow.id, value: asJson(flow) },
        { kind: 'insert', domain: CARRIER_DOMAIN, id: flow.id, value: asJson(carrier) },
        {
          kind: 'replace',
          domain: CHALLENGE_DOMAIN,
          id: challenge.id,
          expectedRevision: challengeStored.record.revision,
          value: asJson(challenge),
        },
      ],
      projections: [projection.mutation],
    })
    return { flow, challenge, presentation: projection.presentation }
  }

  acquireAuthAttachment(input: unknown): AuthAttachmentResult {
    const request = acquireAuthAttachmentRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const flowStored = this.requireAuthFlow(request.authFlowId)
    const currentFlow = flowStored.value
    if (!isActiveAuthFlow(currentFlow, now)) throw new AccessConflictError('AuthFlow is not writable or has expired.')
    const target = this.loadTarget(currentFlow.machineId)
    if (target.connectionIdentityDigest !== currentFlow.connectionIdentityDigest) {
      throw new AccessConflictError('Connection identity changed while the AuthFlow was open.')
    }
    const challengeStored = this.requireChallenge(currentFlow.challengeId)
    if (challengeStored.value.lifecycle.state !== 'pending'
      || challengeStored.value.requirement.kind !== 'authentication'
      || challengeStored.value.requirement.authFlowId !== currentFlow.id) {
      throw new AccessConflictError('AuthFlow is no longer attached to the pending challenge.')
    }

    const leaseRows = this.attachmentLeases(currentFlow.id)
    const live = leaseRows.filter(item => item.value.state === 'active' && isFuture(item.value.expiresAt, now))
    if (live.length > 1) throw new AccessConflictError('AuthFlow has more than one active writable attachment lease.')
    const currentWriter = live[0]
    if (currentWriter?.value.attachmentId === request.attachmentId) {
      const presentation = this.requireCurrentPresentation(target)
      return { lease: currentWriter.value, presentation }
    }
    if (currentWriter !== undefined) throw new AuthAttachmentConflictError('Another browser attachment owns the AuthFlow write lease.')

    const mutations = this.expireAttachmentMutations(leaseRows, now, at)
    const lease = authAttachmentLeaseSchema.parse({
      schemaVersion: 1,
      id: authAttachmentLeaseIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      authFlowId: currentFlow.id,
      attachmentId: request.attachmentId,
      mode: 'write',
      acquiredAt: at,
      expiresAt: futureInstant(now, this.attachmentLeaseTtlMs, currentFlow.expiresAt),
      state: 'active',
    })
    const flow = currentFlow.state === 'interactive'
      ? currentFlow
      : authFlowSchema.parse({ ...currentFlow, revision: revisionSchema.parse(currentFlow.revision + 1), state: 'interactive' })
    const carrierStored = this.optionalStored(CARRIER_DOMAIN, currentFlow.id, authCarrierObservationSchema, 'Auth carrier observation')
    const carrier = authCarrierObservationSchema.parse({
      schemaVersion: 1,
      authFlowId: currentFlow.id,
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      revision: revisionSchema.parse((carrierStored?.value.revision ?? 0) + 1),
      state: 'attached',
      attachmentId: request.attachmentId,
      observedAt: at,
    })
    mutations.push({ kind: 'insert', domain: ATTACHMENT_LEASE_DOMAIN, id: lease.id, value: asJson(lease) })
    if (flow !== currentFlow) {
      mutations.push({
        kind: 'replace',
        domain: AUTH_FLOW_DOMAIN,
        id: flow.id,
        expectedRevision: flowStored.record.revision,
        value: asJson(flow),
      })
    }
    mutations.push(carrierStored === undefined
      ? { kind: 'insert', domain: CARRIER_DOMAIN, id: currentFlow.id, value: asJson(carrier) }
      : {
          kind: 'replace',
          domain: CARRIER_DOMAIN,
          id: currentFlow.id,
          expectedRevision: carrierStored.record.revision,
          value: asJson(carrier),
        })
    const resultingLeases = leaseRows
      .filter(item => item.value.state !== 'active' || isFuture(item.value.expiresAt, now))
      .map(item => item.value)
      .concat(lease)
    const projection = this.blockedProjection(
      target,
      challengeStored.value,
      this.waitersForChallenge(challengeStored.value).map(item => item.value),
      at,
      { flow, carrier, attachmentLeases: resultingLeases },
    )
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations,
      projections: [projection.mutation],
    })
    return { lease, presentation: projection.presentation }
  }

  releaseAuthAttachment(input: unknown): AuthAttachmentResult {
    const request = releaseAuthAttachmentRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const leaseStored = this.optionalStored(ATTACHMENT_LEASE_DOMAIN, request.leaseId, authAttachmentLeaseSchema, 'Auth attachment lease')
    if (leaseStored === undefined) throw new AccessNotFoundError(`AuthAttachmentLease '${request.leaseId}' does not exist.`)
    const current = leaseStored.value
    if (current.state !== 'active') {
      const flow = this.requireAuthFlow(current.authFlowId)
      const target = this.loadTarget(flow.value.machineId)
      return { lease: current, presentation: this.requireCurrentPresentation(target) }
    }
    const lease = authAttachmentLeaseSchema.parse(isFuture(current.expiresAt, now)
      ? { ...current, state: 'released', settledAt: at }
      : { ...current, state: 'expired', settledAt: at })
    const flowStored = this.requireAuthFlow(current.authFlowId)
    const target = this.loadTarget(flowStored.value.machineId)
    const challengeStored = this.requireChallenge(flowStored.value.challengeId)
    const carrierStored = this.optionalStored(CARRIER_DOMAIN, current.authFlowId, authCarrierObservationSchema, 'Auth carrier observation')
    const carrier = authCarrierObservationSchema.parse({
      schemaVersion: 1,
      authFlowId: current.authFlowId,
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      revision: revisionSchema.parse((carrierStored?.value.revision ?? 0) + 1),
      state: 'detached',
      closeCode: 1000,
      reason: 'Writable attachment released.',
      observedAt: at,
    })
    const mutations: AuthorityMutation[] = [{
      kind: 'replace',
      domain: ATTACHMENT_LEASE_DOMAIN,
      id: current.id,
      expectedRevision: leaseStored.record.revision,
      value: asJson(lease),
    }]
    mutations.push(carrierStored === undefined
      ? { kind: 'insert', domain: CARRIER_DOMAIN, id: current.authFlowId, value: asJson(carrier) }
      : {
          kind: 'replace',
          domain: CARRIER_DOMAIN,
          id: current.authFlowId,
          expectedRevision: carrierStored.record.revision,
          value: asJson(carrier),
        })
    const attachmentLeases = this.attachmentLeases(current.authFlowId)
      .map(item => item.value.id === lease.id ? lease : item.value)
    const projection = this.blockedProjection(
      target,
      challengeStored.value,
      this.waitersForChallenge(challengeStored.value).map(item => item.value),
      at,
      { flow: flowStored.value, carrier, attachmentLeases },
    )
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations,
      projections: [projection.mutation],
    })
    return { lease, presentation: projection.presentation }
  }

  observeAuthPrompt(input: unknown): AuthPromptResult {
    const request = observeAuthPromptRequestSchema.parse(input)
    const now = this.currentDate()
    const at = toInstant(now)
    const flowStored = this.requireAuthFlow(request.authFlowId)
    const observation = authPromptObservationSchema.parse(request.state === 'observed'
      ? { schemaVersion: 1, authFlowId: request.authFlowId, state: 'observed', promptKind: request.promptKind, observedAt: at }
      : { schemaVersion: 1, authFlowId: request.authFlowId, state: 'not-observed', observedAt: at })
    const current = this.optionalStored(PROMPT_DOMAIN, request.authFlowId, authPromptObservationSchema, 'Auth prompt observation')
    const mutation: AuthorityMutation = current === undefined
      ? { kind: 'insert', domain: PROMPT_DOMAIN, id: request.authFlowId, value: asJson(observation) }
      : {
          kind: 'replace',
          domain: PROMPT_DOMAIN,
          id: request.authFlowId,
          expectedRevision: current.record.revision,
          value: asJson(observation),
        }
    const challengeStored = this.optionalStored(CHALLENGE_DOMAIN, flowStored.value.challengeId, accessChallengeSchema, 'AccessChallenge')
    if (challengeStored === undefined || challengeStored.value.lifecycle.state !== 'pending') {
      this.authority.transact({ principalId: resolveLocalOwnerPrincipal(), mutations: [mutation] })
      return { observation }
    }
    const target = this.loadTarget(flowStored.value.machineId)
    const projection = this.blockedProjection(
      target,
      challengeStored.value,
      this.waitersForChallenge(challengeStored.value).map(item => item.value),
      at,
      { ...this.authPresentationState(challengeStored.value), prompt: observation },
    )
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [mutation],
      projections: [projection.mutation],
    })
    return { observation, presentation: projection.presentation }
  }

  getChallenge(id: string): AccessChallenge | undefined {
    return this.optionalStored(CHALLENGE_DOMAIN, accessChallengeIdSchema.parse(id), accessChallengeSchema, 'AccessChallenge')?.value
  }

  getWaiter(id: string): PendingConnectionWaiter | undefined {
    return this.optionalStored(WAITER_DOMAIN, connectionWaiterIdSchema.parse(id), pendingConnectionWaiterSchema, 'Connection waiter')?.value
  }

  getConnectionLease(id: string): ConnectionLease | undefined {
    return this.optionalStored(LEASE_DOMAIN, connectionLeaseIdSchema.parse(id), connectionLeaseSchema, 'Connection lease')?.value
  }

  connectionLeaseForWaiter(waiterId: string): ConnectionLease | undefined {
    const parsedId = connectionWaiterIdSchema.parse(waiterId)
    return this.listStored(LEASE_DOMAIN, connectionLeaseSchema, 'Connection lease')
      .find(item => item.value.waiterId === parsedId)?.value
  }

  pendingWaiters(): readonly PendingConnectionWaiter[] {
    return this.listStored(WAITER_DOMAIN, pendingConnectionWaiterSchema, 'Connection waiter').map(item => item.value)
  }

  /** Retire blockers left by older Hosts that removed the last waiter but kept sign-in actionable. */
  settleAbandonedChallenges(): void {
    const now = this.currentDate()
    const at = toInstant(now)
    for (const stored of this.listStored(CHALLENGE_DOMAIN, accessChallengeSchema, 'AccessChallenge')) {
      const current = stored.value
      if (current.lifecycle.state !== 'pending' || this.waitersForChallenge(current).length > 0) continue
      const expired = !isFuture(current.expiresAt, now)
      const challenge = accessChallengeSchema.parse({
        ...current, revision: revisionSchema.parse(current.revision + 1), waiterIds: [],
        lifecycle: expired ? { state: 'expired', settledAt: at }
          : { state: 'cancelled', settledAt: at, reason: 'No Chat is waiting for this connection.' },
      })
      const projections: ProjectionMutation[] = []
      try {
        const target = this.loadTarget(challenge.machineId)
        const presentation = this.projectionVersion(target).current
        if (presentation?.connection.state === 'blocked' && presentation.connection.challengeId === challenge.id) {
          projections.push(this.disconnectedProjection(target, expired
            ? 'Sign-in expired. Connect again in this Chat.'
            : 'Connection request ended. Connect again in this Chat.', true, at).mutation)
        }
      } catch (error) {
        if (!(error instanceof AccessNotFoundError) && !(error instanceof AccessConflictError)) throw error
      }
      this.authority.transact({
        principalId: resolveLocalOwnerPrincipal(),
        mutations: [{ kind: 'replace', domain: CHALLENGE_DOMAIN, id: challenge.id,
          expectedRevision: stored.record.revision, value: asJson(challenge) }],
        projections,
      })
    }
  }

  isWaiterCurrent(id: string): boolean {
    const waiter = this.optionalStored(WAITER_DOMAIN, connectionWaiterIdSchema.parse(id), pendingConnectionWaiterSchema, 'Connection waiter')
    if (waiter === undefined) return false
    const challenge = this.optionalStored(CHALLENGE_DOMAIN, waiter.value.challengeId, accessChallengeSchema, 'AccessChallenge')
    const now = this.currentDate()
    if (challenge === undefined || challenge.value.lifecycle.state !== 'pending' || !isFuture(challenge.value.expiresAt, now)) return false
    try {
      const target = this.loadTarget(waiter.value.machineId)
      return this.waiterMatchesCurrentTarget(waiter.value, target, challenge.value, now)
    } catch (error) {
      if (error instanceof AccessNotFoundError || error instanceof AccessConflictError) return false
      throw error
    }
  }

  getAuthFlow(id: string): AuthFlow | undefined {
    return this.optionalStored(AUTH_FLOW_DOMAIN, authFlowIdSchema.parse(id), authFlowSchema, 'AuthFlow')?.value
  }

  getAuthAttachmentLease(id: string): AuthAttachmentLease | undefined {
    return this.optionalStored(ATTACHMENT_LEASE_DOMAIN, authAttachmentLeaseIdSchema.parse(id), authAttachmentLeaseSchema, 'Auth attachment lease')?.value
  }

  private currentDate(): Date {
    const value = this.now()
    if (Number.isNaN(value.getTime())) throw new AccessConflictError('AccessCoordinator clock returned an invalid date.')
    return new Date(value.getTime())
  }

  private loadTarget(machineIdInput: string, expectedMachineRevision?: Revision, expectedAccessProfileRevision?: Revision): LoadedTarget {
    const machineId = machineIdSchema.parse(machineIdInput)
    const machineRecord = this.authority.get(resolveLocalOwnerPrincipal(), MACHINE_DOMAIN, machineId)
    if (machineRecord === undefined) throw new AccessNotFoundError(`Machine '${machineId}' does not exist.`)
    const machine = machineSchema.parse(machineRecord.value)
    if (machine.ownerPrincipalId !== resolveLocalOwnerPrincipal() || machine.id !== machineId || machine.revision !== machineRecord.revision) {
      throw new AccessConflictError('Machine authority record is internally inconsistent.')
    }
    if (machine.lifecycle !== 'active') throw new AccessConflictError('Archived Machines cannot acquire connections.')
    if (expectedMachineRevision !== undefined && machine.revision !== expectedMachineRevision) {
      throw new AccessConflictError('Machine revision changed before connection admission.')
    }
    const accessProfileRecord = this.authority.get(resolveLocalOwnerPrincipal(), ACCESS_PROFILE_DOMAIN, machine.accessProfileId)
    if (accessProfileRecord === undefined) throw new AccessNotFoundError(`AccessProfile '${machine.accessProfileId}' does not exist.`)
    const accessProfile = accessProfileSchema.parse(accessProfileRecord.value)
    if (accessProfile.ownerPrincipalId !== resolveLocalOwnerPrincipal()
      || accessProfile.id !== machine.accessProfileId
      || accessProfile.revision !== accessProfileRecord.revision) {
      throw new AccessConflictError('AccessProfile authority record is internally inconsistent.')
    }
    if (expectedAccessProfileRevision !== undefined && accessProfile.revision !== expectedAccessProfileRevision) {
      throw new AccessConflictError('AccessProfile revision changed before connection admission.')
    }
    return {
      machine,
      machineRecord,
      accessProfile,
      accessProfileRecord,
      connectionIdentityDigest: connectionIdentityDigestFor(machine, accessProfile),
    }
  }

  private optionalStored<Value>(
    domain: string,
    id: string,
    schema: z.ZodType<Value>,
    label: string,
  ): Stored<Value> | undefined {
    const record = this.authority.get(resolveLocalOwnerPrincipal(), domain, id)
    return record === undefined ? undefined : storedValue(record, schema, label)
  }

  private listStored<Value>(domain: string, schema: z.ZodType<Value>, label: string): readonly Stored<Value>[] {
    const records: AuthorityRecord[] = []
    let afterId: string | undefined
    while (true) {
      const page = this.authority.listPage({
        principalId: resolveLocalOwnerPrincipal(),
        domain,
        ...(afterId === undefined ? {} : { afterId }),
        limit: 500,
      })
      records.push(...page)
      if (page.length < 500) break
      afterId = page[page.length - 1]?.id
      if (afterId === undefined) throw new AccessConflictError(`Authority pagination for ${label} did not advance.`)
    }
    return records.map(record => storedValue(record, schema, label))
  }

  private requireChallenge(id: string): Stored<AccessChallenge> {
    const challenge = this.optionalStored(CHALLENGE_DOMAIN, accessChallengeIdSchema.parse(id), accessChallengeSchema, 'AccessChallenge')
    if (challenge === undefined) throw new AccessNotFoundError(`AccessChallenge '${id}' does not exist.`)
    if (challenge.value.revision !== challenge.record.revision) throw new AccessConflictError('AccessChallenge authority revision is inconsistent.')
    return challenge
  }

  private requireObservation(id: string): Stored<ConnectionObservation> {
    const observation = this.optionalStored(OBSERVATION_DOMAIN, connectionObservationIdSchema.parse(id), connectionObservationSchema, 'ConnectionObservation')
    if (observation === undefined) throw new AccessNotFoundError(`ConnectionObservation '${id}' does not exist.`)
    return observation
  }

  private requireAuthFlow(id: string): Stored<AuthFlow> {
    const flow = this.optionalStored(AUTH_FLOW_DOMAIN, authFlowIdSchema.parse(id), authFlowSchema, 'AuthFlow')
    if (flow === undefined) throw new AccessNotFoundError(`AuthFlow '${id}' does not exist.`)
    if (flow.value.revision !== flow.record.revision) throw new AccessConflictError('AuthFlow authority revision is inconsistent.')
    return flow
  }

  private matchingChallenges(target: LoadedTarget, generation: Revision): readonly Stored<AccessChallenge>[] {
    return this.listStored(CHALLENGE_DOMAIN, accessChallengeSchema, 'AccessChallenge').filter(item =>
      item.value.machineId === target.machine.id
      && item.value.accessProfileId === target.accessProfile.id
      && item.value.connectionIdentityDigest === target.connectionIdentityDigest
      && item.value.generation === generation)
  }

  private activeChallenge(target: LoadedTarget, generation: Revision, now: Date): Stored<AccessChallenge> | undefined {
    const challenges = this.matchingChallenges(target, generation)
      .filter(item => item.value.lifecycle.state === 'pending' && isFuture(item.value.expiresAt, now))
    if (challenges.length > 1) throw new AccessConflictError('More than one active AccessChallenge exists for this connection generation.')
    return challenges[0]
  }

  private waitersForChallenge(challenge: AccessChallenge): readonly Stored<PendingConnectionWaiter>[] {
    return challenge.waiterIds.flatMap(waiterId => {
      const waiter = this.optionalStored(WAITER_DOMAIN, waiterId, pendingConnectionWaiterSchema, 'Connection waiter')
      return waiter === undefined ? [] : [waiter]
    })
  }

  private latestReadyObservation(
    target: LoadedTarget,
    generation: Revision,
    now: Date,
    minimumRemainingSeconds: number,
  ): Stored<ConnectionObservation & { readonly state: 'ready' }> | undefined {
    const minimumExpiry = now.getTime() + minimumRemainingSeconds * 1_000
    const matches: Stored<ConnectionObservation>[] = []
    for (const item of this.listStored(OBSERVATION_DOMAIN, connectionObservationSchema, 'ConnectionObservation')) {
      const observation = item.value
      if (observation.machineId === target.machine.id
        && observation.machineRevision === target.machine.revision
        && observation.accessProfileId === target.accessProfile.id
        && observation.accessProfileRevision === target.accessProfile.revision
        && observation.connectionIdentityDigest === target.connectionIdentityDigest
        && observation.generation === generation) {
        matches.push({ record: item.record, value: observation })
      }
    }
    const ready = matches
      .filter((item): item is Stored<ConnectionObservation & { readonly state: 'ready' }> => item.value.state === 'ready')
      .filter(item => Date.parse(item.value.expiresAt) >= minimumExpiry)
      .sort((left, right) => Date.parse(right.value.observedAt) - Date.parse(left.value.observedAt))[0]
    if (ready === undefined) return undefined
    const disconnectedAt = matches
      .filter(item => item.value.state === 'disconnected')
      .reduce((latest, item) => Math.max(latest, Date.parse(item.value.observedAt)), Number.NEGATIVE_INFINITY)
    return disconnectedAt > Date.parse(ready.value.observedAt) ? undefined : ready
  }

  private issueImmediateLease(
    target: LoadedTarget,
    request: RequireConnectionRequest,
    observation: Stored<ConnectionObservation & { readonly state: 'ready' }>,
    now: Date,
    at: Instant,
  ): RequireConnectionResult {
    const lease = this.connectionLease(target, observation.value, undefined, now, at, request)
    const projection = this.readyProjection(target, observation.value, at)
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [{ kind: 'insert', domain: LEASE_DOMAIN, id: lease.id, value: asJson(lease) }],
      projections: [projection.mutation],
    })
    return { kind: 'ready', observation: observation.value, lease, presentation: projection.presentation }
  }

  private addWaiter(
    target: LoadedTarget,
    request: RequireConnectionRequest,
    challengeStored: Stored<AccessChallenge>,
    now: Date,
    at: Instant,
    signal?: AbortSignal,
  ): RequireConnectionResult {
    const waiter = this.newWaiter(target, request, challengeStored.value, now, at)
    const challenge = accessChallengeSchema.parse({
      ...challengeStored.value,
      revision: revisionSchema.parse(challengeStored.value.revision + 1),
      waiterIds: [...challengeStored.value.waiterIds, waiter.id],
    })
    const waiters = [...this.waitersForChallenge(challengeStored.value).map(item => item.value), waiter]
    const projection = this.blockedProjection(target, challenge, waiters, at)
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations: [
        { kind: 'insert', domain: WAITER_DOMAIN, id: waiter.id, value: asJson(waiter) },
        {
          kind: 'replace',
          domain: CHALLENGE_DOMAIN,
          id: challenge.id,
          expectedRevision: challengeStored.record.revision,
          value: asJson(challenge),
        },
      ],
      projections: [projection.mutation],
    })
    this.bindAbort(waiter.id, signal)
    return { kind: 'blocked', challenge, waiter, presentation: projection.presentation }
  }

  private createChallenge(
    target: LoadedTarget,
    request: RequireConnectionRequest,
    matching: readonly Stored<AccessChallenge>[],
    now: Date,
    at: Instant,
    signal?: AbortSignal,
  ): RequireConnectionResult {
    const challenge = accessChallengeSchema.parse({
      schemaVersion: 1,
      id: accessChallengeIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      machineId: target.machine.id,
      accessProfileId: target.accessProfile.id,
      connectionIdentityDigest: target.connectionIdentityDigest,
      generation: request.generation,
      revision: 1,
      requirement: request.requirement,
      lifecycle: { state: 'pending' },
      waiterIds: [],
      createdAt: at,
      expiresAt: futureInstant(now, this.challengeTtlMs),
    })
    const waiter = this.newWaiter(target, request, challenge, now, at)
    const challengeWithWaiter = accessChallengeSchema.parse({ ...challenge, waiterIds: [waiter.id] })
    const observation = connectionObservationSchema.parse({
      schemaVersion: 1,
      id: connectionObservationIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      machineId: target.machine.id,
      machineRevision: target.machine.revision,
      accessProfileId: target.accessProfile.id,
      accessProfileRevision: target.accessProfile.revision,
      connectionIdentityDigest: target.connectionIdentityDigest,
      generation: request.generation,
      state: 'blocked',
      challengeId: challenge.id,
      challengeRevision: challenge.revision,
      observedAt: at,
    })
    const mutations = this.expireChallengeMutations(matching, now, at)
    mutations.push(
      { kind: 'insert', domain: CHALLENGE_DOMAIN, id: challenge.id, value: asJson(challengeWithWaiter) },
      { kind: 'insert', domain: WAITER_DOMAIN, id: waiter.id, value: asJson(waiter) },
      { kind: 'insert', domain: OBSERVATION_DOMAIN, id: observation.id, value: asJson(observation) },
    )
    const projection = this.blockedProjection(target, challengeWithWaiter, [waiter], at)
    this.authority.transact({
      principalId: resolveLocalOwnerPrincipal(),
      mutations,
      projections: [projection.mutation],
    })
    this.bindAbort(waiter.id, signal)
    return { kind: 'blocked', challenge: challengeWithWaiter, waiter, presentation: projection.presentation }
  }

  private expireChallengeMutations(
    matching: readonly Stored<AccessChallenge>[],
    now: Date,
    at: Instant,
  ): AuthorityMutation[] {
    const mutations: AuthorityMutation[] = []
    const removedWaiters = new Set<string>()
    for (const item of matching) {
      if (item.value.lifecycle.state !== 'pending' || isFuture(item.value.expiresAt, now)) continue
      const expired = accessChallengeSchema.parse({
        ...item.value,
        revision: revisionSchema.parse(item.value.revision + 1),
        lifecycle: { state: 'expired', settledAt: at },
        waiterIds: [],
      })
      mutations.push({
        kind: 'replace',
        domain: CHALLENGE_DOMAIN,
        id: item.value.id,
        expectedRevision: item.record.revision,
        value: asJson(expired),
      })
      for (const waiter of this.waitersForChallenge(item.value)) {
        if (removedWaiters.has(waiter.value.id)) continue
        removedWaiters.add(waiter.value.id)
        mutations.push({ kind: 'remove', domain: WAITER_DOMAIN, id: waiter.value.id, expectedRevision: waiter.record.revision })
      }
    }
    return mutations
  }

  private newWaiter(
    target: LoadedTarget,
    request: RequireConnectionRequest,
    challenge: AccessChallenge,
    now: Date,
    at: Instant,
  ): PendingConnectionWaiter {
    return pendingConnectionWaiterSchema.parse({
      schemaVersion: 1,
      id: connectionWaiterIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      challengeId: challenge.id,
      toolCallId: request.toolCallId,
      sessionId: request.sessionId,
      agentId: request.agentId,
      machineId: target.machine.id,
      connectionIdentityDigest: target.connectionIdentityDigest,
      purpose: request.purpose,
      dependencyRevisions: {
        machine: target.machine.revision,
        accessProfile: target.accessProfile.revision,
      },
      createdAt: at,
      expiresAt: futureInstant(now, this.waiterTtlMs, challenge.expiresAt),
    })
  }

  private assertMatchingWaiter(
    waiter: PendingConnectionWaiter,
    request: RequireConnectionRequest,
    challenge: AccessChallenge,
  ): void {
    if (waiter.challengeId !== challenge.id
      || waiter.sessionId !== request.sessionId
      || waiter.agentId !== request.agentId
      || waiter.machineId !== request.machineId
      || waiter.purpose !== request.purpose
      || waiter.connectionIdentityDigest !== challenge.connectionIdentityDigest
      || waiter.dependencyRevisions.machine !== request.expectedMachineRevision
      || waiter.dependencyRevisions.accessProfile !== request.expectedAccessProfileRevision) {
      throw new AccessConflictError('Tool call id is already bound to another connection waiter.')
    }
  }

  private waiterMatchesCurrentTarget(
    waiter: PendingConnectionWaiter,
    target: LoadedTarget,
    challenge: AccessChallenge,
    now: Date,
  ): boolean {
    return waiter.challengeId === challenge.id
      && waiter.machineId === target.machine.id
      && waiter.connectionIdentityDigest === target.connectionIdentityDigest
      && waiter.dependencyRevisions.machine === target.machine.revision
      && waiter.dependencyRevisions.accessProfile === target.accessProfile.revision
      && isFuture(waiter.expiresAt, now)
  }

  private connectionLease(
    target: LoadedTarget,
    observation: ConnectionObservation & { readonly state: 'ready' },
    waiter: PendingConnectionWaiter | undefined,
    now: Date,
    at: Instant,
    request?: RequireConnectionRequest,
  ): ConnectionLease {
    const sessionId = waiter?.sessionId ?? request?.sessionId
    const agentId = waiter?.agentId ?? request?.agentId
    const purpose = waiter?.purpose ?? request?.purpose
    if (sessionId === undefined || agentId === undefined || purpose === undefined) {
      throw new AccessConflictError('Connection lease scope is incomplete.')
    }
    return connectionLeaseSchema.parse({
      schemaVersion: 1,
      id: connectionLeaseIdSchema.parse(createUuidV7()),
      ownerPrincipalId: resolveLocalOwnerPrincipal(),
      ...(waiter === undefined ? {} : { waiterId: waiter.id }),
      sessionId,
      agentId,
      machineId: target.machine.id,
      machineRevision: target.machine.revision,
      accessProfileId: target.accessProfile.id,
      accessProfileRevision: target.accessProfile.revision,
      connectionIdentityDigest: target.connectionIdentityDigest,
      purpose,
      acquiredAt: at,
      expiresAt: futureInstant(now, this.connectionLeaseTtlMs, observation.expiresAt),
    })
  }

  private hasAcceptedHostTrust(identity: Sha256, generation: Revision, challengeId?: AccessChallenge['id']): boolean {
    return this.listStored(TRUST_DECISION_DOMAIN, hostTrustDecisionSchema, 'Host-trust decision').some(item => {
      if (item.value.decision === 'reject') return false
      const source = this.optionalStored(CHALLENGE_DOMAIN, item.value.challengeId, accessChallengeSchema, 'AccessChallenge')
      return source !== undefined
        && source.value.connectionIdentityDigest === identity
        && source.value.generation === generation
        && (challengeId === undefined || source.value.id === challengeId)
        && item.value.challengeRevision < source.value.revision
    })
  }

  /**
   * Pinned and user-known-hosts profiles already encode the selected trust
   * authority and OpenSSH verifies that authority before it can report an
   * authentication blocker. TOFU has no such proof, so it still requires the
   * explicit fingerprint-bound decision recorded against this generation.
   */
  private hasHostTrustBasis(
    target: LoadedTarget,
    generation: Revision,
    challengeId?: AccessChallenge['id'],
  ): boolean {
    if (target.accessProfile.kind === 'local') return true
    if (target.accessProfile.trustPolicy.kind !== 'trust-on-first-use') return true
    return this.hasAcceptedHostTrust(target.connectionIdentityDigest, generation, challengeId)
  }

  private settleAuthentication(challenge: AccessChallenge, at: Instant, now: Date): AuthorityMutation[] {
    if (challenge.requirement.kind !== 'authentication' || challenge.requirement.authFlowId === undefined) return []
    const flowStored = this.requireAuthFlow(challenge.requirement.authFlowId)
    if (flowStored.value.challengeId !== challenge.id
      || flowStored.value.machineId !== challenge.machineId
      || flowStored.value.connectionIdentityDigest !== challenge.connectionIdentityDigest
      || !isFuture(flowStored.value.expiresAt, now)) {
      throw new AccessConflictError('AuthFlow is stale or does not match the resolving challenge.')
    }
    const mutations: AuthorityMutation[] = []
    if (flowStored.value.state !== 'ready') {
      if (flowStored.value.state === 'failed' || flowStored.value.state === 'expired' || flowStored.value.state === 'cancelled') {
        throw new AccessConflictError(`AuthFlow is ${flowStored.value.state}.`)
      }
      const flow = authFlowSchema.parse({
        ...flowStored.value,
        revision: revisionSchema.parse(flowStored.value.revision + 1),
        state: 'ready',
        settledAt: at,
      })
      mutations.push({
        kind: 'replace',
        domain: AUTH_FLOW_DOMAIN,
        id: flow.id,
        expectedRevision: flowStored.record.revision,
        value: asJson(flow),
      })
    }
    for (const leaseStored of this.attachmentLeases(flowStored.value.id)) {
      if (leaseStored.value.state !== 'active') continue
      const lease = authAttachmentLeaseSchema.parse({ ...leaseStored.value, state: 'released', settledAt: at })
      mutations.push({
        kind: 'replace',
        domain: ATTACHMENT_LEASE_DOMAIN,
        id: lease.id,
        expectedRevision: leaseStored.record.revision,
        value: asJson(lease),
      })
    }
    const carrierStored = this.optionalStored(CARRIER_DOMAIN, flowStored.value.id, authCarrierObservationSchema, 'Auth carrier observation')
    if (carrierStored !== undefined) {
      const carrier = authCarrierObservationSchema.parse({
        schemaVersion: 1,
        authFlowId: flowStored.value.id,
        ownerPrincipalId: resolveLocalOwnerPrincipal(),
        revision: revisionSchema.parse(carrierStored.value.revision + 1),
        state: 'detached',
        closeCode: 1000,
        reason: 'Authentication completed.',
        observedAt: at,
      })
      mutations.push({
        kind: 'replace',
        domain: CARRIER_DOMAIN,
        id: flowStored.value.id,
        expectedRevision: carrierStored.record.revision,
        value: asJson(carrier),
      })
    }
    return mutations
  }

  private attachmentLeases(flowId: AuthFlow['id']): readonly Stored<AuthAttachmentLease>[] {
    return this.listStored(ATTACHMENT_LEASE_DOMAIN, authAttachmentLeaseSchema, 'Auth attachment lease')
      .filter(item => item.value.authFlowId === flowId)
  }

  private expireAttachmentMutations(
    leases: readonly Stored<AuthAttachmentLease>[],
    now: Date,
    at: Instant,
  ): AuthorityMutation[] {
    return leases.flatMap(item => {
      if (item.value.state !== 'active' || isFuture(item.value.expiresAt, now)) return []
      const expired = authAttachmentLeaseSchema.parse({ ...item.value, state: 'expired', settledAt: at })
      return [{
        kind: 'replace' as const,
        domain: ATTACHMENT_LEASE_DOMAIN,
        id: item.value.id,
        expectedRevision: item.record.revision,
        value: asJson(expired),
      }]
    })
  }

  private authPresentationState(challenge: AccessChallenge): AccessPresentationAuthState {
    if (challenge.requirement.kind !== 'authentication' || challenge.requirement.authFlowId === undefined) return {}
    const flow = this.optionalStored(AUTH_FLOW_DOMAIN, challenge.requirement.authFlowId, authFlowSchema, 'AuthFlow')?.value
    if (flow === undefined) return {}
    const carrier = this.optionalStored(CARRIER_DOMAIN, flow.id, authCarrierObservationSchema, 'Auth carrier observation')?.value
    const prompt = this.optionalStored(PROMPT_DOMAIN, flow.id, authPromptObservationSchema, 'Auth prompt observation')?.value
    return {
      flow,
      ...(carrier === undefined ? {} : { carrier }),
      ...(prompt === undefined ? {} : { prompt }),
      attachmentLeases: this.attachmentLeases(flow.id).map(item => item.value),
    }
  }

  private projectionVersion(target: LoadedTarget): ProjectionVersion {
    const id = machineConnectionPresentationId(target.machine, target.connectionIdentityDigest)
    let baseline = this.authority.baseline({ principalId: resolveLocalOwnerPrincipal(), pageSize: 500 })
    while (true) {
      const current = baseline.values.find(item => item.projection === 'machine-connection' && item.id === id)
      if (current !== undefined) {
        const presentation = machineConnectionPresentationSchema.parse(current.value)
        if (presentation.revision !== current.revision || presentation.id !== current.id) {
          throw new AccessConflictError('Machine connection projection revision is inconsistent.')
        }
        return { expected: current.revision, next: revisionSchema.parse(current.revision + 1), current: presentation }
      }
      if (baseline.complete) return { expected: 0, next: revisionSchema.parse(1) }
      if (baseline.nextPageCursor === undefined) throw new AccessConflictError('Projection baseline pagination is incomplete.')
      baseline = this.authority.baseline({
        principalId: resolveLocalOwnerPrincipal(),
        pageSize: 500,
        pageCursor: baseline.nextPageCursor,
        snapshotToken: baseline.snapshotToken,
      })
    }
  }

  private requireCurrentPresentation(target: LoadedTarget): MachineConnectionPresentation {
    const version = this.projectionVersion(target)
    if (version.current === undefined) throw new AccessNotFoundError('Machine connection presentation does not exist.')
    return version.current
  }

  private blockedProjection(
    target: LoadedTarget,
    challenge: AccessChallenge,
    waiters: readonly PendingConnectionWaiter[],
    at: Instant,
    auth: AccessPresentationAuthState = this.authPresentationState(challenge),
  ): { readonly mutation: ProjectionMutation; readonly presentation: MachineConnectionPresentation } {
    const version = this.projectionVersion(target)
    const presentation = buildBlockedMachineConnectionPresentation({
      machine: target.machine,
      connectionIdentityDigest: target.connectionIdentityDigest,
      challenge,
      waiters,
      ...auth,
      revision: version.next,
      updatedAt: at,
    })
    return {
      presentation,
      mutation: {
        kind: 'upsert',
        projection: 'machine-connection',
        id: presentation.id,
        expectedRevision: version.expected,
        value: asJson(presentation),
      },
    }
  }

  private readyProjection(
    target: LoadedTarget,
    observation: ConnectionObservation & { readonly state: 'ready' },
    at: Instant,
  ): { readonly mutation: ProjectionMutation; readonly presentation: MachineConnectionPresentation } {
    const version = this.projectionVersion(target)
    const presentation = buildReadyMachineConnectionPresentation({
      machine: target.machine,
      connectionIdentityDigest: target.connectionIdentityDigest,
      observation,
      revision: version.next,
      updatedAt: at,
    })
    return {
      presentation,
      mutation: {
        kind: 'upsert',
        projection: 'machine-connection',
        id: presentation.id,
        expectedRevision: version.expected,
        value: asJson(presentation),
      },
    }
  }

  private disconnectedProjection(
    target: LoadedTarget,
    reason: string,
    retryable: boolean,
    at: Instant,
  ): { readonly mutation: ProjectionMutation; readonly presentation: MachineConnectionPresentation } {
    const version = this.projectionVersion(target)
    const presentation = buildDisconnectedMachineConnectionPresentation({
      machine: target.machine,
      connectionIdentityDigest: target.connectionIdentityDigest,
      reason,
      retryable,
      revision: version.next,
      updatedAt: at,
    })
    return {
      presentation,
      mutation: {
        kind: 'upsert',
        projection: 'machine-connection',
        id: presentation.id,
        expectedRevision: version.expected,
        value: asJson(presentation),
      },
    }
  }

  private bindAbort(waiterId: PendingConnectionWaiter['id'], signal?: AbortSignal): void {
    if (signal === undefined) return
    const cancel = (): void => {
      try {
        this.cancelWaiter({ waiterId })
      } catch {
        // The durable waiter may already have resolved, or the authority may be closing.
      }
    }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
      throw abortError()
    }
  }
}
