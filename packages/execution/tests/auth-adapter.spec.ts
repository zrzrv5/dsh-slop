import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { asPrincipalId, canonicalSha256, machineIdSchema } from '@dsh-slop/core'
import { DshAuthFlow } from '@dsh-slop/operations'
import { DshAuthFlowAdapter, type AuthFlowRequest, type SshConnectionProfile } from '../src/index.ts'

const MACHINE = machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a1')
const OWNER = asPrincipalId('auth-owner')

function request(): AuthFlowRequest {
  const profile: SshConnectionProfile = {
    machineId: MACHINE,
    revision: 1,
    alias: 'cluster',
    trust: { mode: 'user-known-hosts', expectedFingerprints: [] },
    ownership: 'app-managed',
    connectTimeoutSeconds: 10,
    keepaliveSeconds: 30,
    idleTimeoutSeconds: 300,
    concurrencyLimit: 4,
  }
  return { ownerPrincipalId: OWNER, profile, identityDigest: canonicalSha256({ alias: profile.alias }), bootstrapArgv: ['ssh', 'cluster'], cwd: '/tmp', env: {} }
}

function terminalFixture(readiness: () => Promise<boolean> = async () => false) {
  const output = new EventEmitter()
  let resolveDone = (): void => {}
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  const terminal = { output, done, write: async () => {}, terminate: async () => { resolveDone() } }
  const flow = new DshAuthFlow({ spawnTerminal: async () => terminal } as never, readiness)
  return { adapter: new DshAuthFlowAdapter(flow), flow, output, resolveDone }
}

describe('DshAuthFlowAdapter', () => {
  it('acknowledges the exact lifecycle before replaying buffered PTY bytes', async () => {
    const fixture = terminalFixture()
    const created = await fixture.adapter.begin(request())
    fixture.output.emit('data', 'Password: ')
    const session = await fixture.adapter.openSocket({ principalId: OWNER, source: 'browser' })
    const frames = session.frames[Symbol.asyncIterator]()

    await session.receive({ kind: 'subscribe', flowId: created.flowId })

    await expect(frames.next()).resolves.toMatchObject({ done: false, value: { kind: 'subscribed', flowId: created.flowId, state: 'pending' } })
    const replay = await frames.next()
    expect(replay.done).toBe(false)
    expect(replay.value).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(replay.value as Uint8Array).toString('utf8')).toBe('Password: ')
    await session.close()
    await fixture.adapter.cancel(created.flowId, OWNER)
  })

  it('maps live lifecycle to pending and reports terminal tombstones without reconnect inference', async () => {
    let resolveReadiness = (_ready: boolean): void => {}
    const readiness = new Promise<boolean>(resolve => { resolveReadiness = resolve })
    const fixture = terminalFixture(async () => await readiness)
    const created = await fixture.adapter.begin(request())

    expect(fixture.flow.describe(created.flowId, OWNER).state).toBe('interactive')
    await expect(fixture.adapter.status(created.flowId, OWNER)).resolves.toEqual({ state: 'pending' })
    fixture.resolveDone()
    await vi.waitFor(() => { expect(fixture.flow.describe(created.flowId, OWNER).state).toBe('checking') })
    await expect(fixture.adapter.status(created.flowId, OWNER)).resolves.toEqual({ state: 'pending' })
    resolveReadiness(true)
    await vi.waitFor(async () => { await expect(fixture.adapter.status(created.flowId, OWNER)).resolves.toEqual({ state: 'ready' }) })
    await expect(fixture.adapter.status(created.flowId, asPrincipalId('another-owner'))).rejects.toThrow('auth flow not found')
  })
})
