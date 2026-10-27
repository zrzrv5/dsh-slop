import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AccessCoordinator,
  LOCAL_OWNER_PRINCIPAL_ID,
  PendingConnectionCallAdapter,
  RelationalAuthority,
  accessProfileIdSchema,
  accessProfileSchema,
  agentIdSchema,
  connectionLeaseIdSchema,
  createUuidV7,
  jsonValueSchema,
  machineIdSchema,
  redesignMachineSchema,
  sessionIdSchema,
  sha256Schema,
  toInstant,
  type AccessChallenge,
  type AccessProfile,
  type RedesignMachine,
} from '@dsh-slop/core'
import {
  MachineConnectionRuntime,
  type MachineConnectionRuntimeOptions,
} from '../src/connection-runtime.ts'
import { AuthorityConnectionTrustOverrides } from '../src/connection-trust-overrides.ts'
import { SshConnectionError } from '../src/ssh-broker.ts'
import type { AuthFlowSeam } from '../src/types.ts'

const roots: string[] = []
const authorities: RelationalAuthority[] = []

interface SeededTarget {
  readonly machine: RedesignMachine
  readonly access: AccessProfile
}

type RuntimeBroker = MachineConnectionRuntimeOptions['broker']

class FakeBroker implements RuntimeBroker {
  readonly events: string[] = []
  readonly machineIds: string[] = []
  readonly connectOutcomes: (Error | 'ready')[] = []
  authState: 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired' = 'pending'

  async reconcileStatus(
    machineId: Parameters<RuntimeBroker['reconcileStatus']>[0],
  ): Promise<Awaited<ReturnType<RuntimeBroker['reconcileStatus']>>> {
    this.events.push('reconcile')
    this.machineIds.push(machineId)
    return { state: 'disconnected' }
  }

  async connect(
    machineId: Parameters<RuntimeBroker['connect']>[0],
  ): Promise<Awaited<ReturnType<RuntimeBroker['connect']>>> {
    this.events.push('connect')
    this.machineIds.push(machineId)
    const outcome = this.connectOutcomes.shift() ?? 'ready'
    if (outcome instanceof Error) throw outcome
    return {
      id: connectionLeaseIdSchema.parse(createUuidV7()),
      ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
      machineId,
      identityDigest: sha256Schema.parse('a'.repeat(64)),
      acquiredAt: toInstant(),
      expiresAt: toInstant(new Date(Date.now() + 10 * 60_000)),
    }
  }

  async release(): Promise<void> {
    this.events.push('release')
  }

  async inspectHostKey(): Promise<Awaited<ReturnType<RuntimeBroker['inspectHostKey']>>> {
    this.events.push('inspect-host-key')
    const key = Buffer.from('machine-runtime-host-key')
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
    return {
      endpoint: 'compute.example.org:22',
      algorithm: 'ssh-ed25519',
      fingerprint,
      knownHostLine: `compute.example.org ssh-ed25519 ${key.toString('base64')}\n`,
      source: 'network-scan-untrusted',
    }
  }

  async beginAuth(): Promise<Awaited<ReturnType<RuntimeBroker['beginAuth']>>> {
    this.events.push('begin-auth')
    return { flowId: createUuidV7(), expiresAt: toInstant(new Date(Date.now() + 10 * 60_000)) }
  }
}

async function fixture(): Promise<{
  readonly authority: RelationalAuthority
  readonly root: string
  readonly broker: FakeBroker
  readonly runtime: MachineConnectionRuntime
}> {
  const root = await mkdtemp(join(tmpdir(), 'slop-machine-connection-'))
  roots.push(root)
  const authority = await RelationalAuthority.open(join(root, 'authority'))
  authorities.push(authority)
  const broker = new FakeBroker()
  const accessCoordinator = new AccessCoordinator(authority)
  const pendingConnectionCalls = new PendingConnectionCallAdapter(accessCoordinator)
  const authFlows: AuthFlowSeam = {
    begin: async () => ({ flowId: createUuidV7(), expiresAt: toInstant(new Date(Date.now() + 10 * 60_000)) }),
    status: async () => ({ state: broker.authState }),
    cancel: async () => undefined,
  }
  const runtime = new MachineConnectionRuntime({
    authority,
    broker,
    authFlows,
    trustOverrides: new AuthorityConnectionTrustOverrides(authority, join(root, 'trust')),
    accessCoordinator,
    pendingConnectionCalls,
  })
  return { authority, root, broker, runtime }
}

