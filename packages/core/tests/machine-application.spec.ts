import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asPrincipalId, createUuidV7 } from '../src/index.ts'
import { LOCAL_OWNER_PRINCIPAL_ID, RelationalAuthority } from '../src/authority.ts'
import { InventoryService } from '../src/inventory-service.ts'
import { MachineApplication, type MachineConnectionRuntime } from '../src/machine-application.ts'

const roots: string[] = []
const authorities: RelationalAuthority[] = []

function connectionRuntime(): MachineConnectionRuntime {
  return {
    status: vi.fn(async () => ({ state: 'ready' })),
    requireConnection: vi.fn(async input => {
      const request = input as { machineId: string }
      return {
        observation: {
          connectedAt: '2026-09-01T12:00:00.000Z',
          expiresAt: '2026-09-02T00:00:00.000Z',
        },
        lease: {
          id: createUuidV7(),
          machineId: request.machineId,
          connectionIdentityDigest: 'sha256:connection',
          acquiredAt: '2026-09-01T12:00:00.000Z',
          expiresAt: '2026-09-01T12:05:00.000Z',
        },
      }
    }),
    decideHostTrust: vi.fn(async input => ({
      challenge: { id: (input as { challengeId: string }).challengeId, revision: 2 },
      decision: { decision: 'trust-once', fingerprint: 'SHA256:test' },
    })),
    startAuthentication: vi.fn(async input => ({
      scope: 'machine' as const,
      authFlowId: createUuidV7(),
      carrierFlowId: createUuidV7(),
      challenge: { id: (input as { challengeId: string }).challengeId, revision: 2 },
      expiresAt: '2026-09-01T12:10:00.000Z',
    })),
    authenticationStatus: vi.fn(async () => ({ state: 'ready' })),
    cancelAuthentication: vi.fn(async () => undefined),
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'slop-machine-application-'))
  roots.push(root)
  const authority = await RelationalAuthority.open(join(root, 'authority'))
  authorities.push(authority)
  const inventory = new InventoryService(authority)
  const runtime = connectionRuntime()
  const application = new MachineApplication({
    authority,
    inventory,
    connectionRuntime: runtime,
    openAuthFlow: async () => { throw new Error('The carrier is not used in this test.') },
  })
  return { application, authority, inventory, runtime }
}

const agentPrincipal = {
  principalId: LOCAL_OWNER_PRINCIPAL_ID,
  source: 'agent' as const,
  agentId: 'agent-machine-test',
  sessionId: 'chat-machine-test',
}

const browserPrincipal = {
  principalId: asPrincipalId('local-owner'),
  source: 'browser' as const,
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async authority => { await authority.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('MachineApplication boundary', () => {
  it('projects the effective idle policy without rewriting a legacy configured baseline', async () => {
    const { application, authority, inventory, runtime } = await fixture()
    const created = inventory.createMachine({
      sshTarget: 'legacy.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: {},
      idempotencyKey: 'legacy-create',
    })
    if (created.accessProfile.kind !== 'ssh') throw new Error('test setup did not create SSH access')
    const legacy = inventory.updateMachine({
      schemaVersion: 1,
      machineId: created.machine.id,
      expectedMachineRevision: created.machine.revision,
      expectedAccessProfileRevision: created.accessProfile.revision,
      baseConfiguration: {
        name: created.machine.name,
        access: {
          kind: 'ssh',
          target: created.accessProfile.target,
          controlOwnership: created.accessProfile.controlOwnership,
          trustPolicy: created.accessProfile.trustPolicy,
          authentication: created.accessProfile.authentication,
          timeouts: { ...created.accessProfile.timeouts, idleSeconds: 600 },
        },
        declaredRoots: created.machine.declaredRoots,
        ...(created.machine.preferredExecutionProviderId === undefined
          ? {}
          : { preferredExecutionProviderId: created.machine.preferredExecutionProviderId }),
      },
      idempotencyKey: 'legacy-idle-baseline',
    })
    const before = authority.get(LOCAL_OWNER_PRINCIPAL_ID, 'access-profile', legacy.accessProfile.id)

    const projected = await application.invoke('machine.get', {
      machineId: legacy.machine.id,
    }, browserPrincipal)

    expect(projected).toMatchObject({
      ok: true,
      value: {
        connectionState: 'ready',
        sshIdlePolicy: {
          kind: 'app-managed',
          configuredIdleSeconds: 600,
          minimumIdleSeconds: 43_200,
          effectiveIdleSeconds: 43_200,
        },
        baseConfiguration: {
          access: { timeouts: { idleSeconds: 600 } },
        },
      },
    })
    expect(runtime.status).toHaveBeenCalledWith(legacy.machine.id, undefined)
    expect(authority.get(LOCAL_OWNER_PRINCIPAL_ID, 'access-profile', legacy.accessProfile.id)).toEqual(before)
  })

  it('registers and connects a Machine only through the exact current Chat Agent', async () => {
    const { application, runtime } = await fixture()
    const denied = await application.invoke('machine.create', {
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: {},
      idempotencyKey: 'browser-create',
    }, browserPrincipal)
    expect(denied).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT' } })

    const created = await application.invoke('machine.create', {
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: { work: '/work/alice' },
      idempotencyKey: 'chat-create',
    }, agentPrincipal)
    expect(created).toMatchObject({
      ok: true,
      value: {
        name: 'alice@atlas.example.org',
        target: 'atlas.example.org',
        scheduler: 'slurm',
        workPath: '/work/alice',
      },
    })
    if (!created.ok) throw new Error('Machine creation unexpectedly failed.')
    const machine = created.value as { id: string; revision: number; accessProfileRevision: number }

    const connected = await application.invoke('connection.require', {
      machineId: machine.id,
      purpose: 'remote-read',
      expectedMachineRevision: machine.revision,
      expectedAccessProfileRevision: machine.accessProfileRevision,
      toolCallId: 'tool-connect-atlas',
    }, agentPrincipal)

    expect(connected).toMatchObject({
      ok: true,
      value: {
        machineId: machine.id,
        readyAt: '2026-09-01T12:00:00.000Z',
        expiresAt: '2026-09-02T00:00:00.000Z',
      },
    })
    expect(runtime.requireConnection).toHaveBeenCalledWith(expect.objectContaining({
      machineId: machine.id,
      purpose: 'remote-read',
      agentId: agentPrincipal.agentId,
      sessionId: agentPrincipal.sessionId,
    }), undefined)
  })
})
