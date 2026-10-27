import {
  AccessConflictError,
  AccessCoordinator,
  AccessNotFoundError,
  EXECUTION_AUTHORITY_DOMAINS,
  LOCAL_OWNER_PRINCIPAL_ID,
  PendingConnectionCallAdapter,
  accessChallengeIdSchema,
  accessChallengeSchema,
  accessProfileSchema,
  authFlowIdSchema,
  canonicalSha256,
  connectionIdentityDigestFor,
  hostTrustDecisionSchema,
  machineIdSchema,
  redesignMachineSchema,
  revisionSchema,
  toInstant,
  type AccessChallenge,
  type AccessProfile,
  type AuthFlowResult,
  type ConnectionCallResult,
  type ConnectionObservation,
  type HostTrustDecisionResult,
  type MachineId,
  type RedesignMachine,
  type RelationalAuthority,
  type RequireConnectionRequest,
  type Revision,
  type Sha256,
} from '@dsh-slop/core'
import { persistPinnedKnownHost, SshConnectionError, type OpenSshBroker } from './ssh-broker.ts'
import type { AuthFlowSeam, ConnectionState } from './types.ts'
import { AuthorityConnectionTrustOverrides } from './connection-trust-overrides.ts'

const CONNECTION_OBSERVATION_SECONDS = 5 * 60

type BrokerRuntime = Pick<OpenSshBroker,
  'beginAuth'
  | 'connect'
  | 'inspectHostKey'
  | 'reconcileStatus'
  | 'release'>

export type RuntimeConnectionRequest = Omit<RequireConnectionRequest, 'generation' | 'requirement'> & {
  readonly generation?: Revision
}

export interface RuntimeConnectionStatus {
  readonly machineId: MachineId
  readonly state: ConnectionState | 'ready-local'
  readonly challenge?: AccessChallenge
  readonly message?: string
}

export type RuntimeConnectionAttempt =
  | {
      readonly kind: 'ready'
      readonly observation: ConnectionObservation & { readonly state: 'ready' }
    }
  | {
      readonly kind: 'blocked'
      readonly requirement: AccessChallenge['requirement']
      readonly challenge?: AccessChallenge
    }

export interface AuthenticationStartResult {
  readonly scope: 'machine'
  readonly authFlowId: string
  readonly carrierFlowId: string
  readonly challenge: AccessChallenge
  readonly expiresAt: string
  readonly coordinator: AuthFlowResult
}

export interface AuthenticationStatusResult {
  readonly state: 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired'
  readonly resumed: boolean
}

interface MaterializedTarget {
  readonly machine: RedesignMachine
  readonly access: AccessProfile
  readonly identity: Sha256
}

interface AuthenticationBinding {
  readonly authFlowId: string
  readonly carrierFlowId: string
  readonly challengeId: AccessChallenge['id']
  readonly machineId: MachineId
  readonly expiresAt: string
}

export interface MachineConnectionRuntimeOptions {
  readonly authority: RelationalAuthority
  readonly broker: BrokerRuntime
  readonly authFlows: AuthFlowSeam
  readonly trustOverrides: AuthorityConnectionTrustOverrides
  readonly accessCoordinator?: AccessCoordinator
  readonly pendingConnectionCalls?: PendingConnectionCallAdapter
  readonly now?: () => Date
}

/** Machine-only host runtime for reusable SSH and protected access continuation. */
export class MachineConnectionRuntime {
  readonly accessCoordinator: AccessCoordinator
  readonly pendingConnectionCalls: PendingConnectionCallAdapter

  private readonly authority: RelationalAuthority
  private readonly broker: BrokerRuntime
  private readonly authFlows: AuthFlowSeam
  private readonly trustOverrides: AuthorityConnectionTrustOverrides
  private readonly now: () => Date
  private readonly authenticationBindings = new Map<string, AuthenticationBinding>()

  constructor(options: MachineConnectionRuntimeOptions) {
    this.authority = options.authority
    this.broker = options.broker
    this.authFlows = options.authFlows
    this.trustOverrides = options.trustOverrides
    this.now = options.now ?? (() => new Date())
    this.accessCoordinator = options.accessCoordinator ?? new AccessCoordinator(options.authority)
    this.pendingConnectionCalls = options.pendingConnectionCalls
      ?? new PendingConnectionCallAdapter(this.accessCoordinator)
  }

