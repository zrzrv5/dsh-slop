import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthorityProjectionBridge,
  LOCAL_OWNER_PRINCIPAL_ID,
  RelationalAuthority,
  authorityFeedServerFrameSchema,
  authorityProjectionSnapshotPageSchema,
  canonicalSha256,
  machineConnectionPresentationSchema,
  machineIdSchema,
  principalIdSchema,
  toInstant,
  type AuthorityFeedServerFrame,
  type MachineConnectionPresentation,
} from '../src/index.ts'

const roots: string[] = []
const authorities: RelationalAuthority[] = []
const bridges: AuthorityProjectionBridge[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'slop-authority-feed-'))
  roots.push(root)
  return root
}

async function createAuthority(): Promise<{ readonly authority: RelationalAuthority; readonly root: string }> {
  const root = await temporaryRoot()
  const authority = await RelationalAuthority.open(join(root, 'authority'))
  authorities.push(authority)
  return { authority, root }
}

function connectionPresentation(
  label: string,
  machineId: MachineConnectionPresentation['machineId'],
  revision = 1,
): MachineConnectionPresentation {
  const now = toInstant()
  return machineConnectionPresentationSchema.parse({
    schemaVersion: 1,
    id: `connection-${label}`,
    ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
    machineId,
    machineLabel: `Machine ${label}`,
    connectionIdentityDigest: canonicalSha256({ machineId, label }),
    freshness: 'unknown',
    connection: { state: 'disconnected', reason: 'No active connection.', retryable: true },
    waitingSessionCount: 0,
    actions: ['open-machine-settings'],
    revision,
    updatedAt: now,
  })
}

function upsertConnection(
  authority: RelationalAuthority,
  presentation: MachineConnectionPresentation,
  expectedRevision: number,
): void {
  authority.transact({
    principalId: LOCAL_OWNER_PRINCIPAL_ID,
    projections: [{
      kind: 'upsert',
      projection: 'machine-connection',
      id: presentation.id,
      expectedRevision,
      value: presentation,
    }],
  })
}

