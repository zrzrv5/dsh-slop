import { z } from 'zod'
import {
  AccessCoordinator,
  cancelConnectionWaiterRequestSchema,
  type RequireConnectionResult,
  type ResolveAccessChallengeResult,
} from './access-coordinator.ts'
import type {
  ConnectionLease,
  PendingConnectionWaiter,
} from './domain/access.ts'

export const connectionCallFailureCodeSchema = z.enum(['CANCELLED', 'STALE', 'UNAVAILABLE'])
export type ConnectionCallFailureCode = z.output<typeof connectionCallFailureCodeSchema>
export type ConnectionCallResult = Extract<RequireConnectionResult, { readonly kind: 'ready' }>

export class ConnectionCallError extends Error {
  constructor(
    readonly code: ConnectionCallFailureCode,
    readonly waiterId: PendingConnectionWaiter['id'] | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ConnectionCallError'
  }
}

export class ConnectionCallCancelledError extends ConnectionCallError {
  constructor(waiterId?: PendingConnectionWaiter['id']) {
    super('CANCELLED', waiterId, 'The pending connection call was cancelled.')
    this.name = 'ConnectionCallCancelledError'
  }
}

export class ConnectionCallStaleError extends ConnectionCallError {
  constructor(waiterId: PendingConnectionWaiter['id']) {
    super('STALE', waiterId, 'The connection request expired or its access settings changed. Connect again in this Chat.')
    this.name = 'ConnectionCallStaleError'
  }
}

export class ConnectionCallUnavailableError extends ConnectionCallError {
  constructor(waiterId: PendingConnectionWaiter['id']) {
    super('UNAVAILABLE', waiterId, 'The host restarted before the pending connection call could continue.')
    this.name = 'ConnectionCallUnavailableError'
  }
}

export interface RestartRecoveredConnectionCall {
  readonly kind: 'failed'
  readonly waiter: PendingConnectionWaiter
  readonly error: ConnectionCallUnavailableError
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (reason: unknown) => void
}

interface PendingCall extends Deferred<ConnectionCallResult> {
  readonly waiter: PendingConnectionWaiter
  readonly detachAbort?: () => void
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined
  let rejectPromise: ((reason: unknown) => void) | undefined
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error('Promise executor did not initialize synchronously.')
  }
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Bridges durable connection waiters to exact in-process tool-call Promises.
 * Protected authentication traffic remains outside this adapter.
 */
