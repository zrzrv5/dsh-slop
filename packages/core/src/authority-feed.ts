import { z } from 'zod'
import type { SlopWebSocketSession } from './application.ts'
import {
  AuthorityConflictError,
  LOCAL_OWNER_PRINCIPAL_ID,
  type ProjectionBaseline,
  type RelationalAuthority,
} from './authority.ts'
import {
  machineConnectionPresentationSchema,
  projectionEventSchema,
} from './domain/presentation.ts'
import {
  decimalStringSchema,
  revisionSchema,
  type DecimalString,
  type PrincipalId,
} from './primitives.ts'

export const AUTHORITY_FEED_ID = 'slop'

export const authoritySnapshotRequestSchema = z.object({
  pageSize: z.number().int().min(1).max(500).default(500),
  snapshotToken: z.string().min(1).max(2_048).optional(),
  pageCursor: decimalStringSchema.optional(),
}).strict()

const machineConnectionBaselineValueSchema = z.object({
  projection: z.literal('machine-connection'),
  id: z.string().min(1).max(512),
  revision: revisionSchema,
  value: machineConnectionPresentationSchema,
}).strict().superRefine((row, context) => {
  if (row.value.id !== row.id || row.value.revision !== row.revision) {
    context.addIssue({
      code: 'custom',
      message: 'projection value identity and revision must match its baseline envelope',
      path: ['value'],
    })
  }
})

export const authorityBaselineValueSchema = machineConnectionBaselineValueSchema

export const authorityProjectionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  feedId: z.literal(AUTHORITY_FEED_ID),
  asOfCursor: decimalStringSchema,
  snapshotToken: z.string().min(1).max(2_048),
  machineConnections: z.array(machineConnectionPresentationSchema).max(500),
}).strict()

export const authorityProjectionSnapshotPageSchema = z.object({
  snapshot: authorityProjectionSnapshotSchema,
  nextPageCursor: decimalStringSchema.optional(),
  complete: z.boolean(),
}).strict()

export const authorityFeedClientFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscribe'),
    feedId: z.literal(AUTHORITY_FEED_ID),
    asOfCursor: decimalStringSchema,
    snapshotToken: z.string().min(1).max(2_048),
  }).strict(),
  z.object({ kind: z.literal('ack'), cursor: decimalStringSchema }).strict(),
  z.object({ kind: z.literal('pong') }).strict(),
  z.object({ kind: z.literal('close') }).strict(),
])

const authorityFeedResyncReasonSchema = z.enum([
  'snapshot-token-invalid',
  'resume-before-baseline',
  'resume-ahead-of-authority',
  'cursor-gap',
  'authority-unavailable',
])

export const authorityFeedServerFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscribed'),
    feedId: z.literal(AUTHORITY_FEED_ID),
    firstCursor: decimalStringSchema,
  }).strict(),
  z.object({
    kind: z.literal('event'),
    event: projectionEventSchema,
  }).strict(),
  z.object({ kind: z.literal('heartbeat'), cursor: decimalStringSchema }).strict(),
  z.object({
    kind: z.literal('resync-required'),
    cursor: decimalStringSchema,
    reason: authorityFeedResyncReasonSchema,
  }).strict(),
])

export type AuthoritySnapshotRequest = z.output<typeof authoritySnapshotRequestSchema>
export type AuthorityProjectionSnapshotPage = z.output<typeof authorityProjectionSnapshotPageSchema>
export type AuthorityFeedServerFrame = z.output<typeof authorityFeedServerFrameSchema>

export interface AuthorityProjectionBridgeOptions {
  readonly pollIntervalMs?: number
  readonly batchSize?: number
}

class AsyncFrameQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: ((value: IteratorResult<T>) => void)[] = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter({ done: false, value })
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value !== undefined) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return await new Promise(resolve => { this.waiters.push(resolve) })
      },
    }
  }
}

