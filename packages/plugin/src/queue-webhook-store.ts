import { chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { queueCallbackEventSchema, queueSessionTargetSchema, queueTargetSchema, type QueueCallbackEvent } from '@dsh-slop/queue'
import { z } from 'zod'

export const webhookSettingsSchema = z.object({
  revision: z.number().int().positive().default(1),
  enabled: z.boolean().optional(),
  provider: z.enum(['cloudflare', 'external']).default('cloudflare'),
  publicOrigin: z.string().max(2_048).default(''),
  port: z.number().int().min(1024).max(65535).default(3791),
  disabledMachineIds: z.array(z.string().min(1).max(128)).max(1_000).default([]),
  tunnelToken: z.string().max(16_384).default(''),
}).strict().superRefine((value, ctx) => {
  if (value.publicOrigin !== '') {
    try {
      const url = new URL(value.publicOrigin)
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    } catch { ctx.addIssue({ code: 'custom', path: ['publicOrigin'], message: 'Use an HTTPS origin without a path, query, or credentials' }) }
  }
})
export type WebhookSettings = z.output<typeof webhookSettingsSchema>

export const callbackLeaseSchema = z.object({
  runId: z.string().uuid(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: queueSessionTargetSchema,
  target: queueTargetSchema,
  observerKind: z.enum(['slurm', 'pbs', 'process']),
  expiresAt: z.iso.datetime(),
  bound: z.boolean(),
}).strict()
export type CallbackLease = z.output<typeof callbackLeaseSchema>
const rowSchema = z.object({ body: z.string() }).passthrough()

/** Optional extension storage. The Cloudflare token stays here; per-job capabilities are stored as hashes. */
export class QueueWebhookStore {
  private database: DatabaseSync | undefined
  constructor(readonly path: string) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.path)
    await chmod(this.path, 0o600)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, attempt INTEGER NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,attempt,sequence));`)
    db.prepare('INSERT OR IGNORE INTO settings(id,body) VALUES(1,?)').run(JSON.stringify(webhookSettingsSchema.parse({})))
    this.database = db
  }
  close(): void { this.database?.close(); this.database = undefined }
  private get db(): DatabaseSync {
    if (this.database === undefined) throw new Error('Callback store is closed')
    return this.database
  }
  settings(): WebhookSettings {
    return webhookSettingsSchema.parse(JSON.parse(rowSchema.parse(this.db.prepare('SELECT body FROM settings WHERE id=1').get()).body))
  }
  saveSettings(input: WebhookSettings, revision: number): void {
    const parsed = webhookSettingsSchema.parse(input)
    const result = this.db.prepare("UPDATE settings SET body=? WHERE id=1 AND json_extract(body,'$.revision')=?").run(JSON.stringify(parsed), revision)
    if (Number(result.changes) !== 1) throw new Error('Webhook settings changed; refresh and retry')
  }
  lease(id: string): CallbackLease | undefined {
    const row = this.db.prepare('SELECT body FROM leases WHERE id=?').get(id)
    return row === undefined ? undefined : callbackLeaseSchema.parse(JSON.parse(rowSchema.parse(row).body))
  }
  insertLease(lease: CallbackLease): void {
    const count = z.object({ count: z.number() }).parse(this.db.prepare('SELECT count(*) AS count FROM leases').get()).count
    if (count >= 10_000) throw new Error('Callback registration limit reached')
    this.db.prepare('INSERT INTO leases(id,expires_at,body) VALUES(?,?,?)').run(lease.runId, lease.expiresAt, JSON.stringify(callbackLeaseSchema.parse(lease)))
  }
  bind(lease: CallbackLease): void {
    this.db.prepare('UPDATE leases SET body=? WHERE id=?').run(JSON.stringify({ ...lease, bound: true }), lease.runId)
  }
  append(event: QueueCallbackEvent): void {
    const old = this.db.prepare('SELECT body FROM events WHERE run_id=? AND attempt=? AND sequence=?').get(event.runId, event.attempt, event.sequence)
    if (old !== undefined) {
      if (rowSchema.parse(old).body !== JSON.stringify(event)) throw new Error('Conflicting callback sequence')
      return
    }
    const count = z.object({ count: z.number() }).parse(this.db.prepare('SELECT count(*) AS count FROM events WHERE run_id=?').get(event.runId)).count
    if (count >= 100) throw new Error('Too many pending callback events')
    const total = z.object({ count: z.number() }).parse(this.db.prepare('SELECT count(*) AS count FROM events').get()).count
    if (total >= 2_000) throw new Error('Pending callback capacity reached; polling continues')
    this.db.prepare('INSERT INTO events(run_id,attempt,sequence,body) VALUES(?,?,?,?)').run(event.runId,event.attempt,event.sequence,JSON.stringify(event))
  }
  pending(runId?: string): QueueCallbackEvent[] {
    const rows = runId === undefined
      ? this.db.prepare('SELECT body FROM events ORDER BY run_id,attempt,sequence').all()
      : this.db.prepare('SELECT body FROM events WHERE run_id=? ORDER BY attempt,sequence').all(runId)
    return rows.map(row=>queueCallbackEventSchema.parse(JSON.parse(rowSchema.parse(row).body)))
  }
  acknowledge(event: QueueCallbackEvent): void {
    this.db.prepare('DELETE FROM events WHERE run_id=? AND attempt=? AND sequence=?').run(event.runId,event.attempt,event.sequence)
  }
  prune(now: Date): void {
    this.db.prepare('DELETE FROM events WHERE run_id IN (SELECT id FROM leases WHERE expires_at < ?)').run(now.toISOString())
    this.db.prepare('DELETE FROM leases WHERE expires_at < ?').run(now.toISOString())
  }
}
