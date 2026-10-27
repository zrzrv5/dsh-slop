import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { z } from 'zod'
import type { DeliveryResultUpdate, ItemUpdateCommit, ObservationCommit, QueueStore } from './store.ts'
import {
  deliveryRecordSchema,
  queueItemIdSchema,
  queueItemSchema,
  queueObservationSchema,
  queueSettingsSchema,
  type DeliveryRecord,
  type QueueItem,
  type QueueItemId,
  type QueueObservation,
  type QueueSettings,
} from './types.ts'

const QUEUE_SCHEMA_VERSION = 1

const bodyRowSchema = z.object({ body: z.string() }).passthrough()
const bodyRowsSchema = z.array(bodyRowSchema)
const nextCheckRowSchema = z.object({ next_check_at: z.string().nullable() }).passthrough()
const schemaVersionRowSchema = z.object({ version: z.number().int().positive() }).passthrough()

function parseItemBody(body: string): QueueItem {
  return queueItemSchema.parse(JSON.parse(body))
}

function parseObservationBody(body: string): QueueObservation {
  return queueObservationSchema.parse(JSON.parse(body))
}

function parseDeliveryBody(body: string): DeliveryRecord {
  return deliveryRecordSchema.parse(JSON.parse(body))
}

function parseSettingsBody(body: string): QueueSettings {
  return queueSettingsSchema.parse(JSON.parse(body))
}

function itemParameters(item: QueueItem): readonly [string, string, string, string, string | null, string] {
  const targetKey = item.target.kind === 'local' ? 'local' : `machine:${item.target.machineId}`
  return [item.id, targetKey, item.observer.kind, item.state, item.nextCheckAt ?? null, JSON.stringify(item)]
}

/** SQLite-backed Queue ledger with atomic item, observation, and delivery commits. */
export class SqliteQueueStore implements QueueStore {
  private database: DatabaseSync | undefined

  constructor(readonly path: string) {}

  async initialize(): Promise<void> {
    if (this.database !== undefined) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const database = new DatabaseSync(this.path)
    try {
      database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;')
      database.exec(`
        CREATE TABLE IF NOT EXISTS queue_schema (
          version INTEGER NOT NULL CHECK(version >= 1)
        );
        CREATE TABLE IF NOT EXISTS queue_items (
          id TEXT PRIMARY KEY,
          target_key TEXT NOT NULL,
          observer_kind TEXT NOT NULL CHECK(observer_kind IN ('slurm','pbs','process')),
          state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled','unknown')),
          next_check_at TEXT,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          body TEXT NOT NULL CHECK(json_valid(body))
        );
        CREATE INDEX IF NOT EXISTS queue_items_due ON queue_items(next_check_at, target_key, observer_kind);
        CREATE TABLE IF NOT EXISTS queue_observations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE RESTRICT,
          observed_at TEXT NOT NULL,
          body TEXT NOT NULL CHECK(json_valid(body))
        );
        CREATE INDEX IF NOT EXISTS queue_observations_item_time ON queue_observations(item_id, observed_at, sequence);
        CREATE TABLE IF NOT EXISTS queue_deliveries (
          session_id TEXT NOT NULL,
          trigger_key TEXT NOT NULL,
          delivery TEXT NOT NULL CHECK(delivery IN ('wake','notify')),
          state TEXT NOT NULL CHECK(state IN ('pending','delivered')),
          next_attempt_at TEXT,
          body TEXT NOT NULL CHECK(json_valid(body)),
          PRIMARY KEY(session_id, trigger_key)
        );
        CREATE INDEX IF NOT EXISTS queue_deliveries_pending ON queue_deliveries(state, session_id, delivery);
        CREATE TABLE IF NOT EXISTS queue_settings (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          revision INTEGER NOT NULL CHECK(revision >= 1),
          body TEXT NOT NULL CHECK(json_valid(body))
        );
      `)
      const versionRow = database.prepare('SELECT version FROM queue_schema LIMIT 1').get()
      if (versionRow === undefined) {
        database.prepare('INSERT INTO queue_schema(version) VALUES (?)').run(QUEUE_SCHEMA_VERSION)
      } else {
        const parsed = schemaVersionRowSchema.parse(versionRow)
        if (parsed.version !== QUEUE_SCHEMA_VERSION) {
          throw new Error(`queue schema ${String(parsed.version)} is not supported`)
        }
      }
      this.database = database
    } catch (error) {
      database.close()
      throw error
    }
  }

