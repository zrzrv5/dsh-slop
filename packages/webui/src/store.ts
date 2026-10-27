import { useSyncExternalStore } from 'react'
import type { EventFeedClient, SlopRemoteClient } from './remote-client.ts'
import type {
  Cursor,
  MachineConnectionPresentation,
  ProjectionEvent,
  SnapshotProjection,
} from './types.ts'

export type StoreStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'stale' | 'resync-required' | 'error'

export interface SlopStoreState {
  enabled?: boolean
  status: StoreStatus
  snapshot?: SnapshotProjection
  error?: string
  lastErrorCode?: string
  cursor?: Cursor
  connected: boolean
}

type Listener = () => void

function emptyState(): SlopStoreState {
  return { status: 'idle', connected: false }
}

/** One plugin-lifetime authoritative baseline and replay subscription. */
export class SlopStore {
  private state: SlopStoreState = emptyState()
  private readonly listeners = new Set<Listener>()
  private stopFeed?: () => void
  private loading?: Promise<void>
  private destroyed = false
  private active = true
  private feedGeneration = 0
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private recoveryDelay = 500

  constructor(private readonly client: SlopRemoteClient) {
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', this.resume)
      window.addEventListener('online', this.resume)
      window.addEventListener('focus', this.resume)
      document.addEventListener('visibilitychange', this.resume)
    }
  }

  private resume = (): void => {
    if (!this.active || this.destroyed || document.visibilityState === 'hidden') return
    void this.load()
  }

  getSnapshot = (): SlopStoreState => this.state

  getServerSnapshot = (): SlopStoreState => this.state

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(next: SlopStoreState): void {
    this.state = { ...next, enabled: this.active }
    for (const listener of this.listeners) listener()
  }

  suspend(): void {
    this.active = false
    this.feedGeneration += 1
    this.stopFeed?.()
    this.stopFeed = undefined
    this.clearRecovery()
    this.emit({ ...this.state, connected: false })
  }
  async activate(): Promise<void> { this.active = true; await this.load() }

  async load(): Promise<void> {
    if (!this.active || this.destroyed) return
    if (this.loading !== undefined) return this.loading
    this.clearRecovery()
    this.feedGeneration += 1
    this.stopFeed?.()
    this.stopFeed = undefined
    this.emit({ ...this.state, status: 'loading', connected: false, error: undefined, lastErrorCode: undefined })
    this.loading = this.loadPages().catch((error: unknown) => {
      if (!this.destroyed) this.emit({ ...this.state, status: 'offline', connected: false, error: error instanceof Error ? error.message : 'Unable to reload Machine connections.' })
    }).finally(() => {
      this.loading = undefined
      if (this.state.status === 'offline' || this.state.status === 'resync-required') this.scheduleRecovery()
    })
    return this.loading
  }

  private clearRecovery(): void {
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
  }

  private scheduleRecovery(): void {
    if (!this.active || this.destroyed || this.recoveryTimer !== undefined) return
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      // An in-flight baseline schedules recovery in its finally handler.
      if (this.loading !== undefined || this.destroyed) return
      this.recoveryDelay = Math.min(this.recoveryDelay * 2, 10_000)
      void this.load()
    }, this.recoveryDelay)
  }

  private async loadPages(): Promise<void> {
    const first = await this.client.call('slop.snapshot', { pageSize: 500 })
    if (!this.active || this.destroyed) return
    if (!first.ok) {
      this.emit({ ...this.state, status: first.error.retryable ? 'offline' : 'error', connected: false, error: first.error.message, lastErrorCode: first.error.code })
      return
    }
    let snapshot = first.value.snapshot
    let cursor = first.value.nextPageCursor
    while (cursor !== undefined) {
      const page = await this.client.call('slop.snapshot', { snapshotToken: first.value.snapshot.snapshotToken, pageCursor: cursor, pageSize: 500 })
      if (!this.active || this.destroyed) return
      if (!page.ok) {
        this.emit({ ...this.state, status: page.error.retryable ? 'offline' : 'error', connected: false, error: page.error.message, lastErrorCode: page.error.code })
        return
      }
      snapshot = mergeSnapshot(snapshot, page.value.snapshot)
      cursor = page.value.nextPageCursor
    }
    // Publish the baseline before subscribing: replay may arrive synchronously.
    // Publishing afterwards would discard replay and overwrite an offline state.
    this.emit({ status: 'ready', snapshot, cursor: snapshot.asOfCursor, connected: false })
    this.stopFeed = this.subscribeFeed(snapshot)
  }

  private subscribeFeed(snapshot: SnapshotProjection): (() => void) | undefined {
    const feed: EventFeedClient | undefined = this.client.events
    if (feed === undefined) return undefined
    const generation = this.feedGeneration
    const current = (): boolean => !this.destroyed && generation === this.feedGeneration
    return feed.subscribe(snapshot.feedId, snapshot.asOfCursor, snapshot.snapshotToken, event => {
      if (current()) this.receiveEvent(event)
    }, state => {
      if (!current()) return
      if (state === 'offline') {
        this.emit({ ...this.state, connected: false, status: 'offline' })
        this.scheduleRecovery()
      }
      if (state === 'resync-required') {
        this.emit({ ...this.state, connected: false, status: 'resync-required' })
        this.scheduleRecovery()
      }
      if (state === 'subscribed') {
        this.recoveryDelay = 500
        this.emit({ ...this.state, connected: true, status: 'ready' })
      }
    })
  }

  private receiveEvent(event: ProjectionEvent): void {
    const current = this.state.snapshot
    if (current === undefined || this.state.status === 'resync-required' || this.state.status === 'offline') return
    const expected = incrementCursor(this.state.cursor ?? current.asOfCursor)
    if (event.cursor !== expected) {
      this.emit({ ...this.state, status: 'resync-required', connected: false })
      this.scheduleRecovery()
      return
    }
    this.emit({ ...this.state, snapshot: applyEvent(current, event), cursor: event.cursor, status: 'ready', connected: true })
  }

  destroy(): void {
    this.destroyed = true
    this.feedGeneration += 1
    this.clearRecovery()
    this.stopFeed?.()
    this.stopFeed = undefined
    this.listeners.clear()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', this.resume)
      window.removeEventListener('online', this.resume)
      window.removeEventListener('focus', this.resume)
      document.removeEventListener('visibilitychange', this.resume)
    }
  }
}

