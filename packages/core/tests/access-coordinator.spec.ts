import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AccessCoordinator,
  AccessConflictError,
  AccessOrderingError,
  AuthAttachmentConflictError,
  type RequireConnectionResult,
} from '../src/access-coordinator.ts'
import { LOCAL_OWNER_PRINCIPAL_ID, RelationalAuthority } from '../src/authority.ts'
import { createUuidV7 } from '../src/canonical.ts'
import { accessProfileSchema, machineSchema, type AccessProfile, type Machine } from '../src/domain/inventory.ts'
import {
  ConnectionCallCancelledError,
  ConnectionCallStaleError,
  ConnectionCallUnavailableError,
  PendingConnectionCallAdapter,
} from '../src/pending-connection-call-adapter.ts'
import { jsonValueSchema } from '../src/schemas.ts'
import {
  accessProfileIdSchema,
  machineIdSchema,
  toInstant,
} from '../src/primitives.ts'

const roots: string[] = []
const stores: RelationalAuthority[] = []

interface TargetFixture {
  readonly productHome: string
  readonly authority: RelationalAuthority
  readonly coordinator: AccessCoordinator
  readonly machine: Machine
  readonly accessProfile: AccessProfile
  readonly clock: { now: Date }
}

async function targetFixture(options: {
  readonly attachmentLeaseTtlMs?: number
  readonly trustPolicy?: Extract<AccessProfile, { readonly kind: 'ssh' }>['trustPolicy']
} = {}): Promise<TargetFixture> {
  const root = await mkdtemp(join(tmpdir(), 'slop-access-coordinator-'))
  roots.push(root)
  const productHome = join(root, 'product-home')
  const authority = await RelationalAuthority.open(productHome)
  stores.push(authority)
  const clock = { now: new Date('2026-08-25T16:00:00.000Z') }
  const accessProfile = accessProfileSchema.parse({
    schemaVersion: 1,
    id: accessProfileIdSchema.parse(createUuidV7()),
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    kind: 'ssh',
    target: { kind: 'endpoint', host: 'Compute.Example.ORG', user: 'alice', port: 22 },
    controlOwnership: 'app-managed',
    trustPolicy: options.trustPolicy ?? { kind: 'trust-on-first-use' },
    authentication: { kind: 'interactive' },
    timeouts: { connectSeconds: 30, keepaliveSeconds: 30, keepaliveMisses: 3, idleSeconds: 600 },
    revision: 1,
    createdAt: toInstant(clock.now),
    updatedAt: toInstant(clock.now),
  })
  const machine = machineSchema.parse({
    schemaVersion: 1,
    id: machineIdSchema.parse(createUuidV7()),
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    accessProfileId: accessProfile.id,
    name: 'Research cluster',
    declaredRoots: [],
    revision: 1,
    lifecycle: 'active',
    createdAt: toInstant(clock.now),
    updatedAt: toInstant(clock.now),
  })
  authority.transact({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    mutations: [
      { kind: 'insert', domain: 'access-profile', id: accessProfile.id, value: jsonValueSchema.parse(accessProfile) },
      { kind: 'insert', domain: 'machine', id: machine.id, value: jsonValueSchema.parse(machine) },
    ],
  })
  return {
    productHome,
    authority,
    coordinator: new AccessCoordinator(authority, {
      now: () => clock.now,
      ...(options.attachmentLeaseTtlMs === undefined ? {} : { attachmentLeaseTtlMs: options.attachmentLeaseTtlMs }),
    }),
    machine,
    accessProfile,
    clock,
  }
}

function blocked(result: RequireConnectionResult): Extract<RequireConnectionResult, { readonly kind: 'blocked' }> {
  if (result.kind !== 'blocked') throw new Error('Expected a blocked connection result.')
  return result
}

function ready(result: RequireConnectionResult): Extract<RequireConnectionResult, { readonly kind: 'ready' }> {
  if (result.kind !== 'ready') throw new Error('Expected a ready connection result.')
  return result
}