export class PendingConnectionCallAdapter {
  private readonly calls = new Map<PendingConnectionWaiter['id'], PendingCall>()
  private expiryTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly coordinator: AccessCoordinator) {}

  requireConnection(input: unknown, signal?: AbortSignal): Promise<ConnectionCallResult> {
    if (isAborted(signal)) return Promise.reject(new ConnectionCallCancelledError())
    const result = this.coordinator.requireConnection(input)
    if (result.kind === 'ready') return Promise.resolve(result)
    const existing = this.calls.get(result.waiter.id)
    if (existing !== undefined) return existing.promise
    if (isAborted(signal)) {
      this.coordinator.cancelWaiter({ waiterId: result.waiter.id })
      return Promise.reject(new ConnectionCallCancelledError(result.waiter.id))
    }

    const pending = deferred<ConnectionCallResult>()
    const onAbort = (): void => {
      this.cancelWaiter({ waiterId: result.waiter.id })
    }
    const call: PendingCall = {
      ...pending,
      waiter: result.waiter,
      ...(signal === undefined ? {} : {
        detachAbort: () => { signal.removeEventListener('abort', onAbort) },
      }),
    }
    this.calls.set(result.waiter.id, call)
    // Expiry must settle the suspended Tool even when no browser is attached
    // and no further access operation arrives to trigger reconciliation.
    if (this.expiryTimer === undefined) {
      this.expiryTimer = setInterval(() => { this.settleStaleCalls() }, 1_000)
      this.expiryTimer.unref()
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    if (isAborted(signal)) onAbort()
    return call.promise
  }

  resolveChallenge(input: unknown): ResolveAccessChallengeResult {
    let result: ResolveAccessChallengeResult
    try {
      result = this.coordinator.resolveChallenge(input)
    } catch (error) {
      this.settleStaleCalls()
      throw error
    }
    const settled = new Set<PendingConnectionWaiter['id']>()
    for (const lease of result.leases) {
      if (lease.waiterId === undefined) continue
      const call = this.calls.get(lease.waiterId)
      if (call === undefined) continue
      this.resolveCall(call, lease, result)
      settled.add(lease.waiterId)
    }
    for (const waiterId of result.skippedWaiterIds) {
      const call = this.calls.get(waiterId)
      if (call === undefined) continue
      this.rejectCall(call, new ConnectionCallStaleError(waiterId))
      settled.add(waiterId)
    }
    for (const call of this.calls.values()) {
      if (call.waiter.challengeId !== result.challenge.id || settled.has(call.waiter.id)) continue
      this.rejectCall(call, new ConnectionCallStaleError(call.waiter.id))
    }
    return result
  }

  cancelWaiter(input: unknown): boolean {
    const request = cancelConnectionWaiterRequestSchema.parse(input)
    const cancelled = this.coordinator.cancelWaiter(request)
    const call = this.calls.get(request.waiterId)
    if (call !== undefined) this.rejectCall(call, new ConnectionCallCancelledError(request.waiterId))
    return cancelled || call !== undefined
  }

  settleStaleCalls(): readonly ConnectionCallStaleError[] {
    const errors: ConnectionCallStaleError[] = []
    for (const call of this.calls.values()) {
      if (this.coordinator.isWaiterCurrent(call.waiter.id)) continue
      this.coordinator.cancelWaiter({ waiterId: call.waiter.id })
      const error = new ConnectionCallStaleError(call.waiter.id)
      errors.push(error)
      this.rejectCall(call, error)
    }
    return errors
  }

  settleRestartRecoveredWaiters(): readonly RestartRecoveredConnectionCall[] {
    const settlements: RestartRecoveredConnectionCall[] = []
    for (const waiter of this.coordinator.pendingWaiters()) {
      if (this.calls.has(waiter.id)) continue
      this.coordinator.cancelWaiter({ waiterId: waiter.id })
      settlements.push({
        kind: 'failed',
        waiter,
        error: new ConnectionCallUnavailableError(waiter.id),
      })
    }
    this.coordinator.settleAbandonedChallenges()
    return settlements
  }

  settleUnavailable(): readonly ConnectionCallUnavailableError[] {
    const errors: ConnectionCallUnavailableError[] = []
    for (const call of this.calls.values()) {
      this.coordinator.cancelWaiter({ waiterId: call.waiter.id })
      const error = new ConnectionCallUnavailableError(call.waiter.id)
      errors.push(error)
      this.rejectCall(call, error)
    }
    return errors
  }

  pendingWaiterIds(): readonly PendingConnectionWaiter['id'][] {
    return [...this.calls.keys()]
  }

  private resolveCall(
    call: PendingCall,
    lease: ConnectionLease,
    result: ResolveAccessChallengeResult,
  ): void {
    this.calls.delete(call.waiter.id)
    this.stopExpiryTimerIfIdle()
    call.detachAbort?.()
    call.resolve({
      kind: 'ready',
      observation: result.observation,
      lease,
      presentation: result.presentation,
    })
  }

  private rejectCall(call: PendingCall, error: ConnectionCallError): void {
    this.calls.delete(call.waiter.id)
    this.stopExpiryTimerIfIdle()
    call.detachAbort?.()
    call.reject(error)
  }

  private stopExpiryTimerIfIdle(): void {
    if (this.calls.size !== 0 || this.expiryTimer === undefined) return
    clearInterval(this.expiryTimer)
    this.expiryTimer = undefined
  }
}