function increment(cursor: DecimalString): DecimalString {
  return decimalStringSchema.parse(String(BigInt(cursor) + 1n))
}

function compare(left: DecimalString, right: DecimalString): number {
  const leftNumber = BigInt(left)
  const rightNumber = BigInt(right)
  return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
}

function projectionPage(baseline: ProjectionBaseline): AuthorityProjectionSnapshotPage {
  const rows = baseline.values
    .filter(value => value.projection === 'machine-connection')
    .map(value => authorityBaselineValueSchema.parse(value))
  return authorityProjectionSnapshotPageSchema.parse({
    snapshot: {
      schemaVersion: 1,
      feedId: AUTHORITY_FEED_ID,
      asOfCursor: baseline.asOfCursor,
      snapshotToken: baseline.snapshotToken,
      machineConnections: rows.map(row => row.value),
    },
    ...(baseline.nextPageCursor === undefined ? {} : { nextPageCursor: baseline.nextPageCursor }),
    complete: baseline.complete,
  })
}

class AuthorityFeedSession implements SlopWebSocketSession<AuthorityFeedServerFrame> {
  readonly frames: AsyncIterable<AuthorityFeedServerFrame>
  private readonly queue = new AsyncFrameQueue<AuthorityFeedServerFrame>()
  private readonly abortHandler: () => void
  private timer: ReturnType<typeof setInterval> | undefined
  private cursor: DecimalString = decimalStringSchema.parse('0')
  private acknowledgedCursor: DecimalString = decimalStringSchema.parse('0')
  private subscribed = false
  private polling = false
  private closed = false
  private lastHeartbeatAt = Date.now()

  constructor(
    private readonly authority: RelationalAuthority,
    private readonly principalId: PrincipalId,
    private readonly pollIntervalMs: number,
    private readonly batchSize: number,
    private readonly onClosed: (session: AuthorityFeedSession) => void,
    private readonly signal?: AbortSignal,
  ) {
    this.frames = this.queue
    this.abortHandler = () => { void this.close() }
    signal?.addEventListener('abort', this.abortHandler, { once: true })
  }

