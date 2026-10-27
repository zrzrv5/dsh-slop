import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { nativeAgentFixture as fixture } from './native-agent-fixture.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, it, expect, onTestFinished, vi } from 'vitest'
import { DshQueueRuntime, queueSessionTargetForAgent } from '../src/queue-runtime.ts'

describe('pinned native Inbox public contract', () => {
  it('restores a flushed pending input across native disposal and fresh persistence attachment, but respects subsequent user removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slop-native-restart-'))
    const first = await fixture('/tmp', { root })
    const dispatchId = '00000000-0000-4000-8000-000000000099'
    const original = createUserMessage({ source: { kind: 'dsh-slop-queue', plugin: 'dsh-slop-queue', form: 'notice', summary: 'restart', dispatchId }, content: [{ type: 'text', text: 'restart' }] })
    first.agent.inbox.append('next-turn', original)
    expect(await first.ctx.sessions.flush(first.agent.session)).toBe(true)
    const checkpoint = new DshQueueRuntime(first.ctx).pendingAtShutdown()[0]!
    await first.dispose()
    const second = await fixture('/tmp', { root, resume: true })
    const held = second.agent.runMaintenance(signal => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })))
    onTestFinished(async () => { await second.dispose(); await held; await rm(root, { recursive: true, force: true }) })
    const runtime = new DshQueueRuntime(second.ctx)
    const request = { target: queueSessionTargetForAgent(second.agent), delivery: 'wake' as const, dispatchId, shutdownMessageId: checkpoint.messageId, triggers: [] }
    expect(await runtime.deliver(request)).toEqual({ state: 'enqueued' })
    expect(second.agent.inbox.nextTurn).toHaveLength(1)
    const replacement = second.agent.inbox.nextTurn[0]!
    expect(replacement.id).not.toBe(original.id)
    second.agent.inbox.remove(replacement.id)
    expect(await new DshQueueRuntime(second.ctx).deliver(request)).toEqual({ state: 'discarded' })
    expect(second.agent.inbox.hasPending).toBe(false)
  })

  it('rejects a Session without a durability listener instead of acknowledging followup', async () => {
    const { ctx, agent } = await fixture()
    const held = agent.runMaintenance(signal => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })))
    onTestFinished(async () => { agent.cancel({ kind: 'disposed' }); await held })
    await expect(new DshQueueRuntime(ctx).deliver({ target: queueSessionTargetForAgent(agent), delivery: 'wake', dispatchId: '00000000-0000-4000-8000-000000000098', triggers: [] })).rejects.toThrow('durability listener')
  })

  it('persists append/remove identity in the native projection without starting a model turn', async () => {
    const { ctx, agent } = await fixture()
    const message = createUserMessage({ source: { kind: 'dsh-slop-queue', plugin: 'dsh-slop-queue', form: 'notice', summary: 'proof', dispatchId: 'receipt-proof' }, content: [{ type: 'text', text: 'proof' }] })
    agent.inbox.append('next-turn', message)
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn.map(entry => entry.id)).toEqual([message.id])
    expect(ctx.sessionProjections.stateOf(agent.session, 'slopQueueDelivery')?.receipts).toEqual({ 'receipt-proof': 'enqueued' })
    expect(() => agent.inbox.append('next-turn', message)).toThrow(/already pending/)
    agent.inbox.remove(message.id)
    expect(ctx.sessionProjections.stateOf(agent.session, 'slopQueueDelivery')?.receipts).toEqual({ 'receipt-proof': 'discarded' })
  })

  it('does not acknowledge a wake until flush succeeds, or resurrect a removed pending input', async () => {
    const { ctx, agent } = await fixture()
    // Hold the public driver in maintenance so followup exercises the actual
    // native Inbox without sending a model request.
    let release!: () => void
    const held = agent.runMaintenance(() => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    onTestFinished(async () => { agent.inbox.clear(); release(); await held })
    const runtime = new DshQueueRuntime(ctx)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(true)
    const request = { target: queueSessionTargetForAgent(agent), delivery: 'wake' as const, dispatchId: '00000000-0000-4000-8000-000000000001', triggers: [] }
    await expect(runtime.deliver(request)).rejects.toThrow('disk unavailable')
    const id = agent.inbox.nextTurn[0]?.id
    expect(id).toBeDefined()
    expect(await runtime.deliver(request)).toEqual({ state: 'enqueued' })
    expect(agent.inbox.nextTurn).toHaveLength(1)
    agent.inbox.remove(id!)
    expect(await new DshQueueRuntime(ctx).deliver(request)).toEqual({ state: 'discarded' })
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(flush).toHaveBeenCalledTimes(3)
  })
})
