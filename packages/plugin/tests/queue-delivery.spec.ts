import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeAgentFixture } from './native-agent-fixture.ts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { QueueService, SqliteQueueStore } from '../../queue/src/index.ts'
// The built entry is the plugin Cordis actually loads. pnpm check builds it
// before tests, including its decorators and dependency declaration.
import { inject as hostDependencies } from '../lib/types/queue-entry.js'
import { DshQueueRuntime, queueSessionTargetForAgent } from '../src/queue-runtime.ts'

async function fixture(delivery: 'notify' | 'wake') {
  const directory = await mkdtemp(join(tmpdir(), 'slop-queue-delivery-'))
  const { ctx: host, agent: live } = await nativeAgentFixture(directory)
  const session = live.session
  vi.spyOn(live, 'followup')
  let release!: () => void
  const held = live.runMaintenance(() => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  onTestFinished(async () => { live.inbox.clear(); release(); await held; await rm(directory, { recursive: true, force: true }) })
  for (const name of hostDependencies) {
    if (host.get(name) === undefined) host.provide(name, {})
  }
  let runtime: DshQueueRuntime | undefined
  await host.plugin({
    name: 'queue-delivery-in-host-scope',
    inject: hostDependencies,
    apply(ctx: Context) { runtime = new DshQueueRuntime(ctx) },
  })
  if (runtime === undefined) throw new Error('Queue runtime did not mount')
  const store = new SqliteQueueStore(join(directory, 'queue.sqlite'))
  let now = new Date('2026-09-28T00:00:00Z')
  const service = new QueueService({
    store,
    chatDelivery: runtime,
    queryWorker: runtime,
    clock: { now: () => now },
    probe: { async probe(request) {
      return { observations: request.items.map(item => ({
        queueItemId: item.id, state: 'completed', observedAt: now.toISOString(),
        evidence: 'scheduler: COMPLETED, exit 0', source: 'code',
      })), issues: [] }
    } },
  })
  await service.initialize()
  onTestFinished(async () => { runtime?.close(); await service.close() })
  await service.track({
    id: 'prerequisite', label: 'Prepare requested input',
    target: { kind: 'local' }, observer: { kind: 'slurm', jobId: '123' },
    initialState: 'running', monitoring: { userIntervalSeconds: 60 },
    ...(delivery === 'wake' ? { purpose: 'continue' as const, continuation: 'Verify the existing output in /work and finish the requested second stage.' } : { purpose: 'monitor' as const }),
  }, { primary: queueSessionTargetForAgent(live), now })
  const advance = () => { now = new Date(now.getTime() + 60_000); return now }
  return { host, session, live, service, store, advance, snapshot: join(directory, 'messages.json') }
}

describe('Queue delivery through the host dependency boundary', () => {
  it('flushes passive notices before acknowledging delivery and retries without another append', async () => {
    const f = await fixture('notify')
    let fail = true
    f.host.on('session/flush', async session => {
      if (fail) throw new Error('persistence temporarily unavailable')
      await writeFile(f.snapshot, JSON.stringify(session.deriveMessages()))
    })
    await f.service.runDue(f.advance())
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(await f.store.listPendingDeliveries('2099-01-01T00:00:00Z')).toEqual([
      expect.objectContaining({ lastError: 'persistence temporarily unavailable', attempts: 1 }),
    ])
    fail = false
    expect(await f.service.flushPendingDeliveries(f.advance())).toBe(1)
    expect(JSON.parse(await readFile(f.snapshot, 'utf8'))).toHaveLength(1)
    expect(f.session.deriveMessages()).toHaveLength(1)
    expect(await f.store.listPendingDeliveries('2099-01-01T00:00:00Z')).toEqual([])
    expect(await f.service.flushPendingDeliveries(f.advance())).toBe(0)
    expect(f.live.followup).not.toHaveBeenCalled()
  })

  it('wakes the owner once for a terminal prerequisite without a new user message', async () => {
    const f = await fixture('wake')
    f.host.on('session/flush', async () => {})
    await f.service.runDue(f.advance())
    expect(f.live.followup).toHaveBeenCalledTimes(1)
    expect(await f.store.listPendingDeliveries('2099-01-01T00:00:00Z')).toEqual([expect.objectContaining({ receipt: 'enqueued' })])
    await f.service.runDue(f.advance())
    expect(f.live.followup).toHaveBeenCalledTimes(1)
  })
})
