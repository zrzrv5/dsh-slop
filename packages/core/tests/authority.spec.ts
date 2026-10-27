import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthorityApprovalError,
  AuthorityConflictError,
  IncompatibleProductHomeError,
  LOCAL_OWNER_PRINCIPAL_ID,
  RelationalAuthority,
} from '../src/authority.ts'
import { canonicalSha256, createUuidV7 } from '../src/canonical.ts'
import { principalIdSchema, revisionSchema, toInstant } from '../src/primitives.ts'

const roots: string[] = []
const stores: RelationalAuthority[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slop-authority-'))
  roots.push(root)
  return join(root, 'product-home')
}

async function authority(): Promise<RelationalAuthority> {
  const store = await RelationalAuthority.open(await temporaryHome())
  stores.push(store)
  return store
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(async store => { await store.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('greenfield relational authority', () => {
  it('fails closed on an incompatible non-empty product home without changing it', async () => {
    const home = await temporaryHome()
    await mkdir(home, { recursive: true })
    const legacyPath = join(home, 'legacy.sqlite')
    await writeFile(legacyPath, 'legacy authority bytes')

    await expect(RelationalAuthority.open(home)).rejects.toBeInstanceOf(IncompatibleProductHomeError)
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('legacy authority bytes')
  })

  it('persists principal-scoped rows and reopens only the exact redesign schema', async () => {
    const home = await temporaryHome()
    const first = await RelationalAuthority.open(home)
    first.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{ kind: 'insert', domain: 'machine', id: 'machine-a', value: { name: 'Nova' } }],
    })
    await first.close()

    const reopened = await RelationalAuthority.open(home)
    stores.push(reopened)
    expect(reopened.get(LOCAL_OWNER_PRINCIPAL_ID, 'machine', 'machine-a')).toMatchObject({
      revision: 1,
      value: { name: 'Nova' },
    })
    expect(() => reopened.get(principalIdSchema.parse('another-owner'), 'machine', 'machine-a')).toThrow(AuthorityConflictError)
  })

  it('commits approval consumption, authority, audit, and projection feed together', async () => {
    const store = await authority()
    const effectDigest = canonicalSha256({ operation: 'machine-update', machineId: 'machine-a' })
    const approval = store.issueApproval({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      effectDigest,
      expiresAt: toInstant(new Date(Date.now() + 60_000)),
    })

    const result = store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      approval: { receiptId: approval.id, effectDigest },
      mutations: [{ kind: 'insert', domain: 'machine', id: 'machine-a', value: { state: 'updating' } }],
      projections: [{ kind: 'upsert', projection: 'machine-connection', id: 'machine-a', expectedRevision: 0, value: { state: 'disconnected' } }],
      audit: [{ kind: 'machine.update-recorded', subjectDomain: 'machine', subjectId: 'machine-a', details: { effectDigest } }],
    })

    expect(result.kind).toBe('committed')
    expect(store.approval(LOCAL_OWNER_PRINCIPAL_ID, approval.id)?.state).toBe('consumed')
    expect(store.get(LOCAL_OWNER_PRINCIPAL_ID, 'machine', 'machine-a')?.value).toEqual({ state: 'updating' })
    expect(store.audit({ principalId: LOCAL_OWNER_PRINCIPAL_ID, subjectDomain: 'machine', subjectId: 'machine-a' }).map(row => row.kind)).toEqual([
      'machine.update-recorded',
      'authority.insert',
    ])
    expect(store.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID }).values).toMatchObject([{ projection: 'machine-connection', id: 'machine-a', revision: 1 }])
    expect(store.feed({ principalId: LOCAL_OWNER_PRINCIPAL_ID })).toMatchObject([{ projection: 'machine-connection', id: 'machine-a', revision: 1, change: 'upsert' }])
  })

  it('keeps every paginated baseline page pinned to its original feed cursor', async () => {
    const store = await authority()
    store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      projections: [
        { kind: 'upsert', projection: 'machine-connection', id: 'machine-a', expectedRevision: 0, value: { state: 'disconnected' } },
        { kind: 'upsert', projection: 'machine-connection', id: 'machine-b', expectedRevision: 0, value: { state: 'disconnected' } },
      ],
    })
    const first = store.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID, pageSize: 1 })
    expect(first.complete).toBe(false)

    store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      projections: [
        { kind: 'upsert', projection: 'machine-connection', id: 'machine-a', expectedRevision: 1, value: { state: 'ready' } },
        { kind: 'upsert', projection: 'machine-connection', id: 'machine-c', expectedRevision: 0, value: { state: 'ready' } },
      ],
    })

    const second = store.baseline({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      snapshotToken: first.snapshotToken,
      pageCursor: first.nextPageCursor,
      pageSize: 1,
    })
    expect(second.snapshotToken).toBe(first.snapshotToken)
    expect(second.asOfCursor).toBe(first.asOfCursor)
    expect([...first.values, ...second.values]).toEqual([
      expect.objectContaining({ projection: 'machine-connection', id: 'machine-a', value: { state: 'disconnected' } }),
      expect.objectContaining({ projection: 'machine-connection', id: 'machine-b', value: { state: 'disconnected' } }),
    ])
    expect(() => store.baseline({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      pageCursor: first.nextPageCursor,
      pageSize: 1,
    })).toThrow(AuthorityConflictError)
  })

  it('rolls back approval consumption and every authority side effect on conflict', async () => {
    const store = await authority()
    const effectDigest = canonicalSha256({ operation: 'machine-update', machineId: 'machine-conflict' })
    const approval = store.issueApproval({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      effectDigest,
      expiresAt: toInstant(new Date(Date.now() + 60_000)),
    })

    expect(() => store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      approval: { receiptId: approval.id, effectDigest },
      mutations: [{ kind: 'insert', domain: 'machine', id: 'machine-conflict', value: { state: 'updating' } }],
      projections: [{ kind: 'upsert', projection: 'machine-connection', id: 'machine-conflict', expectedRevision: 1, value: { state: 'disconnected' } }],
    })).toThrow(AuthorityConflictError)

    expect(store.approval(LOCAL_OWNER_PRINCIPAL_ID, approval.id)?.state).toBe('active')
    expect(store.get(LOCAL_OWNER_PRINCIPAL_ID, 'machine', 'machine-conflict')).toBeUndefined()
    expect(store.feed({ principalId: LOCAL_OWNER_PRINCIPAL_ID })).toEqual([])
  })

  it('issues an approval receipt in the same transaction as its durable granted state', async () => {
    const store = await authority()
    const effectDigest = canonicalSha256({ operation: 'machine-info-update', machineId: 'machine-approved-atomically' })
    const receiptId = createUuidV7()
    const expiresAt = toInstant(new Date(Date.now() + 60_000))

    store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      issueApproval: { receiptId, effectDigest, expiresAt },
      mutations: [{ kind: 'insert', domain: 'pending-approval', id: 'approval-a', value: { state: 'granted', receiptId } }],
    })
    expect(store.approval(LOCAL_OWNER_PRINCIPAL_ID, receiptId)).toMatchObject({ state: 'active', effectDigest })

    const rolledBackReceiptId = createUuidV7()
    expect(() => store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      issueApproval: { receiptId: rolledBackReceiptId, effectDigest, expiresAt },
      mutations: [{ kind: 'insert', domain: 'pending-approval', id: 'approval-a', value: { state: 'granted', receiptId: rolledBackReceiptId } }],
    })).toThrow()
    expect(store.approval(LOCAL_OWNER_PRINCIPAL_ID, rolledBackReceiptId)).toBeUndefined()
  })

  it('replays one idempotent transaction and rejects key reuse for another request', async () => {
    const store = await authority()
    const transaction = {
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{ kind: 'insert' as const, domain: 'machine', id: 'machine-idempotent', value: { name: 'Atlas' } }],
      idempotency: {
        scope: 'machine-create',
        key: 'browser-command-1',
        request: { name: 'Atlas' },
        result: { machineId: 'machine-idempotent' },
      },
    }

    expect(store.transact(transaction)).toMatchObject({ kind: 'committed', result: { machineId: 'machine-idempotent' } })
    expect(store.transact(transaction)).toEqual({ kind: 'replayed', records: [], result: { machineId: 'machine-idempotent' } })
    expect(store.get(LOCAL_OWNER_PRINCIPAL_ID, 'machine', 'machine-idempotent')?.revision).toBe(revisionSchema.parse(1))

    expect(() => store.transact({
      ...transaction,
      idempotency: { ...transaction.idempotency, request: { name: 'Different' } },
    })).toThrow(AuthorityConflictError)
  })

  it('rejects a consumed or mismatched approval receipt', async () => {
    const store = await authority()
    const effectDigest = canonicalSha256({ effect: 'one' })
    const approval = store.issueApproval({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      effectDigest,
      expiresAt: toInstant(new Date(Date.now() + 60_000)),
    })
    expect(() => store.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      approval: { receiptId: approval.id, effectDigest: canonicalSha256({ effect: 'two' }) },
    })).toThrow(AuthorityApprovalError)
    store.transact({ principalId: LOCAL_OWNER_PRINCIPAL_ID, approval: { receiptId: approval.id, effectDigest } })
    expect(() => store.transact({ principalId: LOCAL_OWNER_PRINCIPAL_ID, approval: { receiptId: approval.id, effectDigest } })).toThrow(AuthorityApprovalError)
  })
})