  async status(machineIdInput: MachineId, signal?: AbortSignal): Promise<RuntimeConnectionStatus> {
    signal?.throwIfAborted()
    const target = this.loadTarget(machineIdInput)
    const challenge = this.activeChallenge(target.machine.id, target.identity, target.access.revision)
    if (target.access.kind === 'local') {
      return {
        machineId: target.machine.id,
        state: 'ready-local',
        ...(challenge === undefined ? {} : { challenge }),
      }
    }
    const status = await this.broker.reconcileStatus(target.machine.id, signal)
    return {
      machineId: target.machine.id,
      state: status.state,
      ...(challenge === undefined ? {} : { challenge }),
      ...(status.message === undefined ? {} : { message: status.message }),
    }
  }

  async requireConnection(input: RuntimeConnectionRequest, signal?: AbortSignal): Promise<ConnectionCallResult> {
    signal?.throwIfAborted()
    const target = this.loadTarget(
      input.machineId,
      input.expectedMachineRevision,
      input.expectedAccessProfileRevision,
    )
    const generation = revisionSchema.parse(input.generation ?? target.access.revision)
    const attempt = await this.attemptConnection(target, generation, signal)
    const requirement = attempt.kind === 'blocked'
      ? attempt.requirement
      : {
          kind: 'reconnect' as const,
          lastObservationId: attempt.observation.id,
          reason: 'The ready observation changed before the scoped lease was issued.',
        }
    return await this.pendingConnectionCalls.requireConnection({ ...input, generation, requirement }, signal)
  }

  connect(input: RuntimeConnectionRequest, signal?: AbortSignal): Promise<ConnectionCallResult> {
    return this.requireConnection(input, signal)
  }

  async decideHostTrust(
    input: {
      readonly challengeId: string
      readonly expectedChallengeRevision: Revision
      readonly decision: 'trust-once' | 'trust-and-pin' | 'reject'
      readonly fingerprint: string
    },
    signal?: AbortSignal,
  ): Promise<HostTrustDecisionResult> {
    signal?.throwIfAborted()
    const current = this.requireChallenge(input.challengeId, input.expectedChallengeRevision)
    if (current.requirement.kind !== 'host-trust') {
      throw new AccessConflictError('The AccessChallenge is not waiting for host trust.')
    }
    if (current.requirement.fingerprint !== input.fingerprint) {
      throw new AccessConflictError('The host fingerprint changed before the decision was applied.')
    }
    if (input.decision !== 'reject') await this.installAcceptedHostKey(current, input.fingerprint)

    const result = this.accessCoordinator.decideHostTrust(input)
    if (input.decision === 'reject') {
      this.pendingConnectionCalls.settleStaleCalls()
      return result
    }
    this.trustOverrides.activateOnce(result.challenge, input.fingerprint)
    const target = this.loadTarget(result.challenge.machineId)
    await this.attemptConnection(target, result.challenge.generation, signal)
    return result
  }

  async startAuthentication(
    input: { readonly challengeId: string; readonly expectedChallengeRevision: Revision },
  ): Promise<AuthenticationStartResult> {
    const current = this.requireChallenge(input.challengeId, input.expectedChallengeRevision)
    if (current.requirement.kind !== 'authentication') {
      throw new AccessConflictError('The AccessChallenge is not waiting for authentication.')
    }
    const coordinator = this.accessCoordinator.startAuthFlow(input)
    const existing = this.authenticationBindings.get(coordinator.flow.id)
    if (existing !== undefined) return this.authenticationResult(existing, coordinator)

    const carrier = await this.broker.beginAuth(current.machineId, LOCAL_OWNER_PRINCIPAL_ID)
    const binding: AuthenticationBinding = {
      authFlowId: coordinator.flow.id,
      carrierFlowId: carrier.flowId,
      challengeId: coordinator.challenge.id,
      machineId: current.machineId,
      expiresAt: carrier.expiresAt < coordinator.flow.expiresAt
        ? carrier.expiresAt
        : coordinator.flow.expiresAt,
    }
    this.authenticationBindings.set(binding.authFlowId, binding)
    return this.authenticationResult(binding, coordinator)
  }

