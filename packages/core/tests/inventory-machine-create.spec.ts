import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCAL_OWNER_PRINCIPAL_ID, RelationalAuthority } from '../src/authority.ts'
import {
  InventoryConflictError,
  InventoryService,
} from '../src/inventory-service.ts'
import { effectiveSshIdlePolicy } from '../src/domain/inventory.ts'

const roots: string[] = []
const authorities: RelationalAuthority[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'slop-inventory-machine-create-'))
  roots.push(root)
  const authority = await RelationalAuthority.open(join(root, 'authority'))
  authorities.push(authority)
  return {
    authority,
    inventory: new InventoryService(authority, {
      now: () => new Date('2026-08-27T14:00:00.000Z'),
    }),
  }
}

afterEach(async () => {
  await Promise.all(authorities.splice(0).map(async authority => { await authority.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('effective SSH idle policy', () => {
  const externalOwnerships: readonly ('adopt-user-master' | 'direct')[] = [
    'adopt-user-master',
    'direct',
  ]
  const timeouts = {
    connectSeconds: 30,
    keepaliveSeconds: 30,
    keepaliveMisses: 3,
    idleSeconds: 600,
  }

  it('retains the configured baseline while enforcing twelve hours for app-managed masters', () => {
    expect(effectiveSshIdlePolicy({ controlOwnership: 'app-managed', timeouts })).toEqual({
      kind: 'app-managed',
      configuredIdleSeconds: 600,
      minimumIdleSeconds: 43_200,
      effectiveIdleSeconds: 43_200,
    })
    expect(effectiveSshIdlePolicy({
      controlOwnership: 'app-managed',
      timeouts: { ...timeouts, idleSeconds: 86_400 },
    })).toMatchObject({ configuredIdleSeconds: 86_400, effectiveIdleSeconds: 86_400 })
  })

  it.each(externalOwnerships)(
    'does not impose the product-owned minimum on %s access',
    controlOwnership => {
      expect(effectiveSshIdlePolicy({ controlOwnership, timeouts })).toEqual({
        kind: 'external',
        controlOwnership,
        configuredIdleSeconds: 600,
        effectiveIdleSeconds: 600,
      })
    },
  )
})

describe('InventoryService direct Machine registration', () => {
  it('atomically creates a Machine and AccessProfile and replays exactly', async () => {
    const { authority, inventory } = await fixture()
    const request = {
      machineAlias: 'Atlas',
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' as const },
      scheduler: 'slurm' as const,
      paths: {
        home: '/home/alice',
        work: '/work/alice',
        scratch: '/scratch/alice',
      },
      idempotencyKey: 'create-atlas',
    }

    const created = inventory.createMachine(request)
    const replay = inventory.createMachine(request)

    expect(replay).toEqual(created)
    expect(created.machine).toMatchObject({
      name: 'Atlas',
      preferredExecutionProviderId: 'slurm',
      lifecycle: 'active',
      revision: 1,
    })
    expect(created.machine.declaredRoots).toEqual([
      { id: 'home', role: 'home', label: 'home', path: { kind: 'remote', path: '/home/alice' } },
      { id: 'work', role: 'work', label: 'work', path: { kind: 'remote', path: '/work/alice' } },
      { id: 'scratch', role: 'scratch', label: 'scratch', path: { kind: 'remote', path: '/scratch/alice' } },
    ])
    expect(created.accessProfile).toMatchObject({
      kind: 'ssh',
      target: { kind: 'endpoint', user: 'alice', host: 'atlas.example.org', port: 22 },
      authentication: { kind: 'interactive' },
      timeouts: { idleSeconds: 43_200 },
    })
    expect(authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'machine')).toHaveLength(1)
    expect(authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'access-profile')).toHaveLength(1)
  })

  it('persists a local identity-file path without persisting private key contents', async () => {
    const { inventory } = await fixture()
    const keyPath = '/Users/alice/.ssh/id_ed25519'

    const created = inventory.createMachine({
      sshTarget: 'atlas-cluster',
      authentication: { kind: 'passwordless-key', keyPath },
      scheduler: 'unknown',
      paths: {},
      idempotencyKey: 'create-atlas-alias',
    })

    expect(created.machine.name).toBe('atlas-cluster')
    expect(created.machine.preferredExecutionProviderId).toBeUndefined()
    expect(created.accessProfile).toMatchObject({
      kind: 'ssh',
      target: { kind: 'config-alias', alias: 'atlas-cluster' },
      authentication: { kind: 'ssh-agent', localKeyFilePath: keyPath },
    })
    expect(JSON.stringify(created.accessProfile)).not.toContain('privateKey')
  })

  it('rejects duplicate normalized connection identities without partial records', async () => {
    const { authority, inventory } = await fixture()
    inventory.createMachine({
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'none',
      paths: {},
      idempotencyKey: 'create-first',
    })

    expect(() => inventory.createMachine({
      sshTarget: 'alice@ATLAS.EXAMPLE.ORG',
      authentication: { kind: 'passwordless-key', keyPath: '/tmp/id_ed25519' },
      scheduler: 'pbs',
      paths: {},
      idempotencyKey: 'create-duplicate',
    })).toThrow(InventoryConflictError)
    expect(authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'machine')).toHaveLength(1)
    expect(authority.list(LOCAL_OWNER_PRINCIPAL_ID, 'access-profile')).toHaveLength(1)
  })

  it('strictly rejects fields and values outside the accepted Setup card contract', async () => {
    const { inventory } = await fixture()

    expect(() => inventory.createMachine({
      sshTarget: 'ssh alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: {},
      idempotencyKey: 'invalid-target',
    })).toThrow()
    expect(() => inventory.createMachine({
      sshTarget: 'alice@atlas.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: { work: 'relative/work' },
      customNotes: 'not an inventory field',
      idempotencyKey: 'invalid-shape',
    })).toThrow()
  })
})