function hostTrustRequirement() {
  return {
    kind: 'host-trust' as const,
    host: 'compute.example.org',
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:YWJjZA==',
    source: 'observed' as const,
    change: 'first-use' as const,
  }
}

function requestFor(
  fixture: TargetFixture,
  toolCallId: string,
  sessionId: string,
  agentId: string,
  purpose: 'remote-read' | 'file-transfer',
) {
  return {
    toolCallId,
    sessionId,
    agentId,
    machineId: fixture.machine.id,
    expectedMachineRevision: fixture.machine.revision,
    expectedAccessProfileRevision: fixture.accessProfile.revision,
    generation: 1,
    purpose,
    requirement: hostTrustRequirement(),
  }
}

async function authenticationFlow(fixture: TargetFixture) {
  const waiting = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-auth', 'session-auth', 'agent-auth', 'remote-read')))
  const trusted = fixture.coordinator.decideHostTrust({
    challengeId: waiting.challenge.id,
    expectedChallengeRevision: waiting.challenge.revision,
    decision: 'trust-once',
    fingerprint: hostTrustRequirement().fingerprint,
  })
  return fixture.coordinator.startAuthFlow({
    challengeId: trusted.challenge.id,
    expectedChallengeRevision: trusted.challenge.revision,
  })
}

function requireOnly<Value>(values: readonly Value[], label: string): Value {
  const value = values[0]
  if (value === undefined || values.length !== 1) throw new Error(`Expected exactly one ${label}.`)
  return value
}

