import { queueItemSchema } from '@dsh-slop/queue'
import { describe, expect, it } from 'vitest'
import { MAX_QUEUE_LIST_BYTES, queueListPage } from '../src/queue-list.ts'
import { canonicalQueueOutput, queueJsonOutput, queueListOutputSchema } from '../src/queue-tool-schema.ts'

function item(overrides: Record<string, unknown> = {}) {
  return queueItemSchema.parse({
    id: 'job', label: 'HZO', tags: [], target: { kind: 'machine', machineId: 'nova' },
    observer: { kind: 'slurm', jobId: '123' }, state: 'running', monitoring: {}, revision: 1,
    createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z',
    consecutiveUnchangedChecks: 0, consecutiveFailures: 0,
    attention: { primary: { sessionId: 'owner', cwd: '/tmp', agentPreset: 'standard' }, primaryDelivery: 'notify', primaryConditions: ['completed'], subscriptions: [] },
    ...overrides,
  })
}

describe('Queue summary pages', () => {
  it('preserves freshness, probe errors and verification while omitting large evidence and process paths', () => {
    const original = item({
      label: '任务'.repeat(512), notes: 'x'.repeat(32_768), purpose: 'continue', continuation: 'Read the result',
      verificationPending: true, phase: 'collect',
      observer: { kind: 'process', handle: { pid: 123, startToken: 'start', launchedAt: '2026-10-01T10:00:00.000Z', stdoutPath: '/large/path', stderrPath: '/err', exitCodePath: '/exit' } },
      lastCheckError: { at: '2026-10-01T10:10:00.000Z', message: `AUTH_REQUIRED: ${'x'.repeat(8000)}` },
      lastObservation: { queueItemId: 'job', state: 'running', observedAt: '2026-10-01T10:01:00.000Z', source: 'code', elapsedSeconds: 60, walltimeSeconds: 3600, evidence: 'x'.repeat(128_000), attention: { code: 'reason', message: 'q'.repeat(4096) } },
    })
    const before = JSON.stringify(original)
    const result = canonicalQueueOutput(queueListOutputSchema, queueListPage([original], { offset: 0, limit: 10 }))
    expect(result).toMatchObject({ ok: true, value: [{
      observer: { kind: 'process', pid: 123 }, verificationPending: true, purpose: 'continue', phase: 'collect', textTruncated: true,
      lastCheckError: { message: expect.stringContaining('AUTH_REQUIRED') },
      lastObservation: { state: 'running', observedAt: '2026-10-01T10:01:00.000Z', source: 'code', elapsedSeconds: 60, walltimeSeconds: 3600, attention: { code: 'reason' } },
    }] })
    const native = queueJsonOutput(queueListOutputSchema).render({}, result)[0]!.text
    expect(JSON.parse(native)).toEqual(result)
    expect(Buffer.byteLength(native)).toBeLessThanOrEqual(MAX_QUEUE_LIST_BYTES)
    for (const key of ['notes', 'evidence', 'stdoutPath', 'continuation', 'subscriptions']) expect(native).not.toContain(`"${key}"`)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('paginates within the rendered byte budget with no dropped rows, including maximally escaped summaries', () => {
    const rows = Array.from({ length: 52 }, (_, index) => item({
      id: `${String(index).padStart(3, '0')}${'\u0001'.repeat(125)}`,
      label: '\u0001'.repeat(1024), phase: '\u0001'.repeat(128),
      target: { kind: 'machine', machineId: '\u0001'.repeat(128) },
      observer: { kind: 'pbs', jobId: '\u0001'.repeat(256) },
      lastCheckError: { at: '2026-10-01T10:00:00.000Z', message: '\u0001'.repeat(8192) },
      lastObservation: { queueItemId: 'job', state: 'running', observedAt: '2026-10-01T10:00:00.000Z', source: 'code', evidence: 'large', attention: { code: '\u0001'.repeat(128), message: '\u0001'.repeat(4096) } },
    }))
    const seen: string[] = []
    let offset = 0
    while (offset < rows.length) {
      const page = queueListPage(rows, { offset, limit: 500 })
      expect(page.value.length).toBeGreaterThan(0)
      expect(page.value.length).toBeLessThan(52)
      const canonical = canonicalQueueOutput(queueListOutputSchema, page)
      const native = queueJsonOutput(queueListOutputSchema).render({}, canonical)[0]!.text
      expect(Buffer.byteLength(native)).toBeLessThanOrEqual(MAX_QUEUE_LIST_BYTES)
      expect(page.page.stateCounts.running).toBe(52)
      seen.push(...page.value.map(row => row.id))
      offset += page.value.length
      expect(page.page.hasMore).toBe(offset < rows.length)
      expect(page.page.nextOffset).toBe(offset < rows.length ? offset : undefined)
    }
    expect(seen).toEqual(rows.map(row => row.id))
  })

  it('orders by submission instant, with a stable id tie-breaker, instead of latest polling time', () => {
    const rows = [
      item({ id: 'old', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-10-02T10:00:00Z' }),
      item({ id: 'b', createdAt: '2026-10-01T10:00:00Z' }),
      item({ id: 'a', createdAt: '2026-10-01T05:00:00-05:00' }),
    ]
    expect(queueListPage(rows, { offset: 0, limit: 10 }).value.map(row => row.id)).toEqual(['a', 'b', 'old'])
    expect(rows.map(row => row.id)).toEqual(['old', 'b', 'a'])
    expect(queueListPage(rows, { offset: 3, limit: 10 })).toMatchObject({ value: [], page: { total: 3, hasMore: false } })
  })
})
