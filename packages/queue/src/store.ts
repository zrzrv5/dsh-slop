import type {
  DeliveryRecord,
  QueueItem,
  QueueItemId,
  QueueObservation,
  QueueSettings,
  QueueSessionTarget,
} from './types.ts'

export interface ObservationCommit {
  readonly expectedRevision: number
  readonly item: QueueItem
  readonly observation: QueueObservation
  readonly deliveries: readonly DeliveryRecord[]
}

export interface ItemUpdateCommit {
  readonly expectedRevision: number
  readonly item: QueueItem
  readonly deliveries: readonly DeliveryRecord[]
}

export type DeliveryResultUpdate =
  | {
      readonly kind: 'delivered'
      readonly receipt?: 'consumed' | 'discarded'
      readonly target: QueueSessionTarget
      readonly triggerKey: string
      readonly deliveredAt: string
    }
  | { readonly kind: 'waiting'; readonly target: QueueSessionTarget; readonly triggerKey: string; readonly at: string; readonly nextAttemptAt: string }
  | {
      readonly kind: 'retry'
      readonly target: QueueSessionTarget
      readonly triggerKey: string
      readonly attemptedAt: string
      readonly error: string
      readonly nextAttemptAt: string
    }

/** Durable repository contract. Implementations must make observation commits atomic. */
export interface QueueStore {
  initialize(): Promise<void>
  close(): Promise<void>
  insertItem(item: QueueItem): Promise<void>
  replaceItem(item: QueueItem, expectedRevision: number): Promise<'updated' | 'revision-conflict'>
  commitObservation(commit: ObservationCommit): Promise<'updated' | 'revision-conflict'>
  commitItemUpdate(commit: ItemUpdateCommit): Promise<'updated' | 'revision-conflict'>
  getItem(id: QueueItemId): Promise<QueueItem | undefined>
  listItems(): Promise<readonly QueueItem[]>
  listDue(cutoff: string): Promise<readonly QueueItem[]>
  earliestNextCheckAt(): Promise<string | undefined>
  listObservations(id: QueueItemId): Promise<readonly QueueObservation[]>
  listPendingDeliveries(now: string): Promise<readonly DeliveryRecord[]>
  earliestPendingDeliveryAt(): Promise<string | undefined>
  checkpointShutdown(pending: readonly { dispatchId: string; messageId: string }[]): void
  prepareDelivery(records: readonly DeliveryRecord[], dispatchId: string): Promise<void>
  listDeliveries(id: QueueItemId): Promise<readonly DeliveryRecord[]>
  markDeliveries(results: readonly DeliveryResultUpdate[]): Promise<void>
  getSettings(): Promise<QueueSettings | undefined>
  replaceSettings(settings: QueueSettings, expectedRevision: number): Promise<'updated' | 'revision-conflict'>
  insertSettings(settings: QueueSettings): Promise<void>
}

export class QueueRevisionConflictError extends Error {
  constructor(readonly queueItemId: QueueItemId, readonly expectedRevision: number) {
    super(`queue item '${queueItemId}' changed from revision ${String(expectedRevision)}`)
    this.name = 'QueueRevisionConflictError'
  }
}