  async authenticationStatus(authFlowIdInput: string, signal?: AbortSignal): Promise<AuthenticationStatusResult> {
    signal?.throwIfAborted()
    const authFlowId = authFlowIdSchema.parse(authFlowIdInput)
    let binding = this.authenticationBindings.get(authFlowId)
    if (binding === undefined) {
      const flow = this.accessCoordinator.getAuthFlow(authFlowId)
      if (flow === undefined) throw new AccessNotFoundError('The authentication runtime binding does not exist.')
      const carrier = await this.broker.beginAuth(flow.machineId, LOCAL_OWNER_PRINCIPAL_ID)
      binding = {
        authFlowId: flow.id,
        carrierFlowId: carrier.flowId,
        challengeId: flow.challengeId,
        machineId: flow.machineId,
        expiresAt: carrier.expiresAt < flow.expiresAt ? carrier.expiresAt : flow.expiresAt,
      }
      this.authenticationBindings.set(authFlowId, binding)
    }

    const status = await this.authFlows.status(binding.carrierFlowId, LOCAL_OWNER_PRINCIPAL_ID)
    if (status.state !== 'ready') return { state: status.state, resumed: false }
    const challenge = this.requireChallenge(binding.challengeId)
    const target = this.loadTarget(binding.machineId)
    const result = await this.attemptConnection(target, challenge.generation, signal)
    return { state: 'ready', resumed: result.kind === 'ready' }
  }

  async cancelAuthentication(authFlowIdInput: string): Promise<void> {
    const authFlowId = authFlowIdSchema.parse(authFlowIdInput)
    const binding = this.authenticationBindings.get(authFlowId)
    if (binding === undefined) throw new AccessNotFoundError('The authentication runtime binding does not exist.')
    await this.authFlows.cancel(binding.carrierFlowId, LOCAL_OWNER_PRINCIPAL_ID)
    this.authenticationBindings.delete(authFlowId)
  }

  close(): void {
    this.pendingConnectionCalls.settleUnavailable()
    this.authenticationBindings.clear()
  }

  private async attemptConnection(
    target: MaterializedTarget,
    generation: Revision,
    signal?: AbortSignal,
  ): Promise<RuntimeConnectionAttempt> {
    signal?.throwIfAborted()
    let challenge = this.activeChallenge(target.machine.id, target.identity, generation)
    if (target.access.kind === 'local') {
      return this.readyConnection(
        target,
        generation,
        new Date(this.currentDate().getTime() + CONNECTION_OBSERVATION_SECONDS * 1_000),
        challenge,
      )
    }

    if (target.access.trustPolicy.kind === 'trust-on-first-use'
      && !this.hasAcceptedTrust(target.machine.id, target.identity, generation)) {
      if (challenge?.requirement.kind === 'host-trust') {
        return { kind: 'blocked', requirement: challenge.requirement, challenge }
      }
      const requirement = await this.hostTrustRequirement(target.machine.id, target.access, 'HOST_KEY_REQUIRED')
      if (challenge !== undefined) {
        challenge = this.accessCoordinator.replaceConnectionRequirement({
          challengeId: challenge.id,
          expectedChallengeRevision: challenge.revision,
          requirement,
        }).challenge
      }
      return { kind: 'blocked', requirement, ...(challenge === undefined ? {} : { challenge }) }
    }

    let lease: Awaited<ReturnType<BrokerRuntime['connect']>> | undefined
    try {
      await this.broker.reconcileStatus(target.machine.id, signal)
      lease = await this.broker.connect(target.machine.id, LOCAL_OWNER_PRINCIPAL_ID)
      return this.readyConnection(target, generation, new Date(lease.expiresAt), challenge)
    } catch (error) {
      if (!(error instanceof SshConnectionError)) throw error
      const requirement = await this.connectionRequirement(target, generation, error)
      if (challenge !== undefined && challenge.requirement.kind !== requirement.kind) {
        challenge = this.accessCoordinator.replaceConnectionRequirement({
          challengeId: challenge.id,
          expectedChallengeRevision: challenge.revision,
          requirement,
        }).challenge
      } else if (challenge !== undefined
        && challenge.requirement.kind === 'reconnect'
        && requirement.kind === 'reconnect'
        && challenge.requirement.lastObservationId !== requirement.lastObservationId) {
        challenge = this.accessCoordinator.replaceConnectionRequirement({
          challengeId: challenge.id,
          expectedChallengeRevision: challenge.revision,
          requirement,
        }).challenge
      } else if (challenge !== undefined
        && challenge.requirement.kind === 'authentication'
        && requirement.kind === 'authentication') {
        // The provider cannot reconstruct the durable authFlowId attached by
        // AccessCoordinator. Both requirements describe the same blocker.
      } else if (challenge !== undefined
        && canonicalSha256(challenge.requirement) !== canonicalSha256(requirement)) {
        throw new AccessConflictError('The live access requirement changed while its challenge was pending.')
      }
      return {
        kind: 'blocked',
        requirement: challenge?.requirement ?? requirement,
        ...(challenge === undefined ? {} : { challenge }),
      }
    } finally {
      if (lease !== undefined) await this.broker.release(lease.id, LOCAL_OWNER_PRINCIPAL_ID)
    }
  }