async function nextFrame(iterator: AsyncIterator<AuthorityFeedServerFrame>): Promise<AuthorityFeedServerFrame> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Timed out waiting for authority feed frame.')) }, 1_000)
    void iterator.next().then(result => {
      clearTimeout(timeout)
      if (result.done) reject(new Error('Authority feed closed before the expected frame.'))
      else resolve(authorityFeedServerFrameSchema.parse(result.value))
    }, error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(async bridge => { await bridge.close() }))
  await Promise.all(authorities.splice(0).map(async authority => { await authority.close() }))
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('redesign authority browser bridge', () => {
  it('keeps an idle subscription observable with heartbeats at its delivered cursor', async () => {
    const { authority } = await createAuthority()
    const bridge = new AuthorityProjectionBridge(authority)
    bridges.push(bridge)
    vi.useFakeTimers()
    try {
      const baseline = bridge.snapshot({}, LOCAL_OWNER_PRINCIPAL_ID).snapshot
      const session = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
      const iterator = session.frames[Symbol.asyncIterator]()
      await session.receive({ kind: 'subscribe', feedId: 'slop', asOfCursor: baseline.asOfCursor, snapshotToken: baseline.snapshotToken })
      expect((await iterator.next()).value).toMatchObject({ kind: 'subscribed' })
      await vi.advanceTimersByTimeAsync(10_000)
      expect((await iterator.next()).value).toEqual({ kind: 'heartbeat', cursor: baseline.asOfCursor })
      await session.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await bridge.close()
      vi.useRealTimers()
    }
  })

  it('pins every Machine snapshot page to one authority cursor', async () => {
    const { authority } = await createAuthority()
    const machineA = machineIdSchema.parse('00000000-0000-7000-8000-000000000a01')
    const machineB = machineIdSchema.parse('00000000-0000-7000-8000-000000000b01')
    const firstConnection = connectionPresentation('a', machineA)
    const secondConnection = connectionPresentation('b', machineB)
    upsertConnection(authority, firstConnection, 0)
    upsertConnection(authority, secondConnection, 0)

    const bridge = new AuthorityProjectionBridge(authority)
    bridges.push(bridge)

    const first = bridge.snapshot({
      pageSize: 1,
    }, LOCAL_OWNER_PRINCIPAL_ID)
    expect(first).toMatchObject({
      complete: false,
      nextPageCursor: '1',
      snapshot: {
        feedId: 'slop',
        machineConnections: [{ id: firstConnection.id, revision: 1 }],
      },
    })
    const parsedFirstPage = authorityProjectionSnapshotPageSchema.parse(first)

    upsertConnection(authority, connectionPresentation('a', machineA, 2), 1)
    upsertConnection(
      authority,
      connectionPresentation('c', machineIdSchema.parse('00000000-0000-7000-8000-000000000c01')),
      0,
    )

    const second = bridge.snapshot({
      pageSize: 1,
      snapshotToken: parsedFirstPage.snapshot.snapshotToken,
      pageCursor: parsedFirstPage.nextPageCursor,
    }, LOCAL_OWNER_PRINCIPAL_ID)
    expect(second).toMatchObject({
      complete: true,
      snapshot: {
        asOfCursor: parsedFirstPage.snapshot.asOfCursor,
        snapshotToken: parsedFirstPage.snapshot.snapshotToken,
        machineConnections: [{ id: secondConnection.id, revision: 1 }],
      },
    })
    expect(first).not.toHaveProperty('snapshot.machines')

    expect(() => bridge.snapshot({ pageSize: 1, unsupported: true }, LOCAL_OWNER_PRINCIPAL_ID)).toThrow()
  })

  it('replays canonical events in cursor order and drains every batch before polling again', async () => {
    const { authority } = await createAuthority()
    const machineA = machineIdSchema.parse('00000000-0000-7000-8000-000000000a02')
    const machineB = machineIdSchema.parse('00000000-0000-7000-8000-000000000b02')
    const firstConnection = connectionPresentation('a', machineA)
    upsertConnection(authority, firstConnection, 0)
    const baseline = authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID })
    const bridge = new AuthorityProjectionBridge(authority, { pollIntervalMs: 5, batchSize: 1 })
    bridges.push(bridge)
    const session = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
    const iterator = session.frames[Symbol.asyncIterator]()

    await session.receive({
      kind: 'subscribe',
      feedId: 'slop',
      asOfCursor: baseline.asOfCursor,
      snapshotToken: baseline.snapshotToken,
    })
    expect(await nextFrame(iterator)).toEqual({ kind: 'subscribed', feedId: 'slop', firstCursor: '2' })

    const secondConnection = connectionPresentation('b', machineB)
    upsertConnection(authority, secondConnection, 0)
    const updatedFirst = connectionPresentation('a', machineA, 2)
    upsertConnection(authority, updatedFirst, 1)

    expect(await nextFrame(iterator)).toEqual({
      kind: 'event',
      event: expect.objectContaining({ cursor: '2', projection: 'machine-connection', id: secondConnection.id, revision: 1 }),
    })
    expect(await nextFrame(iterator)).toEqual({
      kind: 'event',
      event: expect.objectContaining({ cursor: '3', projection: 'machine-connection', id: updatedFirst.id, revision: 2 }),
    })
    await session.receive({ kind: 'ack', cursor: '3' })
    await session.close()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('resumes after an applied cursor while retaining the original baseline token', async () => {
    const { authority } = await createAuthority()
    const first = connectionPresentation('a', machineIdSchema.parse('00000000-0000-7000-8000-000000000a03'))
    upsertConnection(authority, first, 0)
    const baseline = authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID })
    const second = connectionPresentation('b', machineIdSchema.parse('00000000-0000-7000-8000-000000000b03'))
    const third = connectionPresentation('c', machineIdSchema.parse('00000000-0000-7000-8000-000000000c03'))
    upsertConnection(authority, second, 0)
    upsertConnection(authority, third, 0)
    const bridge = new AuthorityProjectionBridge(authority, { pollIntervalMs: 5 })
    bridges.push(bridge)
    const session = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
    const iterator = session.frames[Symbol.asyncIterator]()

    await session.receive({
      kind: 'subscribe',
      feedId: 'slop',
      asOfCursor: '2',
      snapshotToken: baseline.snapshotToken,
    })
    expect(await nextFrame(iterator)).toEqual({ kind: 'subscribed', feedId: 'slop', firstCursor: '3' })
    expect(await nextFrame(iterator)).toEqual({
      kind: 'event',
      event: expect.objectContaining({ cursor: '3', id: third.id }),
    })
    await session.close()
  })

  it('emits typed resync frames for invalid token and cursor combinations', async () => {
    const { authority } = await createAuthority()
    upsertConnection(
      authority,
      connectionPresentation('a', machineIdSchema.parse('00000000-0000-7000-8000-000000000a04')),
      0,
    )
    const baseline = authority.baseline({ principalId: LOCAL_OWNER_PRINCIPAL_ID })
    const bridge = new AuthorityProjectionBridge(authority, { pollIntervalMs: 5 })
    bridges.push(bridge)

    const invalidTokenSession = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
    const invalidTokenFrames = invalidTokenSession.frames[Symbol.asyncIterator]()
    await invalidTokenSession.receive({ kind: 'subscribe', feedId: 'slop', asOfCursor: '1', snapshotToken: 'not-a-token' })
    expect(await nextFrame(invalidTokenFrames)).toEqual({
      kind: 'resync-required',
      cursor: '1',
      reason: 'snapshot-token-invalid',
    })
    await invalidTokenSession.close()

    const staleResumeSession = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
    const staleResumeFrames = staleResumeSession.frames[Symbol.asyncIterator]()
    await staleResumeSession.receive({ kind: 'subscribe', feedId: 'slop', asOfCursor: '0', snapshotToken: baseline.snapshotToken })
    expect(await nextFrame(staleResumeFrames)).toEqual({
      kind: 'resync-required',
      cursor: '0',
      reason: 'resume-before-baseline',
    })
    await staleResumeSession.close()
  })

  it('rejects malformed frames and closes pending iterators on abort or bridge shutdown', async () => {
    const { authority } = await createAuthority()
    const bridge = new AuthorityProjectionBridge(authority, { pollIntervalMs: 5 })
    bridges.push(bridge)
    const malformed = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
    await expect(malformed.receive({ kind: 'subscribe', feedId: 'slop', asOfCursor: '0', snapshotToken: 'token', extra: true }))
      .rejects.toThrow()
    await malformed.close()

    const controller = new AbortController()
    const aborted = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID, controller.signal)
    const abortedIterator = aborted.frames[Symbol.asyncIterator]()
    const pendingAbort = abortedIterator.next()
    controller.abort()
    await expect(pendingAbort).resolves.toEqual({ done: true, value: undefined })

    const shutdown = bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)
    const shutdownIterator = shutdown.frames[Symbol.asyncIterator]()
    const pendingShutdown = shutdownIterator.next()
    await bridge.close()
    await expect(pendingShutdown).resolves.toEqual({ done: true, value: undefined })
    expect(() => bridge.openFeed(LOCAL_OWNER_PRINCIPAL_ID)).toThrow(/closed/i)
    expect(() => new AuthorityProjectionBridge(authority).openFeed(principalIdSchema.parse('another-owner'))).toThrow(/local owner/i)
  })
})
