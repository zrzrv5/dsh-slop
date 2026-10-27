import { randomBytes } from 'node:crypto'
import type { AuthFlowRequest, AuthFlowView } from '@dsh-slop/operations'

export interface NativeAuthPrompt {
  readonly signal: AbortSignal
  prompt(label: string): Promise<string>
}

interface Flow {
  view: AuthFlowView
  owner: string
  controller: AbortController
  listeners: Set<(bytes: Uint8Array) => void>
  replay: Buffer
  input: string
  answer?: { resolve(value: string): void; reject(error: Error): void }
  expiry: ReturnType<typeof setTimeout>
}

/** Owner-bound, memory-only prompts over the existing protected terminal socket. */
export class NativeAuthFlow {
  private readonly flows = new Map<string, Flow>()
  private closed = false

  constructor(private readonly authenticate: (request: AuthFlowRequest, prompt: NativeAuthPrompt) => Promise<void>) {}

  async create(request: AuthFlowRequest): Promise<AuthFlowView> {
    if (this.closed) throw new Error('Machine authentication is closed')
    if (!Number.isSafeInteger(request.expiresInMs) || request.expiresInMs < 30_000 || request.expiresInMs > 15 * 60_000) throw new Error('Invalid authentication lifetime')
    const flowId = randomBytes(32).toString('base64url')
    const view: AuthFlowView = { flowId, machineId: request.machineId, connectionIdentityDigest: request.connectionIdentityDigest, state: 'interactive', expiresAt: new Date(Date.now() + request.expiresInMs).toISOString() }
    const flow: Flow = { view, owner: request.ownerPrincipalId, controller: new AbortController(), listeners: new Set(), replay: Buffer.alloc(0), input: '', expiry: setTimeout(() => this.finish(flowId, 'expired'), request.expiresInMs) }
    flow.expiry.unref()
    this.flows.set(flowId, flow)
    void this.authenticate(request, {
      signal: flow.controller.signal,
      prompt: async label => {
        flow.controller.signal.throwIfAborted()
        if (flow.answer !== undefined) throw new Error('An authentication prompt is already pending')
        return await new Promise<string>((resolve, reject) => {
          flow.input = ''
          flow.answer = { resolve, reject }
          // Remote prompt text cannot inject terminal controls. Never echo input,
          // including keyboard-interactive prompts whose server requests echo.
          this.output(flow, label.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ').slice(0, 4096))
        })
      },
    }).then(() => this.finish(flowId, 'ready'), () => {
      if (!flow.controller.signal.aborted) this.output(flow, '\r\nAuthentication failed. Reconnect to try again.\r\n')
      this.finish(flowId, 'failed')
    })
    return { ...view }
  }

  describe(id: string, owner: string): AuthFlowView { return { ...this.requireOwner(id, owner).view } }

  subscribe(id: string, owner: string, listener: (bytes: Uint8Array) => void): () => void {
    const flow = this.requireOwner(id, owner)
    flow.listeners.add(listener)
    try { if (flow.replay.length) listener(Buffer.from(flow.replay)) } catch (error) { flow.listeners.delete(listener); throw error }
    return () => { flow.listeners.delete(listener) }
  }

  async write(id: string, owner: string, bytes: string): Promise<void> {
    const flow = this.requireOwner(id, owner)
    if (flow.view.state !== 'interactive') throw new Error('Authentication does not accept input in its current state')
    if (Buffer.byteLength(bytes) > 4096) throw new Error('Auth input exceeds the per-frame limit')
    if (bytes.includes('\x03')) { this.finish(id, 'cancelled'); return }
    if (flow.answer === undefined) return
    for (const char of bytes) {
      if (char === '\r' || char === '\n') {
        const answer = flow.answer
        const value = flow.input
        flow.input = ''
        delete flow.answer
        this.output(flow, '\r\n')
        answer.resolve(value)
        // Discard remaining pasted lines, never carry secrets to the next prompt.
        break
      }
      if (char === '\x7f' || char === '\b') flow.input = [...flow.input].slice(0, -1).join('')
      else if (char >= ' ' && char !== '\x1b') flow.input += char
      if (Buffer.byteLength(flow.input) > 4096) { this.finish(id, 'failed'); throw new Error('Auth response exceeds the limit') }
    }
  }

  async cancel(id: string, owner: string): Promise<void> { this.requireOwner(id, owner); this.finish(id, 'cancelled') }

  async close(): Promise<void> {
    this.closed = true
    for (const id of this.flows.keys()) this.finish(id, 'cancelled')
    this.flows.clear()
  }

  private requireOwner(id: string, owner: string): Flow {
    const flow = this.flows.get(id)
    if (flow === undefined || flow.owner !== owner) throw new Error('auth flow not found')
    return flow
  }

  private output(flow: Flow, text: string): void {
    const bytes = Buffer.from(text)
    flow.replay = Buffer.concat([flow.replay, bytes]).subarray(-65_536)
    for (const listener of flow.listeners) listener(bytes)
  }

  private finish(id: string, state: 'ready' | 'failed' | 'expired' | 'cancelled'): void {
    const flow = this.flows.get(id)
    if (flow === undefined || flow.view.state !== 'interactive') return
    clearTimeout(flow.expiry)
    flow.view = { ...flow.view, state }
    flow.input = ''
    flow.answer?.reject(new Error('Authentication ended'))
    delete flow.answer
    if (state !== 'ready') flow.controller.abort(new Error('Authentication ended'))
    flow.listeners.clear()
    const cleanup = setTimeout(() => this.flows.delete(id), Math.max(60_000, Date.parse(flow.view.expiresAt) - Date.now()))
    cleanup.unref()
  }
}