function resolveAdapterChallenge(fixture: TargetFixture, adapter: PendingConnectionCallAdapter) {
  const waiterId = requireOnly(adapter.pendingWaiterIds(), 'pending waiter id')
  const waiter = fixture.coordinator.getWaiter(waiterId)
  if (waiter === undefined) throw new Error('Pending waiter is missing from authority.')
  const challenge = fixture.coordinator.getChallenge(waiter.challengeId)
  if (challenge === undefined) throw new Error('Pending challenge is missing from authority.')
  const trusted = fixture.coordinator.decideHostTrust({
    challengeId: challenge.id,
    expectedChallengeRevision: challenge.revision,
    decision: 'trust-once',
    fingerprint: hostTrustRequirement().fingerprint,
  })
  const started = fixture.coordinator.startAuthFlow({
    challengeId: trusted.challenge.id,
    expectedChallengeRevision: trusted.challenge.revision,
  })
  const observation = fixture.coordinator.recordReadyObservation({
    machineId: fixture.machine.id,
    expectedMachineRevision: fixture.machine.revision,
    expectedAccessProfileRevision: fixture.accessProfile.revision,
    generation: 1,
    expiresAt: toInstant(new Date(fixture.clock.now.getTime() + 5 * 60_000)),
  })
  return adapter.resolveChallenge({
    challengeId: started.challenge.id,
    expectedChallengeRevision: started.challenge.revision,
    readyObservationId: observation.id,
  })
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async store => { await store.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('redesign AccessCoordinator', () => {
  it('does not reuse a ready observation after a newer disconnect', async () => {
    const fixture = await targetFixture()
    fixture.coordinator.recordReadyObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      expiresAt: toInstant(new Date(fixture.clock.now.getTime() + 5 * 60_000)),
    })
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 1_000)
    const disconnected = fixture.coordinator.recordDisconnectedObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      reason: 'The reusable SSH master is no longer available.',
      retryable: true,
    })

    const result = blocked(fixture.coordinator.requireConnection({
      ...requestFor(fixture, 'tool-transfer', 'session-transfer', 'agent-transfer', 'file-transfer'),
      requirement: {
        kind: 'reconnect',
        lastObservationId: disconnected.id,
        reason: disconnected.reason,
      },
    }))

    expect(result.challenge.requirement).toEqual({
      kind: 'reconnect',
      lastObservationId: disconnected.id,
      reason: disconnected.reason,
    })
  })

  // 500 authority writes take about 1 s on Linux and over 5 s on Windows runners.
  it('finds a current ready observation beyond the first authority page', async () => {
    const fixture = await targetFixture({ trustPolicy: { kind: 'user-known-hosts' } })
    for (let index = 0; index < 500; index += 1) {
      fixture.coordinator.recordDisconnectedObservation({
        machineId: fixture.machine.id,
        expectedMachineRevision: fixture.machine.revision,
        expectedAccessProfileRevision: fixture.accessProfile.revision,
        generation: 1,
        reason: `Historical disconnect ${String(index)}`,
        retryable: true,
      })
    }
    await new Promise(resolve => setTimeout(resolve, 2))
    fixture.coordinator.recordReadyObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      expiresAt: toInstant(new Date(fixture.clock.now.getTime() + 5 * 60_000)),
    })

    expect(ready(fixture.coordinator.requireConnection(requestFor(
      fixture,
      'tool-after-page',
      'session-after-page',
      'agent-after-page',
      'remote-read',
    ))).lease.machineId).toBe(fixture.machine.id)
  }, 30_000)

  it('records a real disconnected observation and narrowly advances causal blockers without replacing waiters', async () => {
    const fixture = await targetFixture({ trustPolicy: { kind: 'user-known-hosts' } })
    const disconnected = fixture.coordinator.recordDisconnectedObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      reason: 'The provider is unreachable.',
      retryable: true,
    })
    const waiting = blocked(fixture.coordinator.requireConnection({
      ...requestFor(fixture, 'tool-causal', 'session-causal', 'agent-causal', 'remote-read'),
      requirement: {
        kind: 'reconnect',
        lastObservationId: disconnected.id,
        reason: disconnected.reason,
      },
    }))
    const waiterIds = waiting.challenge.waiterIds
    const advanced = fixture.coordinator.replaceConnectionRequirement({
      challengeId: waiting.challenge.id,
      expectedChallengeRevision: waiting.challenge.revision,
      requirement: { kind: 'authentication' },
    })

    expect(advanced.challenge.requirement).toEqual({ kind: 'authentication' })
    expect(advanced.challenge.waiterIds).toEqual(waiterIds)
    expect(fixture.coordinator.getWaiter(waiterIds[0]!)).toBeDefined()
    expect(() => fixture.coordinator.replaceConnectionRequirement({
      challengeId: advanced.challenge.id,
      expectedChallengeRevision: advanced.challenge.revision,
      requirement: { kind: 'authentication' },
    })).toThrow(AccessOrderingError)

    const authentication = blocked(fixture.coordinator.requireConnection({
      ...requestFor(fixture, 'tool-auth-regression', 'session-causal', 'agent-causal', 'remote-read'),
      generation: 2,
      requirement: { kind: 'authentication' },
    }))
    const changedKey = fixture.coordinator.replaceConnectionRequirement({
      challengeId: authentication.challenge.id,
      expectedChallengeRevision: authentication.challenge.revision,
      requirement: hostTrustRequirement(),
    })
    expect(changedKey.challenge.requirement).toEqual(hostTrustRequirement())
    expect(() => fixture.coordinator.replaceConnectionRequirement({
      challengeId: changedKey.challenge.id,
      expectedChallengeRevision: changedKey.challenge.revision,
      requirement: {
        kind: 'reconnect',
        lastObservationId: disconnected.id,
        reason: disconnected.reason,
      },
    })).toThrow(AccessOrderingError)
  })

  it('accepts configured OpenSSH trust as the prerequisite for an authentication challenge', async () => {
    const fixture = await targetFixture({ trustPolicy: { kind: 'user-known-hosts' } })
    const waiting = blocked(fixture.coordinator.requireConnection({
      ...requestFor(fixture, 'configured-trust', 'session-a', 'agent-a', 'remote-read'),
      requirement: { kind: 'authentication' },
    }))

    expect(waiting.challenge.requirement).toEqual({ kind: 'authentication' })
    const started = fixture.coordinator.startAuthFlow({
      challengeId: waiting.challenge.id,
      expectedChallengeRevision: waiting.challenge.revision,
    })
    expect(started.challenge.revision).toBe(waiting.challenge.revision + 1)
    expect(started.presentation).toMatchObject({
      connection: {
        state: 'blocked',
        challenge: { kind: 'authentication', authentication: { flowState: 'waiting-attachment', writableAttachment: false } },
      },
      actions: ['retry-carrier', 'cancel-session-wait'],
    })
  })

  it('resolves the principal internally, enforces host trust first, and shares one challenge across durable waiters', async () => {
    const fixture = await targetFixture()
    expect(() => fixture.coordinator.requireConnection({
      ...requestFor(fixture, 'caller-principal', 'session-a', 'agent-a', 'remote-read'),
      principalId: 'local-owner',
    })).toThrow()
    expect(() => fixture.coordinator.requireConnection({
      ...requestFor(fixture, 'auth-before-trust', 'session-a', 'agent-a', 'remote-read'),
      requirement: { kind: 'authentication' },
    })).toThrow(AccessOrderingError)
    expect(fixture.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'access-challenge')).toEqual([])

    const first = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-a', 'session-a', 'agent-a', 'remote-read')))
    const second = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-b', 'session-b', 'agent-b', 'remote-read')))
    expect(second.challenge.id).toBe(first.challenge.id)
    expect(second.waiter.id).not.toBe(first.waiter.id)
    expect(second.challenge.waiterIds).toEqual([first.waiter.id, second.waiter.id])
    expect(second.presentation.waitingSessionCount).toBe(2)
    expect(fixture.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'access-challenge')).toHaveLength(1)
    expect(fixture.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'connection-waiter')).toHaveLength(2)
    expect(new Set(fixture.authority.feed({ principalId: LOCAL_OWNER_PRINCIPAL_ID }).map(event => event.projection))).toEqual(new Set(['machine-connection']))
  })

  it('aborting one waiter preserves the other waiter, shared challenge, and AuthFlow', async () => {
    const fixture = await targetFixture()
    const abort = new AbortController()
    const first = blocked(fixture.coordinator.requireConnection(
      requestFor(fixture, 'tool-abort', 'session-abort', 'agent-a', 'remote-read'),
      abort.signal,
    ))
    const second = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-stay', 'session-stay', 'agent-b', 'remote-read')))
    const trusted = fixture.coordinator.decideHostTrust({
      challengeId: second.challenge.id,
      expectedChallengeRevision: second.challenge.revision,
      decision: 'trust-once',
      fingerprint: hostTrustRequirement().fingerprint,
    })
    const started = fixture.coordinator.startAuthFlow({
      challengeId: trusted.challenge.id,
      expectedChallengeRevision: trusted.challenge.revision,
    })

    abort.abort()

    expect(fixture.coordinator.getWaiter(first.waiter.id)).toBeUndefined()
    expect(fixture.coordinator.getWaiter(second.waiter.id)).toEqual(second.waiter)
    expect(fixture.coordinator.getAuthFlow(started.flow.id)).toEqual(started.flow)
    expect(fixture.coordinator.getChallenge(started.challenge.id)?.waiterIds).toEqual([second.waiter.id])
    const presentation = fixture.authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID }).values[0]?.value
    expect(presentation).toMatchObject({ waitingSessionCount: 1, connection: { state: 'blocked' } })
  })

  it('revalidates dependencies and resumes two waiters with independent leases that survive restart', async () => {
    const fixture = await targetFixture()
    const first = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-one', 'session-one', 'agent-one', 'remote-read')))
    const second = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-two', 'session-two', 'agent-two', 'remote-read')))
    const trusted = fixture.coordinator.decideHostTrust({
      challengeId: second.challenge.id,
      expectedChallengeRevision: second.challenge.revision,
      decision: 'trust-and-pin',
      fingerprint: hostTrustRequirement().fingerprint,
    })
    const started = fixture.coordinator.startAuthFlow({
      challengeId: trusted.challenge.id,
      expectedChallengeRevision: trusted.challenge.revision,
    })
    const observation = fixture.coordinator.recordReadyObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      expiresAt: toInstant(new Date(fixture.clock.now.getTime() + 5 * 60_000)),
    })
    const resolved = fixture.coordinator.resolveChallenge({
      challengeId: started.challenge.id,
      expectedChallengeRevision: started.challenge.revision,
      readyObservationId: observation.id,
    })

    expect(resolved.leases).toHaveLength(2)
    expect(new Set(resolved.leases.map(lease => lease.id)).size).toBe(2)
    expect(resolved.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ waiterId: first.waiter.id, sessionId: 'session-one', agentId: 'agent-one', purpose: 'remote-read' }),
      expect.objectContaining({ waiterId: second.waiter.id, sessionId: 'session-two', agentId: 'agent-two', purpose: 'remote-read' }),
    ]))
    expect(fixture.coordinator.getWaiter(first.waiter.id)).toBeUndefined()
    expect(fixture.coordinator.getWaiter(second.waiter.id)).toBeUndefined()
    expect(resolved.presentation.connection.state).toBe('ready')
    const immediateOne = ready(fixture.coordinator.requireConnection(requestFor(
      fixture,
      'tool-ready-one',
      'session-ready-one',
      'agent-ready-one',
      'remote-read',
    )))
    const immediateTwo = ready(fixture.coordinator.requireConnection(requestFor(
      fixture,
      'tool-ready-two',
      'session-ready-two',
      'agent-ready-two',
      'remote-read',
    )))
    expect(immediateTwo.lease.id).not.toBe(immediateOne.lease.id)
    expect(immediateOne.lease).toMatchObject({ sessionId: 'session-ready-one', agentId: 'agent-ready-one', purpose: 'remote-read' })
    expect(immediateTwo.lease).toMatchObject({ sessionId: 'session-ready-two', agentId: 'agent-ready-two', purpose: 'remote-read' })

    await fixture.authority.close()
    const reopened = await RelationalAuthority.open(fixture.productHome)
    stores.push(reopened)
    const coordinator = new AccessCoordinator(reopened, { now: () => fixture.clock.now })
    expect(coordinator.connectionLeaseForWaiter(first.waiter.id)).toEqual(
      expect.objectContaining({ sessionId: 'session-one', agentId: 'agent-one', purpose: 'remote-read' }),
    )
    expect(coordinator.connectionLeaseForWaiter(second.waiter.id)).toEqual(
      expect.objectContaining({ sessionId: 'session-two', agentId: 'agent-two', purpose: 'remote-read' }),
    )
    expect(coordinator.getChallenge(started.challenge.id)?.lifecycle.state).toBe('resolved')
  })

  it('refuses challenge resolution after a Machine revision changes and leaves the waiter durable', async () => {
    const fixture = await targetFixture()
    const waiting = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'tool-stale', 'session-stale', 'agent-stale', 'remote-read')))
    const trusted = fixture.coordinator.decideHostTrust({
      challengeId: waiting.challenge.id,
      expectedChallengeRevision: waiting.challenge.revision,
      decision: 'trust-once',
      fingerprint: hostTrustRequirement().fingerprint,
    })
    const started = fixture.coordinator.startAuthFlow({
      challengeId: trusted.challenge.id,
      expectedChallengeRevision: trusted.challenge.revision,
    })
    const observation = fixture.coordinator.recordReadyObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      expiresAt: toInstant(new Date(fixture.clock.now.getTime() + 5 * 60_000)),
    })
    fixture.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{
        kind: 'replace',
        domain: 'machine',
        id: fixture.machine.id,
        expectedRevision: fixture.machine.revision,
        value: jsonValueSchema.parse({ ...fixture.machine, name: 'Renamed cluster', revision: 2 }),
      }],
    })

    expect(() => fixture.coordinator.resolveChallenge({
      challengeId: started.challenge.id,
      expectedChallengeRevision: started.challenge.revision,
      readyObservationId: observation.id,
    })).toThrow(AccessConflictError)
    expect(fixture.coordinator.getWaiter(waiting.waiter.id)).toEqual(waiting.waiter)
    expect(fixture.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'connection-lease')).toEqual([])
  })

  it('enforces one writable attachment across restart, then permits release and expiry replacement', async () => {
    const fixture = await targetFixture({ attachmentLeaseTtlMs: 1_000 })
    const started = await authenticationFlow(fixture)
    const first = fixture.coordinator.acquireAuthAttachment({ authFlowId: started.flow.id, attachmentId: 'browser-a' })

    await fixture.authority.close()
    const reopened = await RelationalAuthority.open(fixture.productHome)
    stores.push(reopened)
    const coordinator = new AccessCoordinator(reopened, { now: () => fixture.clock.now, attachmentLeaseTtlMs: 1_000 })
    expect(() => coordinator.acquireAuthAttachment({ authFlowId: started.flow.id, attachmentId: 'browser-b' }))
      .toThrow(AuthAttachmentConflictError)

    const released = coordinator.releaseAuthAttachment({ leaseId: first.lease.id })
    expect(released.lease.state).toBe('released')
    const second = coordinator.acquireAuthAttachment({ authFlowId: started.flow.id, attachmentId: 'browser-b' })
    expect(second.lease.state).toBe('active')
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 1_001)
    const third = coordinator.acquireAuthAttachment({ authFlowId: started.flow.id, attachmentId: 'browser-c' })
    expect(third.lease.state).toBe('active')
    expect(coordinator.getAuthAttachmentLease(second.lease.id)?.state).toBe('expired')

    expect(() => coordinator.observeAuthPrompt({
      authFlowId: started.flow.id,
      state: 'observed',
      promptKind: 'password',
      promptText: 'Password: do-not-store-this',
    })).toThrow()
    const serializedFeed = JSON.stringify(reopened.feed({ principalId: LOCAL_OWNER_PRINCIPAL_ID }))
    expect(serializedFeed).not.toContain('do-not-store-this')
    expect(new Set(reopened.feed({ principalId: LOCAL_OWNER_PRINCIPAL_ID }).map(event => event.projection))).toEqual(new Set(['machine-connection']))
  })
})