  private readyConnection(
    target: MaterializedTarget,
    generation: Revision,
    expiresAtInput: Date,
    challenge?: AccessChallenge,
  ): RuntimeConnectionAttempt {
    const now = this.currentDate()
    const expiresAt = expiresAtInput.getTime() > now.getTime()
      ? expiresAtInput
      : new Date(now.getTime() + 1_000)
    const observation = this.accessCoordinator.recordReadyObservation({
      machineId: target.machine.id,
      expectedMachineRevision: target.machine.revision,
      expectedAccessProfileRevision: target.access.revision,
      generation,
      connectedAt: toInstant(now),
      expiresAt: toInstant(expiresAt),
    })
    if (challenge !== undefined && challenge.lifecycle.state === 'pending') {
      this.pendingConnectionCalls.resolveChallenge({
        challengeId: challenge.id,
        expectedChallengeRevision: challenge.revision,
        readyObservationId: observation.id,
      })
    }
    return { kind: 'ready', observation }
  }

  private async connectionRequirement(
    target: MaterializedTarget,
    generation: Revision,
    error: SshConnectionError,
  ): Promise<AccessChallenge['requirement']> {
    if (target.access.kind !== 'ssh') throw new AccessConflictError('Local access cannot produce an SSH blocker.')
    const observation = this.accessCoordinator.recordDisconnectedObservation({
      machineId: target.machine.id,
      expectedMachineRevision: target.machine.revision,
      expectedAccessProfileRevision: target.access.revision,
      generation,
      reason: error.message,
      retryable: true,
    })
    if (error.code === 'HOST_KEY_REQUIRED' || error.code === 'HOST_KEY_CHANGED') {
      return await this.hostTrustRequirement(target.machine.id, target.access, error.code)
    }
    if (error.code === 'AUTH_REQUIRED') {
      if (target.access.trustPolicy.kind === 'trust-on-first-use'
        && !this.hasAcceptedTrust(target.machine.id, target.identity, generation)) {
        return await this.hostTrustRequirement(target.machine.id, target.access, 'HOST_KEY_REQUIRED')
      }
      return { kind: 'authentication' }
    }
    return { kind: 'reconnect', lastObservationId: observation.id, reason: error.message }
  }

  private async hostTrustRequirement(
    machineId: MachineId,
    access: Extract<AccessProfile, { readonly kind: 'ssh' }>,
    code: 'HOST_KEY_REQUIRED' | 'HOST_KEY_CHANGED',
  ): Promise<Extract<AccessChallenge['requirement'], { readonly kind: 'host-trust' }>> {
    const inspected = await this.broker.inspectHostKey(machineId)
    const configuredMismatch = access.trustPolicy.kind === 'pinned'
      && !access.trustPolicy.expectedFingerprints.some(expected => expected === inspected.fingerprint)
    return {
      kind: 'host-trust',
      host: inspected.endpoint,
      algorithm: inspected.algorithm,
      fingerprint: inspected.fingerprint,
      source: access.trustPolicy.kind === 'pinned'
        ? 'configured'
        : access.trustPolicy.kind === 'user-known-hosts'
          ? 'user-known-hosts'
          : 'observed',
      change: code === 'HOST_KEY_CHANGED' || configuredMismatch ? 'changed-key' : 'first-use',
    }
  }

  private async installAcceptedHostKey(challenge: AccessChallenge, fingerprint: string): Promise<void> {
    const target = this.loadTarget(challenge.machineId)
    if (target.identity !== challenge.connectionIdentityDigest
      || target.access.revision !== challenge.generation
      || target.access.kind !== 'ssh') {
      throw new AccessConflictError('Machine access changed while host trust review was open.')
    }
    if (target.access.trustPolicy.kind === 'pinned'
      && !target.access.trustPolicy.expectedFingerprints.some(expected => expected === fingerprint)) {
      throw new AccessConflictError('The observed fingerprint conflicts with the configured pin; update the AccessProfile before reconnecting.')
    }
    const inspected = await this.broker.inspectHostKey(challenge.machineId)
    if (inspected.fingerprint !== fingerprint) {
      throw new AccessConflictError('The endpoint fingerprint changed while trust review was open.')
    }
    await persistPinnedKnownHost(
      this.trustOverrides.getKnownHostsPath(challenge.machineId),
      inspected.knownHostLine,
      inspected.fingerprint,
      [fingerprint],
    )
  }

