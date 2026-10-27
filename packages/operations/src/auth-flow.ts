import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { SubprocessRuntime, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

export type AuthFlowState = 'starting' | 'interactive' | 'checking' | 'ready' | 'failed' | 'expired' | 'cancelled'

export interface AuthFlowRequest {
  ownerPrincipalId: string
  machineId: string
  connectionIdentityDigest: string
  argv: readonly string[]
  cwd: string
  env?: Record<string, string>
  expiresInMs: number
}

export interface AuthFlowView {
  flowId: string
  machineId: string
  connectionIdentityDigest: string
  state: AuthFlowState
  expiresAt: string
}

const MAX_REPLAY_BYTES = 65_536
const TERMINAL_TOMBSTONE_GRACE_MS = 60_000

interface OutputReplay {
  tail: Uint8Array
}

interface LiveAuthFlow {
  view: AuthFlowView
  ownerPrincipalId: string
  terminal: SubprocessTerminalHandle
  listeners: Set<(bytes: Uint8Array) => void>
  /** Bounded, memory-only terminal tail retained for every owner reattachment. */
  replay: OutputReplay
  expiry: ReturnType<typeof setTimeout>
}

interface AuthFlowTombstone {
  view: AuthFlowView
  ownerPrincipalId: string
  replay: OutputReplay
}

function appendReplay(replay: OutputReplay, chunk: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(chunk)
  if (bytes.byteLength === 0) return bytes
  if (bytes.byteLength >= MAX_REPLAY_BYTES) {
    replay.tail = bytes.slice(bytes.byteLength - MAX_REPLAY_BYTES)
    return bytes
  }
  const retainedBytes = Math.min(replay.tail.byteLength, MAX_REPLAY_BYTES - bytes.byteLength)
  const next = new Uint8Array(retainedBytes + bytes.byteLength)
  next.set(replay.tail.subarray(replay.tail.byteLength - retainedBytes))
  next.set(bytes, retainedBytes)
  replay.tail = next
  return bytes
}

/** Non-recording, owner-bound SSH authentication over DSH's host terminal primitive. */
export class DshAuthFlow {
  private closed = false
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.flows.keys()].map(id => this.finish(id, 'cancelled')))
  }
  private readonly flows = new Map<string, LiveAuthFlow>()
  private readonly tombstones = new Map<string, AuthFlowTombstone>()

  constructor(private readonly subprocess: SubprocessRuntime, private readonly readinessCheck: (request: AuthFlowRequest) => Promise<boolean>, private readonly prepareCommand?: (argv: readonly string[]) => Promise<readonly string[]>) {}

  async create(request: AuthFlowRequest): Promise<AuthFlowView> {
    if (this.closed) throw new Error('Machine authentication is closed')
    if (request.argv.length === 0 || request.argv.some(value => value.includes('\0'))) throw new Error('auth flow requires NUL-free argv')
    if (!isAbsolute(request.cwd) || request.cwd.includes('\0') || !Number.isSafeInteger(request.expiresInMs) || request.expiresInMs < 30_000 || request.expiresInMs > 15 * 60_000) throw new Error('invalid auth flow request')
    const flowId = randomBytes(32).toString('base64url')
    const view: AuthFlowView = { flowId, machineId: request.machineId, connectionIdentityDigest: request.connectionIdentityDigest, state: 'starting', expiresAt: new Date(Date.now() + request.expiresInMs).toISOString() }
    const argv = await this.prepareCommand?.(request.argv) ?? request.argv
    if (this.closed) throw new Error('Machine authentication is closed')
    const terminal = await this.subprocess.spawnTerminal({ argv, cwd: request.cwd, ...(request.env === undefined ? {} : { env: request.env }), rows: 24, cols: 100, terminalType: 'dumb', graceMs: 2_000 })
    if (this.closed) { await terminal.terminate(); throw new Error('Machine authentication is closed') }
    const expiry = setTimeout(() => { void this.finish(flowId, 'expired') }, request.expiresInMs)
    const live: LiveAuthFlow = { view: { ...view, state: 'interactive' }, ownerPrincipalId: request.ownerPrincipalId, terminal, listeners: new Set(), replay: { tail: new Uint8Array() }, expiry }
    this.flows.set(flowId, live)
    terminal.output.on('data', (chunk: Buffer | string) => {
      const bytes = appendReplay(live.replay, typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk))
      for (const listener of live.listeners) listener(bytes)
    })
    void terminal.done.then(async () => {
      if (!this.flows.has(flowId)) return
      live.view = { ...live.view, state: 'checking' }
      const ready = await this.readinessCheck(request).catch(() => false)
      if (!this.flows.has(flowId)) return
      await this.finish(flowId, ready ? 'ready' : 'failed')
    }, async () => { await this.finish(flowId, 'failed') })
    return { ...live.view }
  }

  describe(flowId: string, principalId: string): AuthFlowView {
    return { ...this.requireOwner(flowId, principalId).view }
  }

  subscribe(flowId: string, principalId: string, listener: (bytes: Uint8Array) => void): () => void {
    const flow = this.requireOwner(flowId, principalId)
    if ('listeners' in flow) flow.listeners.add(listener)
    try {
      if (flow.replay.tail.byteLength > 0) listener(flow.replay.tail.slice())
    } catch (error) {
      if ('listeners' in flow) flow.listeners.delete(listener)
      throw error
    }
    return () => { if ('listeners' in flow) flow.listeners.delete(listener) }
  }

  async write(flowId: string, principalId: string, bytes: string): Promise<void> {
    const flow = this.requireOwner(flowId, principalId)
    if (!('terminal' in flow) || flow.view.state !== 'interactive') throw new Error('auth flow does not accept input in its current state')
    if (Buffer.byteLength(bytes) > 4_096) throw new Error('auth input exceeds the per-frame limit')
    await flow.terminal.write(bytes)
  }

  async cancel(flowId: string, principalId: string): Promise<void> {
    const flow = this.requireOwner(flowId, principalId)
    if (!('terminal' in flow)) return
    await this.finish(flowId, 'cancelled')
  }

  private requireOwner(flowId: string, principalId: string): LiveAuthFlow | AuthFlowTombstone {
    const flow = this.flows.get(flowId) ?? this.tombstones.get(flowId)
    if (flow === undefined || flow.ownerPrincipalId !== principalId) throw new Error('auth flow not found')
    return flow
  }

  private async finish(flowId: string, state: Extract<AuthFlowState, 'ready' | 'failed' | 'expired' | 'cancelled'>): Promise<void> {
    const flow = this.flows.get(flowId)
    if (flow === undefined) return
    clearTimeout(flow.expiry)
    flow.view = { ...flow.view, state }
    flow.listeners.clear()
    this.flows.delete(flowId)
    const retentionMs = Math.max(TERMINAL_TOMBSTONE_GRACE_MS, Date.parse(flow.view.expiresAt) - Date.now())
    const cleanup = setTimeout(() => { this.tombstones.delete(flowId) }, retentionMs)
    cleanup.unref?.()
    this.tombstones.set(flowId, { view: { ...flow.view }, ownerPrincipalId: flow.ownerPrincipalId, replay: flow.replay })
    if (state !== 'ready') await flow.terminal.terminate()
  }
}