describe('pending connection call adapter', () => {
  it.each([false, true])('retires an orphaned legacy challenge on restart (expired: %s)', async expired => {
    const fixture = await targetFixture()
    const waiting = blocked(fixture.coordinator.requireConnection(requestFor(fixture, 'legacy-tool', 'legacy-chat', 'legacy-agent', 'remote-read')))
    // Earlier Hosts removed the waiter at shutdown without settling its challenge/projection.
    fixture.authority.transact({ principalId: LOCAL_OWNER_PRINCIPAL_ID, mutations: [{
      kind: 'remove', domain: 'connection-waiter', id: waiting.waiter.id, expectedRevision: 1,
    }] })
    if (expired) fixture.clock.now = new Date(Date.parse(waiting.challenge.expiresAt) + 1)
    const adapter = new PendingConnectionCallAdapter(fixture.coordinator)
    expect(adapter.settleRestartRecoveredWaiters()).toEqual([])
    expect(fixture.coordinator.getChallenge(waiting.challenge.id)).toMatchObject({
      lifecycle: { state: expired ? 'expired' : 'cancelled' }, waiterIds: [],
    })
    const baseline = fixture.authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID })
    expect(baseline.values[0]?.value).toMatchObject({ connection: { state: 'disconnected' }, actions: ['open-machine-settings'] })
    adapter.settleRestartRecoveredWaiters()
    expect(fixture.authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID }).asOfCursor).toBe(baseline.asOfCursor)
  })

  it('settles an expired suspended call without another access request and retires its sign-in actions', async () => {
    const fixture = await targetFixture()
    vi.useFakeTimers()
    const adapter = new PendingConnectionCallAdapter(fixture.coordinator)
    try {
      const call = adapter.requireConnection(requestFor(fixture, 'tool-expire', 'session-expire', 'agent-expire', 'remote-read'))
      const rejected = expect(call).rejects.toBeInstanceOf(ConnectionCallStaleError)
      const waiter = fixture.coordinator.pendingWaiters()[0]!
      fixture.clock.now = new Date(Date.parse(waiter.expiresAt) + 1)
      await vi.advanceTimersByTimeAsync(1_000)
      await rejected
      expect(adapter.pendingWaiterIds()).toEqual([])
      expect(fixture.coordinator.getChallenge(waiter.challengeId)?.lifecycle.state).toBe('expired')
      expect(fixture.authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID }).values[0]?.value).toMatchObject({
        connection: { state: 'disconnected', reason: 'Sign-in expired. Connect again in this Chat.' },
        waitingSessionCount: 0,
        actions: ['open-machine-settings'],
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      adapter.settleUnavailable()
      vi.useRealTimers()
    }
  })
  it('keeps the exact connection call pending and resumes it only after challenge resolution', async () => {
    const fixture = await targetFixture()
    const adapter = new PendingConnectionCallAdapter(fixture.coordinator)
    let settled = false
    const call = adapter.requireConnection(requestFor(fixture, 'tool-same-call', 'session-same-call', 'agent-same-call', 'remote-read'))
    void call.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(adapter.pendingWaiterIds()).toHaveLength(1)

    const resolution = resolveAdapterChallenge(fixture, adapter)
    const result = await call

    expect(result.kind).toBe('ready')
    expect(result.lease).toEqual(resolution.leases[0])
    expect(result.lease).toMatchObject({ sessionId: 'session-same-call', agentId: 'agent-same-call', purpose: 'remote-read' })
    expect(adapter.pendingWaiterIds()).toEqual([])
  })

  it('resumes two calls sharing one challenge with separately scoped leases', async () => {
    const fixture = await targetFixture()
    const adapter = new PendingConnectionCallAdapter(fixture.coordinator)
    const firstCall = adapter.requireConnection(requestFor(fixture, 'tool-adapter-a', 'session-adapter-a', 'agent-adapter-a', 'remote-read'))
    const secondCall = adapter.requireConnection(requestFor(fixture, 'tool-adapter-b', 'session-adapter-b', 'agent-adapter-b', 'remote-read'))
    const waiterIds = adapter.pendingWaiterIds()
    expect(waiterIds).toHaveLength(2)
    const firstWaiterId = waiterIds[0]
    const secondWaiterId = waiterIds[1]
    if (firstWaiterId === undefined || secondWaiterId === undefined) throw new Error('Expected two pending waiter ids.')
    const firstWaiter = fixture.coordinator.getWaiter(firstWaiterId)
    const secondWaiter = fixture.coordinator.getWaiter(secondWaiterId)
    expect(firstWaiter?.challengeId).toBe(secondWaiter?.challengeId)

    const challenge = firstWaiter === undefined ? undefined : fixture.coordinator.getChallenge(firstWaiter.challengeId)
    if (challenge === undefined) throw new Error('Shared challenge is missing.')
    const trusted = fixture.coordinator.decideHostTrust({
      challengeId: challenge.id,
      expectedChallengeRevision: challenge.revision,
      decision: 'trust-once',
      fingerprint: hostTrustRequirement().fingerprint,
    })
    const started = fixture.coordinator.startAuthFlow({
      challengeId: trusted.challenge.id,
      expectedChallengeRevision: trusted.challenge.revision,
    })
    const observation = fixture.coordinator.recordReadyObservation({
      machineId: fixture.machine.id,
      expectedMachineRevision: fixture.machine.revision,
      expectedAccessProfileRevision: fixture.accessProfile.revision,
      generation: 1,
      expiresAt: toInstant(new Date(fixture.clock.now.getTime() + 5 * 60_000)),
    })
    adapter.resolveChallenge({
      challengeId: started.challenge.id,
      expectedChallengeRevision: started.challenge.revision,
      readyObservationId: observation.id,
    })
    const [first, second] = await Promise.all([firstCall, secondCall])

    expect(first.lease.id).not.toBe(second.lease.id)
    expect(first.lease).toMatchObject({ sessionId: 'session-adapter-a', agentId: 'agent-adapter-a', purpose: 'remote-read' })
    expect(second.lease).toMatchObject({ sessionId: 'session-adapter-b', agentId: 'agent-adapter-b', purpose: 'remote-read' })
  })

  it('aborts only one pending call and lets the other call continue', async () => {
    const fixture = await targetFixture()
    const adapter = new PendingConnectionCallAdapter(fixture.coordinator)
    const controller = new AbortController()
    const cancelledCall = adapter.requireConnection(
      requestFor(fixture, 'tool-cancel-one', 'session-cancel-one', 'agent-cancel-one', 'remote-read'),
      controller.signal,
    )
    const continuingCall = adapter.requireConnection(requestFor(
      fixture,
      'tool-continue-one',
      'session-continue-one',
      'agent-continue-one',
      'remote-read',
    ))
    const cancelled = expect(cancelledCall).rejects.toBeInstanceOf(ConnectionCallCancelledError)

    controller.abort()

    await cancelled
    expect(adapter.pendingWaiterIds()).toHaveLength(1)
    const resolution = resolveAdapterChallenge(fixture, adapter)
    const continued = await continuingCall
    expect(resolution.leases).toHaveLength(1)
    expect(continued.lease).toMatchObject({ sessionId: 'session-continue-one', purpose: 'remote-read' })
  })

  it('rejects a live pending call with a typed stale error when dependencies change', async () => {
    const fixture = await targetFixture()
    const adapter = new PendingConnectionCallAdapter(fixture.coordinator)
    const call = adapter.requireConnection(requestFor(fixture, 'tool-stale-adapter', 'session-stale-adapter', 'agent-stale-adapter', 'remote-read'))
    const rejected = expect(call).rejects.toBeInstanceOf(ConnectionCallStaleError)
    fixture.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{
        kind: 'replace',
        domain: 'machine',
        id: fixture.machine.id,
        expectedRevision: fixture.machine.revision,
        value: jsonValueSchema.parse({ ...fixture.machine, name: 'Changed while waiting', revision: 2 }),
      }],
    })

    expect(adapter.settleStaleCalls()).toEqual([
      expect.objectContaining({ code: 'STALE' }),
    ])
    await rejected
    expect(adapter.pendingWaiterIds()).toEqual([])
    expect(fixture.authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'connection-waiter')).toEqual([])
  })

  it('settles restart-recovered durable waiters with typed unavailable outcomes', async () => {
    const fixture = await targetFixture()
    const waiting = blocked(fixture.coordinator.requireConnection(requestFor(
      fixture,
      'tool-before-restart',
      'session-before-restart',
      'agent-before-restart',
      'remote-read',
    )))
    await fixture.authority.close()
    const reopened = await RelationalAuthority.open(fixture.productHome)
    stores.push(reopened)
    const coordinator = new AccessCoordinator(reopened, { now: () => fixture.clock.now })
    const adapter = new PendingConnectionCallAdapter(coordinator)

    const settlements = adapter.settleRestartRecoveredWaiters()

    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toMatchObject({
      kind: 'failed',
      waiter: { id: waiting.waiter.id, toolCallId: 'tool-before-restart' },
      error: { code: 'UNAVAILABLE', waiterId: waiting.waiter.id },
    })
    expect(settlements[0]?.error).toBeInstanceOf(ConnectionCallUnavailableError)
    expect(coordinator.getWaiter(waiting.waiter.id)).toBeUndefined()
    expect(coordinator.getChallenge(waiting.challenge.id)?.lifecycle.state).toBe('cancelled')
  })
})