  async close(): Promise<void> {
    this.database?.close()
    this.database = undefined
  }

  async insertItem(item: QueueItem): Promise<void> {
    const database = this.requireDatabase()
    const [id, target, observer, state, nextCheckAt, body] = itemParameters(item)
    database.prepare(`
      INSERT INTO queue_items(id,target_key,observer_kind,state,next_check_at,revision,body)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, target, observer, state, nextCheckAt, item.revision, body)
  }

  async replaceItem(item: QueueItem, expectedRevision: number): Promise<'updated' | 'revision-conflict'> {
    const database = this.requireDatabase()
    const [id, target, observer, state, nextCheckAt, body] = itemParameters(item)
    const result = database.prepare(`
      UPDATE queue_items
      SET target_key=?, observer_kind=?, state=?, next_check_at=?, revision=?, body=?
      WHERE id=? AND revision=?
    `).run(target, observer, state, nextCheckAt, item.revision, body, id, expectedRevision)
    return Number(result.changes) === 1 ? 'updated' : 'revision-conflict'
  }

  async commitObservation(commit: ObservationCommit): Promise<'updated' | 'revision-conflict'> {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE;')
    try {
      const [id, target, observer, state, nextCheckAt, body] = itemParameters(commit.item)
      const update = database.prepare(`
        UPDATE queue_items
        SET target_key=?, observer_kind=?, state=?, next_check_at=?, revision=?, body=?
        WHERE id=? AND revision=?
      `).run(target, observer, state, nextCheckAt, commit.item.revision, body, id, commit.expectedRevision)
      if (Number(update.changes) !== 1) {
        database.exec('ROLLBACK;')
        return 'revision-conflict'
      }
      database.prepare(`
        INSERT INTO queue_observations(item_id,observed_at,body) VALUES (?,?,?)
      `).run(commit.observation.queueItemId, commit.observation.observedAt, JSON.stringify(commit.observation))
      const insertDelivery = database.prepare(`
        INSERT OR IGNORE INTO queue_deliveries(session_id,trigger_key,delivery,state,next_attempt_at,body)
        VALUES (?,?,?,?,?,?)
      `)
      for (const delivery of commit.deliveries) this.insertDelivery(insertDelivery, delivery)
      database.exec('COMMIT;')
      return 'updated'
    } catch (error) {
      this.rollback(database)
      throw error
    }
  }

  async commitItemUpdate(commit: ItemUpdateCommit): Promise<'updated' | 'revision-conflict'> {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE;')
    try {
      const [id, target, observer, state, nextCheckAt, body] = itemParameters(commit.item)
      const update = database.prepare(`
        UPDATE queue_items
        SET target_key=?, observer_kind=?, state=?, next_check_at=?, revision=?, body=?
        WHERE id=? AND revision=?
      `).run(target, observer, state, nextCheckAt, commit.item.revision, body, id, commit.expectedRevision)
      if (Number(update.changes) !== 1) {
        database.exec('ROLLBACK;')
        return 'revision-conflict'
      }
      const insertDelivery = database.prepare(`
        INSERT OR IGNORE INTO queue_deliveries(session_id,trigger_key,delivery,state,next_attempt_at,body)
        VALUES (?,?,?,?,?,?)
      `)
      for (const delivery of commit.deliveries) this.insertDelivery(insertDelivery, delivery)
      database.exec('COMMIT;')
      return 'updated'
    } catch (error) {
      this.rollback(database)
      throw error
    }
  }

  async getItem(id: QueueItemId): Promise<QueueItem | undefined> {
    const row = this.requireDatabase().prepare('SELECT body FROM queue_items WHERE id=?').get(id)
    if (row === undefined) return undefined
    return parseItemBody(bodyRowSchema.parse(row).body)
  }

  async listItems(): Promise<readonly QueueItem[]> {
    const rows = bodyRowsSchema.parse(this.requireDatabase().prepare(`
      SELECT body FROM queue_items ORDER BY json_extract(body, '$.createdAt'), id
    `).all())
    return rows.map((row) => parseItemBody(row.body))
  }

  async listDue(cutoff: string): Promise<readonly QueueItem[]> {
    const rows = bodyRowsSchema.parse(this.requireDatabase().prepare(`
      SELECT body FROM queue_items
      WHERE next_check_at IS NOT NULL AND next_check_at <= ?
      ORDER BY next_check_at, id
    `).all(cutoff))
    return rows.map((row) => parseItemBody(row.body))
  }

  async earliestNextCheckAt(): Promise<string | undefined> {
    const row = nextCheckRowSchema.parse(this.requireDatabase().prepare(`
      SELECT MIN(next_check_at) AS next_check_at FROM queue_items WHERE next_check_at IS NOT NULL
    `).get())
    return row.next_check_at ?? undefined
  }

  async listObservations(id: QueueItemId): Promise<readonly QueueObservation[]> {
    const parsedId = queueItemIdSchema.parse(id)
    const rows = bodyRowsSchema.parse(this.requireDatabase().prepare(`
      SELECT body FROM queue_observations WHERE item_id=? ORDER BY observed_at, sequence
    `).all(parsedId))
    return rows.map((row) => parseObservationBody(row.body))
  }

  async listPendingDeliveries(now: string): Promise<readonly DeliveryRecord[]> {
    const rows = bodyRowsSchema.parse(this.requireDatabase().prepare(`
      SELECT body FROM queue_deliveries
      WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY session_id, delivery, trigger_key
    `).all(now))
    return rows.map((row) => parseDeliveryBody(row.body))
  }

  async earliestPendingDeliveryAt(): Promise<string | undefined> {
    const row = nextCheckRowSchema.parse(this.requireDatabase().prepare(`
      SELECT MIN(COALESCE(next_attempt_at, json_extract(body, '$.createdAt'))) AS next_check_at
      FROM queue_deliveries WHERE state='pending'
    `).get())
    return row.next_check_at ?? undefined
  }

  async listDeliveries(id: QueueItemId): Promise<readonly DeliveryRecord[]> {
    return bodyRowsSchema.parse(this.requireDatabase().prepare("SELECT body FROM queue_deliveries WHERE json_extract(body, '$.trigger.queueItemId')=? ORDER BY json_extract(body, '$.createdAt'), trigger_key").all(id)).map(row => parseDeliveryBody(row.body))
  }

  checkpointShutdown(pending: readonly { dispatchId: string; messageId: string }[]): void {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE;')
    try {
      const update = database.prepare("UPDATE queue_deliveries SET body=json_set(body, '$.shutdownMessageId', ?) WHERE state='pending' AND json_extract(body, '$.dispatchId')=?")
      for (const entry of pending) update.run(entry.messageId, entry.dispatchId)
      database.exec('COMMIT;')
    } catch (error) { this.rollback(database); throw error }
  }

  async prepareDelivery(records: readonly DeliveryRecord[], dispatchId: string): Promise<void> {
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE;')
    try {
      const read = database.prepare('SELECT body FROM queue_deliveries WHERE session_id=? AND trigger_key=?')
      const update = database.prepare('UPDATE queue_deliveries SET body=? WHERE session_id=? AND trigger_key=?')
      for (const record of records) {
        const current = parseDeliveryBody(bodyRowSchema.parse(read.get(record.target.sessionId, record.trigger.triggerKey)).body)
        if (current.dispatchId !== undefined && current.dispatchId !== dispatchId) throw new Error('Queue delivery already belongs to another dispatch')
        const next = deliveryRecordSchema.parse({ ...current, dispatchId })
        update.run(JSON.stringify(next), current.target.sessionId, current.trigger.triggerKey)
      }
      database.exec('COMMIT;')
    } catch (error) { this.rollback(database); throw error }
  }

  async markDeliveries(results: readonly DeliveryResultUpdate[]): Promise<void> {
    if (results.length === 0) return
    const database = this.requireDatabase()
    database.exec('BEGIN IMMEDIATE;')
    try {
      const getDelivery = database.prepare('SELECT body FROM queue_deliveries WHERE session_id=? AND trigger_key=?')
      const updateDelivery = database.prepare(`
        UPDATE queue_deliveries SET state=?, next_attempt_at=?, body=?
        WHERE session_id=? AND trigger_key=? AND state='pending'
      `)
      for (const result of results) {
        const row = getDelivery.get(result.target.sessionId, result.triggerKey)
        if (row === undefined) continue
        const current = parseDeliveryBody(bodyRowSchema.parse(row).body)
        if (result.kind === 'waiting') {
          const { lastError: _lastError, ...retained } = current
          const next = deliveryRecordSchema.parse({ ...retained, receipt: 'enqueued', updatedAt: result.at, nextAttemptAt: result.nextAttemptAt })
          updateDelivery.run('pending', result.nextAttemptAt, JSON.stringify(next), next.target.sessionId, next.trigger.triggerKey)
        } else if (result.kind === 'delivered') {
          const { lastError: _lastError, nextAttemptAt: _nextAttemptAt, ...base } = current
          const next = deliveryRecordSchema.parse({
            ...base,
            state: 'delivered',
            ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
            attempts: current.attempts + 1,
            updatedAt: result.deliveredAt,
            deliveredAt: result.deliveredAt,
          })
          updateDelivery.run(next.state, null, JSON.stringify(next), next.target.sessionId, next.trigger.triggerKey)
        } else {
          const next = deliveryRecordSchema.parse({
            ...current,
            state: 'pending',
            attempts: current.attempts + 1,
            updatedAt: result.attemptedAt,
            lastError: result.error,
            nextAttemptAt: result.nextAttemptAt,
          })
          updateDelivery.run(next.state, result.nextAttemptAt, JSON.stringify(next), next.target.sessionId, next.trigger.triggerKey)
        }
      }
      database.exec('COMMIT;')
    } catch (error) {
      this.rollback(database)
      throw error
    }
  }

  async getSettings(): Promise<QueueSettings | undefined> {
    const row = this.requireDatabase().prepare('SELECT body FROM queue_settings WHERE singleton=1').get()
    if (row === undefined) return undefined
    return parseSettingsBody(bodyRowSchema.parse(row).body)
  }

  async insertSettings(settings: QueueSettings): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO queue_settings(singleton,revision,body) VALUES (1,?,?)
    `).run(settings.revision, JSON.stringify(settings))
  }

  async replaceSettings(settings: QueueSettings, expectedRevision: number): Promise<'updated' | 'revision-conflict'> {
    const result = this.requireDatabase().prepare(`
      UPDATE queue_settings SET revision=?, body=? WHERE singleton=1 AND revision=?
    `).run(settings.revision, JSON.stringify(settings), expectedRevision)
    return Number(result.changes) === 1 ? 'updated' : 'revision-conflict'
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) throw new Error('queue store is not initialized')
    return this.database
  }

  private insertDelivery(statement: StatementSync, delivery: DeliveryRecord): void {
    statement.run(
      delivery.target.sessionId,
      delivery.trigger.triggerKey,
      delivery.delivery,
      delivery.state,
      delivery.nextAttemptAt ?? null,
      JSON.stringify(delivery),
    )
  }

  private rollback(database: DatabaseSync): void {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // The failing statement may already have ended the transaction.
    }
  }
}
