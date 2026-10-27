import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { QueueService, SqliteQueueStore, queueItemSchema, type QueueDeliveryRequest, type QueueState, type QueueTrackInput } from '../src/index.ts'

const primary = { sessionId: 'owner', cwd: '/tmp', agentPreset: 'standard' }
const context = { primary, now: new Date('2026-09-30T12:00:00Z') }
const input = { label: 'Existing script', target: { kind: 'local' as const }, observer: { kind: 'slurm' as const, jobId: '1234' }, initialState: 'running' as const }
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'queue-purpose-'))
  const store = new SqliteQueueStore(join(directory, 'queue.sqlite'))
  const deliver = vi.fn(async (_request: QueueDeliveryRequest): Promise<void | { state: 'enqueued' | 'consumed' | 'discarded' }> => {})
  let state: QueueState = 'completed'
  const service = new QueueService({ store, chatDelivery: { deliver }, clock: { now: () => new Date('2026-09-30T12:01:00Z') }, probe: { async probe(request) { return { observations: request.items.map(item => ({ queueItemId: item.id, state, observedAt: '2026-09-30T12:01:00Z', evidence: 'scheduler receipt', source: 'code' })), issues: [] } } } })
  await service.initialize()
  onTestFinished(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  return { service, store, deliver, setState: (next: QueueState) => { state = next } }
}
const continuation = { purpose: 'continue' as const, continuation: 'Read /tmp/existing/result.json and finish the authorized summary.' }

describe('Queue tracking purpose and durable continuation', () => {
  it('keeps the dispatch and exact shutdown checkpoint through an outbox reopen', async () => {
    const { service, store, deliver } = await fixture()
    const item = await service.track({ ...input, ...continuation }, context)
    await service.probeNow(item.id)
    deliver.mockResolvedValue({ state: 'enqueued' })
    await service.flushPendingDeliveries()
    const dispatchId = (await service.deliveries(item.id))[0]!.dispatchId!
    service.checkpointShutdown([{ dispatchId, messageId: 'original-native-inbox-message' }])
    await service.close()
    const resumed = new QueueService({ store: new SqliteQueueStore(store.path), chatDelivery: { deliver } })
    onTestFinished(() => resumed.close())
    await resumed.initialize()
    await resumed.flushPendingDeliveries(new Date('2099-01-01T00:00:00Z'))
    expect(deliver.mock.calls.at(-1)?.[0]).toMatchObject({ dispatchId, shutdownMessageId: 'original-native-inbox-message', delivery: 'wake' })
  })

  it('rejects missing purpose, empty continuation and contradictory delivery before creating a row', async () => {
    const { service } = await fixture()
    await expect(service.track(input as QueueTrackInput, context)).rejects.toThrow(/Correct only.*registration/)
    await expect(service.track({ ...input, purpose: 'continue', continuation: ' ' }, context)).rejects.toThrow()
    await expect(service.track({ ...input, purpose: 'monitor', primaryDelivery: 'wake' } as QueueTrackInput, context)).rejects.toThrow()
    expect(await service.list()).toEqual([])
  })

  it('keeps monitor passive and lets background delivery wake a continuation found by manual refresh', async () => {
    const { service, deliver } = await fixture()
    const monitor = await service.track({ ...input, purpose: 'monitor' }, context)
    const next = await service.track({ ...input, ...continuation }, context)
    expect(next.attention).toMatchObject({ primaryDelivery: 'wake', primaryConditions: ['completed', 'failed', 'cancelled'] })
    await service.probeNow(monitor.id)
    expect(deliver).not.toHaveBeenCalled()
    await service.flushPendingDeliveries()
    expect(deliver.mock.calls[0]?.[0].delivery).toBe('notify')
    await service.probeNow(next.id)
    expect(deliver).toHaveBeenCalledTimes(1)
    await service.flushPendingDeliveries()
    expect(deliver.mock.calls[1]?.[0].delivery).toBe('wake')
    await service.probeNow(next.id)
    await service.flushPendingDeliveries()
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('waits for deterministic terminal confirmation after callback, including equal displayed states', async () => {
    const { service, deliver } = await fixture()
    const item = await service.track({ ...input, ...continuation }, context)
    const callback = { runId: randomUUID(), kind: 'exited' as const, jobId: '1234', attempt: 0, sequence: 1, occurredAt: '2026-09-30T12:00:30Z', startedAt: '2026-09-30T12:00:00Z', exitCode: 0 }
    await service.receiveCallback(item.id, callback)
    expect(await service.get(item.id)).toMatchObject({ state: 'completed', verificationPending: true })
    await service.flushPendingDeliveries()
    expect(deliver).not.toHaveBeenCalled()
    await service.probeNow(item.id)
    await service.flushPendingDeliveries()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0]?.[0].delivery).toBe('wake')
    await service.receiveCallback(item.id, { ...callback, sequence: 2 })
    await service.probeNow(item.id)
    await service.flushPendingDeliveries()
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('retains legacy delivery until purpose is explicitly changed', async () => {
    const { service, store } = await fixture()
    const fresh = await service.track({ ...input, purpose: 'monitor' }, context)
    const { purpose: _purpose, verificationPending: _pending, ...legacy } = fresh
    await store.replaceItem(queueItemSchema.parse({ ...legacy, attention: { ...legacy.attention, primaryDelivery: 'wake', primaryConditions: ['failed'] } }), fresh.revision)
    expect(await service.get(fresh.id)).toMatchObject({ attention: { primaryDelivery: 'wake', primaryConditions: ['failed'] } })
    expect((await service.get(fresh.id))?.purpose).toBeUndefined()
    await service.update(fresh.id, { purpose: 'monitor' })
    expect((await service.get(fresh.id))?.attention).toMatchObject({ primaryDelivery: 'notify', primaryConditions: ['any-state-change'] })
  })

  it('reuses a persisted dispatch across errors, pending consumption and a discarded input', async () => {
    const { service, store, deliver } = await fixture()
    const item = await service.track({ ...input, ...continuation }, context)
    await service.probeNow(item.id)
    deliver.mockRejectedValueOnce(new Error('Session flush failed'))
    await service.flushPendingDeliveries(new Date('2026-09-30T12:02:00Z'))
    const first = (await store.listPendingDeliveries('2099-01-01T00:00:00Z'))[0]
    expect(first).toMatchObject({ state: 'pending', lastError: 'Session flush failed' })
    expect(first?.dispatchId).toBeTruthy()
    deliver.mockResolvedValueOnce({ state: 'enqueued' })
    await service.flushPendingDeliveries(new Date('2026-09-30T12:03:00Z'))
    expect((await service.deliveries(item.id))[0]).toMatchObject({ receipt: 'enqueued', state: 'pending' })
    deliver.mockResolvedValueOnce({ state: 'discarded' })
    await service.flushPendingDeliveries(new Date('2026-09-30T12:04:00Z'))
    expect((await service.deliveries(item.id))[0]).toMatchObject({ receipt: 'discarded', state: 'delivered' })
    expect(new Set(deliver.mock.calls.map(([request]) => request.dispatchId))).toEqual(new Set([first?.dispatchId]))
    await service.flushPendingDeliveries(new Date('2026-09-30T12:05:00Z'))
    expect(deliver).toHaveBeenCalledTimes(3)
  })
})