  async receive(frame: unknown): Promise<void> {
    if (this.closed) throw new Error('Authority feed session is closed.')
    const input = authorityFeedClientFrameSchema.parse(frame)
    switch (input.kind) {
      case 'subscribe':
        if (this.subscribed) throw new Error('Authority feed session is already subscribed.')
        await this.subscribe(input.asOfCursor, input.snapshotToken)
        return
      case 'ack':
        if (!this.subscribed) throw new Error('Authority feed acknowledgement requires an active subscription.')
        if (compare(input.cursor, this.acknowledgedCursor) < 0 || compare(input.cursor, this.cursor) > 0) {
          throw new Error('Authority feed acknowledgement cursor is outside the delivered range.')
        }
        this.acknowledgedCursor = input.cursor
        return
      case 'pong':
        return
      case 'close':
        await this.close()
        return
      default: {
        const exhaustive: never = input
        return exhaustive
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.signal?.removeEventListener('abort', this.abortHandler)
    this.queue.close()
    this.onClosed(this)
  }

  private async subscribe(resumeCursor: DecimalString, token: string): Promise<void> {
    let baselineCursor: DecimalString
    let authorityCursor: DecimalString
    try {
      baselineCursor = this.authority.baseline({
        principalId: this.principalId,
        snapshotToken: token,
        pageSize: 1,
      }).asOfCursor
      authorityCursor = this.authority.baseline({ principalId: this.principalId, pageSize: 1 }).asOfCursor
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        this.resync(resumeCursor, 'snapshot-token-invalid')
        return
      }
      this.resync(resumeCursor, 'authority-unavailable')
      await this.close()
      return
    }
    if (compare(resumeCursor, baselineCursor) < 0) {
      this.resync(resumeCursor, 'resume-before-baseline')
      return
    }
    if (compare(resumeCursor, authorityCursor) > 0) {
      this.resync(resumeCursor, 'resume-ahead-of-authority')
      return
    }
    this.cursor = resumeCursor
    this.acknowledgedCursor = resumeCursor
    this.subscribed = true
    this.push({ kind: 'subscribed', feedId: AUTHORITY_FEED_ID, firstCursor: increment(resumeCursor) })
    await this.poll()
    if (!this.closed) {
      this.timer = setInterval(() => {
        void this.poll().catch(() => {
          this.resync(this.cursor, 'authority-unavailable')
          void this.close()
        })
      }, this.pollIntervalMs)
    }
  }

  private async poll(): Promise<void> {
    if (this.closed || this.polling || !this.subscribed) return
    this.polling = true
    try {
      while (!this.closed) {
        const events = this.authority.feed({
          principalId: this.principalId,
          afterCursor: this.cursor,
          limit: this.batchSize,
        })
        if (events.length === 0) {
          if (Date.now() - this.lastHeartbeatAt >= 10_000) {
            this.push({ kind: 'heartbeat', cursor: this.cursor })
            this.lastHeartbeatAt = Date.now()
          }
          return
        }
        for (const source of events) {
          if (source.cursor !== increment(this.cursor)) {
            this.resync(source.cursor, 'cursor-gap')
            await this.close()
            return
          }
          this.cursor = source.cursor
          // Old databases may contain historical Job/Notification feed rows.
          // They remain readable by Authority for migration compatibility but
          // are not part of the Machine feed.
          if (source.projection === 'machine-connection') {
            const event = projectionEventSchema.parse(source)
            this.push({ kind: 'event', event })
          }
        }
        if (events.length < this.batchSize) return
      }
    } finally {
      this.polling = false
    }
  }

  private resync(cursor: DecimalString, reason: z.output<typeof authorityFeedResyncReasonSchema>): void {
    this.push({ kind: 'resync-required', cursor, reason })
  }

  private push(frame: AuthorityFeedServerFrame): void {
    this.queue.push(authorityFeedServerFrameSchema.parse(frame))
  }
}

/** Adapts the single relational authority to the browser baseline/feed carriers. */
export class AuthorityProjectionBridge {
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private readonly sessions = new Set<AuthorityFeedSession>()
  private closed = false

  constructor(
    private readonly authority: RelationalAuthority,
    options: AuthorityProjectionBridgeOptions = {},
  ) {
    this.pollIntervalMs = z.number().int().min(1).max(60_000).parse(options.pollIntervalMs ?? 500)
    this.batchSize = z.number().int().min(1).max(1_000).parse(options.batchSize ?? 500)
  }

  snapshot(request: unknown, principalId: PrincipalId): AuthorityProjectionSnapshotPage {
    this.assertOpen()
    this.assertPrincipal(principalId)
    const input = authoritySnapshotRequestSchema.parse(request)
    const baseline = this.authority.baseline({
      principalId,
      pageSize: input.pageSize,
      ...(input.pageCursor === undefined ? {} : { pageCursor: input.pageCursor }),
      ...(input.snapshotToken === undefined ? {} : { snapshotToken: input.snapshotToken }),
    })
    return projectionPage(baseline)
  }

  openFeed(principalId: PrincipalId, signal?: AbortSignal): SlopWebSocketSession<AuthorityFeedServerFrame> {
    this.assertOpen()
    this.assertPrincipal(principalId)
    signal?.throwIfAborted()
    const session = new AuthorityFeedSession(
      this.authority,
      principalId,
      this.pollIntervalMs,
      this.batchSize,
      closed => { this.sessions.delete(closed) },
      signal,
    )
    this.sessions.add(session)
    return session
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.sessions].map(async session => { await session.close() }))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Authority projection bridge is closed.')
  }

  private assertPrincipal(principalId: PrincipalId): void {
    if (principalId !== LOCAL_OWNER_PRINCIPAL_ID) {
      throw new AuthorityConflictError('This authority feed is scoped to the local owner.')
    }
  }
}