function incrementCursor(value: string): string {
  if (!/^\d+$/u.test(value)) return value
  try { return (BigInt(value) + 1n).toString() } catch { return value }
}

function mergeById<T extends { id: string }>(left: readonly T[], right: readonly T[]): readonly T[] {
  const rows = new Map(left.map(value => [value.id, value]))
  for (const value of right) rows.set(value.id, value)
  return [...rows.values()]
}

function mergeSnapshot(base: SnapshotProjection, page: SnapshotProjection): SnapshotProjection {
  return {
    ...base,
    asOfCursor: page.asOfCursor,
    machineConnections: mergeById(base.machineConnections, page.machineConnections),
  }
}

function replaceProjection<T extends { id: string }>(rows: readonly T[], event: ProjectionEvent, value: T | undefined): readonly T[] {
  if (event.change === 'remove') return rows.filter(row => row.id !== event.id)
  if (value === undefined) return rows
  const index = rows.findIndex(row => row.id === event.id)
  if (index === -1) return [...rows, value]
  return rows.map((row, rowIndex) => rowIndex === index ? value : row)
}

function applyEvent(snapshot: SnapshotProjection, event: ProjectionEvent): SnapshotProjection {
  return {
    ...snapshot,
    asOfCursor: event.cursor,
    machineConnections: replaceProjection<MachineConnectionPresentation>(
      snapshot.machineConnections,
      event,
      event.change === 'upsert' ? event.value : undefined,
    ),
  }
}

export function createSlopStore(client: SlopRemoteClient): SlopStore {
  return new SlopStore(client)
}

export function useSlopState(store: SlopStore): SlopStoreState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
}
