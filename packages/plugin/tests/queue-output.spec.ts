import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { QueueService, SqliteQueueStore } from '@dsh-slop/queue'
import { canonicalQueueOutput, queueTrackOutputSchema, queueListOutputSchema, queueGetOutputSchema, queueUpdateOutputSchema } from '../src/queue-tool-schema.ts'
import { queueListPage } from '../src/queue-list.ts'

describe('Queue model output contract', () => {
  it('returns persisted continuation and verification state through every model-facing output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-queue-output-'))
    const service = new QueueService({ store: new SqliteQueueStore(join(root, 'queue.sqlite')), chatDelivery: { async deliver() {} } })
    onTestFinished(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
    await service.initialize()
    const item = await service.track({ label: 'Existing job', target: { kind: 'local' }, observer: { kind: 'slurm', jobId: '1234' }, purpose: 'continue', continuation: 'Read /tmp/result.json and finish the summary.', initialState: 'running' }, { primary: { sessionId: 'owner', cwd: '/tmp', agentPreset: 'standard' } })
    const success = (value: unknown) => ({ schemaVersion: 1, ok: true, value })
    expect(canonicalQueueOutput(queueTrackOutputSchema, success(item))).toMatchObject({ value: { purpose: 'continue' } })
    await service.receiveCallback(item.id, { runId: randomUUID(), jobId: '1234', kind: 'exited', attempt: 0, sequence: 1, exitCode: 0, occurredAt: new Date().toISOString(), startedAt: item.createdAt })
    const pending = await service.get(item.id)
    const observations = await service.observations(item.id)
    expect(pending?.verificationPending).toBe(true)
    const beforeList = await service.list()
    const summaries = canonicalQueueOutput(queueListOutputSchema, queueListPage(beforeList, { offset: 0, limit: 10 }))
    expect(summaries).toMatchObject({ value: [{ purpose: 'continue', verificationPending: true, lastObservation: { source: 'webhook' } }] })
    expect(JSON.stringify(summaries)).not.toContain('Read /tmp/result.json')
    expect(await service.list()).toEqual(beforeList)
    expect(pending?.continuation).toBe('Read /tmp/result.json and finish the summary.')
    expect(canonicalQueueOutput(queueGetOutputSchema, success({ item: pending, observations }))).toMatchObject({ value: { item: { verificationPending: true } } })
    const updated = await service.update(item.id, { continuation: 'Verify /tmp/result.json and write the authorized summary.' })
    expect(canonicalQueueOutput(queueUpdateOutputSchema, success({ item: updated, observations }))).toMatchObject({ value: { item: { verificationPending: true } } })
  })
})
