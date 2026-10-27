import type { PrincipalContext, SlopAuthWebSocketSession } from '@dsh-slop/core'
import { DshAuthFlow, type AuthFlowState } from '@dsh-slop/operations'
import type { AuthFlowSeam, AuthFlowRequest } from './types.ts'

type AuthStatusState = 'pending' | 'ready' | 'failed' | 'cancelled' | 'expired'

function statusState(state: AuthFlowState): AuthStatusState {
  return state === 'ready' || state === 'failed' || state === 'cancelled' || state === 'expired' ? state : 'pending'
}

class Queue implements AsyncIterable<unknown | Uint8Array> {
  private values: (unknown | Uint8Array)[] = []; private waiters: ((value: IteratorResult<unknown | Uint8Array>) => void)[] = []; private ended = false
  push(value: unknown | Uint8Array): void { const waiter = this.waiters.shift(); if (waiter) waiter({ done: false, value }); else this.values.push(value) }
  close(): void { this.ended = true; for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined }) }
  [Symbol.asyncIterator](): AsyncIterator<unknown | Uint8Array> { return { next: async () => { const value = this.values.shift(); if (value !== undefined) return { done: false, value }; if (this.ended) return { done: true, value: undefined }; return await new Promise(resolve => this.waiters.push(resolve)) } } }
}

/** Adapts DSH's non-recording PTY primitive to the product auth Remote/socket seams. */
export class DshAuthFlowAdapter implements AuthFlowSeam {
  constructor(private readonly flow: Pick<DshAuthFlow, 'create' | 'describe' | 'subscribe' | 'write' | 'cancel'>) {}

  async begin(request: AuthFlowRequest): Promise<Readonly<{ flowId: string; expiresAt: string }>> {
    const view = await this.flow.create({ ownerPrincipalId: request.ownerPrincipalId, machineId: request.profile.machineId, connectionIdentityDigest: request.identityDigest, argv: request.bootstrapArgv, cwd: request.cwd, env: { ...request.env }, expiresInMs: 10 * 60_000 })
    return { flowId: view.flowId, expiresAt: view.expiresAt }
  }

  status(flowId: string, principalId: string): Promise<Readonly<{ state: AuthStatusState }>> {
    return Promise.resolve().then(() => ({ state: statusState(this.flow.describe(flowId, principalId).state) }))
  }

  async cancel(flowId: string, principalId: string): Promise<void> {
    await this.flow.cancel(flowId, principalId)
  }

  async openSocket(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopAuthWebSocketSession> {
    const queue = new Queue(); let flowId: string | undefined; let unsubscribe: (() => void) | undefined
    const close = async (): Promise<void> => { unsubscribe?.(); queue.close() }
    signal?.addEventListener('abort', () => { void close() }, { once: true })
    return {
      frames: queue,
      receive: async frame => {
        const input = frame as { kind?: unknown; flowId?: unknown }
        if (input.kind === 'subscribe' && typeof input.flowId === 'string') {
          const view = this.flow.describe(input.flowId, principal.principalId)
          flowId = input.flowId
          unsubscribe?.()
          queue.push({ kind: 'subscribed', flowId, state: statusState(view.state) })
          unsubscribe = this.flow.subscribe(flowId, principal.principalId, bytes => queue.push(bytes))
        } else if (input.kind === 'close') await close()
        else if (input.kind !== 'ack' && input.kind !== 'pong') throw new Error('auth socket requires a flow subscription')
      },
      receiveBinary: async bytes => { if (flowId === undefined) throw new Error('auth socket is not subscribed'); await this.flow.write(flowId, principal.principalId, Buffer.from(bytes).toString('utf8')) },
      close,
    }
  }
}