  private loadTarget(
    machineIdInput: MachineId,
    expectedMachineRevision?: Revision,
    expectedAccessProfileRevision?: Revision,
  ): MaterializedTarget {
    const machineId = machineIdSchema.parse(machineIdInput)
    const machineRecord = this.authority.get(
      LOCAL_OWNER_PRINCIPAL_ID,
      EXECUTION_AUTHORITY_DOMAINS.machine,
      machineId,
    )
    if (machineRecord === undefined) throw new AccessNotFoundError(`Machine '${machineId}' does not exist.`)
    const machine = redesignMachineSchema.parse(machineRecord.value)
    if (machineRecord.revision !== machine.revision || machine.lifecycle !== 'active') {
      throw new AccessConflictError('Machine authority is stale or archived.')
    }
    if (expectedMachineRevision !== undefined && machine.revision !== expectedMachineRevision) {
      throw new AccessConflictError('Machine revision changed before the connection attempt.')
    }
    const accessRecord = this.authority.get(
      LOCAL_OWNER_PRINCIPAL_ID,
      EXECUTION_AUTHORITY_DOMAINS.accessProfile,
      machine.accessProfileId,
    )
    if (accessRecord === undefined) throw new AccessNotFoundError('Machine AccessProfile does not exist.')
    const access = accessProfileSchema.parse(accessRecord.value)
    if (accessRecord.revision !== access.revision) throw new AccessConflictError('AccessProfile authority is stale.')
    if (expectedAccessProfileRevision !== undefined && access.revision !== expectedAccessProfileRevision) {
      throw new AccessConflictError('AccessProfile revision changed before the connection attempt.')
    }
    return { machine, access, identity: connectionIdentityDigestFor(machine, access) }
  }

  private activeChallenge(machineId: MachineId, identity: Sha256, generation: Revision): AccessChallenge | undefined {
    const matches = this.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'access-challenge', 500)
      .map(record => {
        const challenge = accessChallengeSchema.parse(record.value)
        if (record.revision !== challenge.revision) {
          throw new AccessConflictError('AccessChallenge authority revision is inconsistent.')
        }
        return challenge
      })
      .filter(challenge => challenge.machineId === machineId
        && challenge.connectionIdentityDigest === identity
        && challenge.generation === generation
        && challenge.lifecycle.state === 'pending'
        && Date.parse(challenge.expiresAt) > this.currentDate().getTime())
    if (matches.length > 1) {
      throw new AccessConflictError('More than one active AccessChallenge exists for this connection generation.')
    }
    return matches[0]
  }

  private requireChallenge(idInput: string, expectedRevision?: Revision): AccessChallenge {
    const id = accessChallengeIdSchema.parse(idInput)
    const record = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, 'access-challenge', id)
    if (record === undefined) throw new AccessNotFoundError(`AccessChallenge '${id}' does not exist.`)
    const challenge = accessChallengeSchema.parse(record.value)
    if (record.revision !== challenge.revision
      || (expectedRevision !== undefined && challenge.revision !== expectedRevision)) {
      throw new AccessConflictError('AccessChallenge revision changed.')
    }
    return challenge
  }

  private hasAcceptedTrust(machineId: MachineId, identity: Sha256, generation: Revision): boolean {
    return this.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'host-trust-decision', 500)
      .map(record => hostTrustDecisionSchema.parse(record.value))
      .some(decision => {
        if (decision.decision === 'reject') return false
        const challengeRecord = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, 'access-challenge', decision.challengeId)
        if (challengeRecord === undefined) return false
        const challenge = accessChallengeSchema.parse(challengeRecord.value)
        return challenge.machineId === machineId
          && challenge.connectionIdentityDigest === identity
          && challenge.generation === generation
          && decision.challengeRevision < challenge.revision
      })
  }

  private authenticationResult(
    binding: AuthenticationBinding,
    coordinator: AuthFlowResult,
  ): AuthenticationStartResult {
    return {
      scope: 'machine',
      authFlowId: binding.authFlowId,
      carrierFlowId: binding.carrierFlowId,
      challenge: coordinator.challenge,
      expiresAt: binding.expiresAt,
      coordinator,
    }
  }

  private currentDate(): Date {
    const value = this.now()
    if (Number.isNaN(value.getTime())) throw new Error('Connection runtime clock returned an invalid date.')
    return new Date(value.getTime())
  }
}