function seedTarget(
  authority: RelationalAuthority,
  name = 'Compute',
  trustPolicy: Extract<AccessProfile, { readonly kind: 'ssh' }>['trustPolicy'] = { kind: 'user-known-hosts' },
): SeededTarget {
  const now = toInstant()
  const access = accessProfileSchema.parse({
    schemaVersion: 1,
    id: accessProfileIdSchema.parse(createUuidV7()),
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    kind: 'ssh',
    target: { kind: 'endpoint', host: `${name.toLowerCase()}.example.org`, user: 'alice', port: 22 },
    controlOwnership: 'app-managed',
    trustPolicy,
    vpn: { kind: 'none' },
    authentication: { kind: 'interactive' },
    timeouts: { connectSeconds: 30, keepaliveSeconds: 30, keepaliveMisses: 3, idleSeconds: 600 },
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const machine = redesignMachineSchema.parse({
    schemaVersion: 1,
    id: machineIdSchema.parse(createUuidV7()),
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    accessProfileId: access.id,
    name,
    declaredRoots: [],
    revision: 1,
    lifecycle: 'active',
    createdAt: now,
    updatedAt: now,
  })
  authority.transact({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    mutations: [
      { kind: 'insert', domain: 'access-profile', id: access.id, value: jsonValueSchema.parse(access) },
      { kind: 'insert', domain: 'machine', id: machine.id, value: jsonValueSchema.parse(machine) },
    ],
  })
  return { machine, access }
}

function request(target: SeededTarget, toolCallId = 'tool-connection') {
  return {
    toolCallId,
    sessionId: sessionIdSchema.parse('session-connection'),
    agentId: agentIdSchema.parse('agent-connection'),
    machineId: target.machine.id,
    expectedMachineRevision: target.machine.revision,
    expectedAccessProfileRevision: target.access.revision,
    purpose: 'remote-read' as const,
  }
}

function pendingChallenge(runtime: MachineConnectionRuntime): AccessChallenge {
  const waiterId = runtime.pendingConnectionCalls.pendingWaiterIds()[0]
  if (waiterId === undefined) throw new Error('expected one pending connection waiter')
  const waiter = runtime.accessCoordinator.getWaiter(waiterId)
  if (waiter === undefined) throw new Error('pending waiter is missing from authority')
  const challenge = runtime.accessCoordinator.getChallenge(waiter.challengeId)
  if (challenge === undefined) throw new Error('pending challenge is missing from authority')
  return challenge
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async authority => { await authority.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('MachineConnectionRuntime', () => {
  it('records a ready Machine connection and returns only its scoped logical lease', async () => {
    const { authority, broker, runtime } = await fixture()
    const target = seedTarget(authority)

    const result = await runtime.requireConnection(request(target))

    expect(result).toMatchObject({
      kind: 'ready',
      lease: {
        machineId: target.machine.id,
        machineRevision: target.machine.revision,
        accessProfileRevision: target.access.revision,
        purpose: 'remote-read',
      },
    })
    expect(broker.events).toEqual(['reconcile', 'connect', 'release'])
    expect(authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'connection-observation')).toHaveLength(1)
  })

  it('keeps the exact Chat call pending through 2FA and resumes it after broker success', async () => {
    const { authority, broker, runtime } = await fixture()
    const target = seedTarget(authority)
    broker.connectOutcomes.push(
      new SshConnectionError('AUTH_REQUIRED', 'Human authentication is required.'),
      'ready',
    )

    const pending = runtime.requireConnection(request(target))
    await nextTurn()
    const challenge = pendingChallenge(runtime)
    expect(challenge.requirement).toEqual({ kind: 'authentication' })

    const started = await runtime.startAuthentication({
      challengeId: challenge.id,
      expectedChallengeRevision: challenge.revision,
    })
    broker.authState = 'ready'

    await expect(runtime.authenticationStatus(started.authFlowId)).resolves.toEqual({ state: 'ready', resumed: true })
    await expect(pending).resolves.toMatchObject({ kind: 'ready', lease: { machineId: target.machine.id } })
    expect(runtime.pendingConnectionCalls.pendingWaiterIds()).toEqual([])
  })

  it('attaches another call to the same durable authentication challenge', async () => {
    const { authority, broker, runtime } = await fixture()
    const target = seedTarget(authority)
    broker.connectOutcomes.push(
      new SshConnectionError('AUTH_REQUIRED', 'Human authentication is required.'),
      new SshConnectionError('AUTH_REQUIRED', 'Human authentication is required.'),
    )

    const first = runtime.requireConnection(request(target, 'tool-first'))
    await nextTurn()
    const original = pendingChallenge(runtime)
    const started = await runtime.startAuthentication({
      challengeId: original.id,
      expectedChallengeRevision: original.revision,
    })
    const second = runtime.requireConnection(request(target, 'tool-second'))
    await nextTurn()

    const challengeIds = runtime.pendingConnectionCalls.pendingWaiterIds().map(waiterId => {
      const waiter = runtime.accessCoordinator.getWaiter(waiterId)
      if (waiter === undefined) throw new Error('pending waiter disappeared')
      return waiter.challengeId
    })
    expect(challengeIds).toEqual([original.id, original.id])
    expect(pendingChallenge(runtime).requirement).toEqual({
      kind: 'authentication',
      authFlowId: started.authFlowId,
    })

    runtime.close()
    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'UNAVAILABLE' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ code: 'UNAVAILABLE' }) }),
    ])
  })

  it('blocks TOFU before connect, installs the approved key, and resumes the same call', async () => {
    const { authority, broker, runtime } = await fixture()
    const target = seedTarget(authority, 'Tofu', { kind: 'trust-on-first-use' })

    const pending = runtime.requireConnection(request(target))
    await nextTurn()
    const challenge = pendingChallenge(runtime)
    if (challenge.requirement.kind !== 'host-trust') throw new Error('expected host trust challenge')
    expect(broker.events).toEqual(['inspect-host-key'])

    await runtime.decideHostTrust({
      challengeId: challenge.id,
      expectedChallengeRevision: challenge.revision,
      decision: 'trust-once',
      fingerprint: challenge.requirement.fingerprint,
    })

    await expect(pending).resolves.toMatchObject({ kind: 'ready', lease: { machineId: target.machine.id } })
    expect(broker.events).toEqual(['inspect-host-key', 'inspect-host-key', 'reconcile', 'connect', 'release'])
  })

  it.each([
    { code: 'HOST_KEY_CHANGED' as const, expected: { kind: 'host-trust', change: 'changed-key' } },
    { code: 'CONNECTION_UNAVAILABLE' as const, expected: { kind: 'reconnect' } },
  ])('maps $code to one durable Machine blocker', async ({ code, expected }) => {
    const { authority, broker, runtime } = await fixture()
    const target = seedTarget(authority)
    broker.connectOutcomes.push(new SshConnectionError(code, `Typed ${code} failure.`))

    const pending = runtime.requireConnection(request(target))
    await nextTurn()

    expect(pendingChallenge(runtime).requirement).toMatchObject(expected)
    runtime.close()
    await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('keeps simultaneous Machine challenges isolated by machine id', async () => {
    const { authority, broker, runtime } = await fixture()
    const alpha = seedTarget(authority, 'Alpha')
    const beta = seedTarget(authority, 'Beta')
    broker.connectOutcomes.push(
      new SshConnectionError('AUTH_REQUIRED', 'Alpha needs 2FA.'),
      'ready',
    )

    const alphaPending = runtime.requireConnection(request(alpha, 'tool-alpha'))
    await nextTurn()
    const betaReady = await runtime.requireConnection(request(beta, 'tool-beta'))

    expect(pendingChallenge(runtime).machineId).toBe(alpha.machine.id)
    expect(betaReady.lease.machineId).toBe(beta.machine.id)
    expect(broker.machineIds).toEqual([
      alpha.machine.id,
      alpha.machine.id,
      beta.machine.id,
      beta.machine.id,
    ])
    runtime.close()
    await expect(alphaPending).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

})
