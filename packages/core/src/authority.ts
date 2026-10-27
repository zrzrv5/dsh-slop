import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { canonicalSha256, createUuidV7 } from './canonical.ts'
import type { JsonValue } from './canonical.ts'
import {
  approvalReceiptIdSchema,
  decimalStringSchema,
  instantSchema,
  principalIdSchema,
  revisionSchema,
  sha256Schema,
  toInstant,
  type DecimalString,
  type Instant,
  type PrincipalId,
  type Revision,
  type Sha256,
} from './primitives.ts'
import { jsonValueSchema } from './schemas.ts'

export const AUTHORITY_SCHEMA_VERSION = 1
const PRODUCT_MARKER = '.dsh-slop-redesign-v1'
const AUTHORITY_DATABASE = 'authority.sqlite'
const LOCAL_OWNER_TEXT = 'local-owner'
const domainNameSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(128)
const entityIdSchema = z.string().min(1).max(512)
const projectionNameSchema = z.literal('machine-connection')
const auditKindSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(256)

const databaseAuthorityRowSchema = z.object({
  domain: domainNameSchema,
  id: entityIdSchema,
  ownerPrincipalId: principalIdSchema,
  revision: revisionSchema,
  payloadJson: z.string(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
}).strict()

const databaseProjectionRowSchema = z.object({
  projection: projectionNameSchema,
  id: entityIdSchema,
  ownerPrincipalId: principalIdSchema,
  revision: revisionSchema,
  valueJson: z.string(),
}).strict()

const databaseFeedRowSchema = z.object({
  cursor: z.number().int().positive(),
  projection: projectionNameSchema,
  id: entityIdSchema,
  revision: revisionSchema,
  change: z.enum(['upsert', 'remove']),
  valueJson: z.string().nullable(),
}).strict()

const databaseApprovalRowSchema = z.object({
  id: approvalReceiptIdSchema,
  ownerPrincipalId: principalIdSchema,
  effectDigest: sha256Schema,
  state: z.enum(['active', 'consumed', 'revoked']),
  expiresAt: instantSchema,
  createdAt: instantSchema,
  consumedAt: instantSchema.nullable(),
}).strict()

const databaseIdempotencyRowSchema = z.object({
  requestHash: sha256Schema,
  resultJson: z.string(),
}).strict()

const databaseAuditRowSchema = z.object({
  sequence: z.number().int().positive(),
  kind: auditKindSchema,
  subjectDomain: domainNameSchema,
  subjectId: entityIdSchema,
  detailsJson: z.string(),
  createdAt: instantSchema,
}).strict()

const databaseMetaSchema = z.object({ value: z.string() }).strict()
const databaseChangesSchema = z.object({ changes: z.union([z.number().int().nonnegative(), z.bigint().nonnegative()]) }).passthrough()

/** This local deployment exposes one principal while every row still carries its owner. */
export const LOCAL_OWNER_PRINCIPAL_ID: PrincipalId = principalIdSchema.parse(LOCAL_OWNER_TEXT)

/** Resolves the transport-owned principal. Public requests never choose it. */
export function resolveLocalOwnerPrincipal(): PrincipalId {
  return LOCAL_OWNER_PRINCIPAL_ID
}

/** One typed authority row. Domain services validate the JSON payload. */
export interface AuthorityRecord {
  readonly domain: string
  readonly id: string
  readonly ownerPrincipalId: PrincipalId
  readonly revision: Revision
  readonly value: JsonValue
  readonly createdAt: Instant
  readonly updatedAt: Instant
}

export type AuthorityMutation =
  | { readonly kind: 'insert'; readonly domain: string; readonly id: string; readonly value: JsonValue }
  | { readonly kind: 'replace'; readonly domain: string; readonly id: string; readonly expectedRevision: Revision; readonly value: JsonValue }
  | { readonly kind: 'remove'; readonly domain: string; readonly id: string; readonly expectedRevision: Revision }

export type ProjectionName = z.output<typeof projectionNameSchema>

export type ProjectionMutation =
  | {
      readonly kind: 'upsert'
      readonly projection: ProjectionName
      readonly id: string
      /** Zero creates a new projection. A positive value replaces that exact revision. */
      readonly expectedRevision: number
      readonly value: JsonValue
    }
  | {
      readonly kind: 'remove'
      readonly projection: ProjectionName
      readonly id: string
      readonly expectedRevision: Revision
    }

export interface AuthorityAuditInput {
  readonly kind: string
  readonly subjectDomain: string
  readonly subjectId: string
  readonly details: JsonValue
}

export interface AuthorityApprovalInput {
  readonly receiptId: string
  readonly effectDigest: Sha256
}

export interface AuthorityApprovalIssueInput {
  readonly receiptId: string
  readonly effectDigest: Sha256
  readonly expiresAt: Instant
}

export interface AuthorityIdempotencyInput {
  readonly scope: string
  readonly key: string
  readonly request: JsonValue
  readonly result: JsonValue
}

export type AuthorityIdempotencyLookupInput = Omit<AuthorityIdempotencyInput, 'result'>

export interface AuthorityTransactionInput {
  readonly principalId: PrincipalId
  readonly mutations?: readonly AuthorityMutation[]
  readonly projections?: readonly ProjectionMutation[]
  readonly audit?: readonly AuthorityAuditInput[]
  readonly issueApproval?: AuthorityApprovalIssueInput
  readonly approval?: AuthorityApprovalInput
  readonly idempotency?: AuthorityIdempotencyInput
}

export type AuthorityTransactionResult =
  | { readonly kind: 'committed'; readonly records: readonly AuthorityRecord[]; readonly result?: JsonValue }
  | { readonly kind: 'replayed'; readonly records: readonly []; readonly result: JsonValue }

export interface ProjectionEvent {
  readonly schemaVersion: 1
  readonly cursor: DecimalString
  readonly projection: ProjectionName
  readonly id: string
  readonly revision: Revision
  readonly change: 'upsert' | 'remove'
  readonly value?: JsonValue
}

export interface AuthorityIntegrityResult {
  readonly ok: boolean
  readonly findings: readonly string[]
}

export interface AuthorityBackupManifest {
  readonly schemaVersion: typeof AUTHORITY_SCHEMA_VERSION
  readonly createdAt: Instant
  readonly sizeBytes: number
  readonly digest: Sha256
}

export interface ProjectionBaseline {
  readonly schemaVersion: 1
  /** Opaque token pinning every page to the same authoritative feed cursor. */
  readonly snapshotToken: string
  readonly asOfCursor: DecimalString
  readonly values: readonly {
    readonly projection: ProjectionName
    readonly id: string
    readonly revision: Revision
    readonly value: JsonValue
  }[]
  readonly complete: boolean
  readonly nextPageCursor?: DecimalString
}

/** One current projection row, read without advancing or creating feed state. */
export interface AuthorityProjectionRecord {
  readonly projection: ProjectionName
  readonly id: string
  readonly ownerPrincipalId: PrincipalId
  readonly revision: Revision
  readonly value: JsonValue
}

export interface ApprovalReceiptRecord {
  readonly id: string
  readonly ownerPrincipalId: PrincipalId
  readonly effectDigest: Sha256
  readonly state: 'active' | 'consumed' | 'revoked'
  readonly expiresAt: Instant
  readonly createdAt: Instant
  readonly consumedAt?: Instant
}

export interface AuthorityAuditRecord {
  readonly sequence: number
  readonly kind: string
  readonly subjectDomain: string
  readonly subjectId: string
  readonly details: JsonValue
  readonly createdAt: Instant
}

export class IncompatibleProductHomeError extends Error {
  constructor(readonly productHome: string, readonly entries: readonly string[]) {
    super(entries.length === 0
      ? `Product home '${productHome}' is not compatible.`
      : `Product home '${productHome}' is non-empty and has no compatible product marker: ${entries.join(', ')}`)
    this.name = 'IncompatibleProductHomeError'
  }
}

export class AuthorityConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorityConflictError'
  }
}

export class AuthorityApprovalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorityApprovalError'
  }
}

export class AuthorityWriterLockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthorityWriterLockError'
  }
}

function parseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text)
  return jsonValueSchema.parse(parsed)
}

function stringifyJson(value: JsonValue): string {
  const text = JSON.stringify(value)
  if (text === undefined) throw new TypeError('authority values must be JSON serializable')
  return text
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function prepareProductHome(productHome: string): Promise<{ readonly databasePath: string; readonly fresh: boolean }> {
  await mkdir(productHome, { recursive: true, mode: 0o700 })
  const details = await stat(productHome)
  if (!details.isDirectory()) throw new IncompatibleProductHomeError(productHome, [])
  const entries = (await readdir(productHome)).sort()
  const markerPath = join(productHome, PRODUCT_MARKER)
  if (!entries.includes(PRODUCT_MARKER)) {
    if (entries.length > 0) throw new IncompatibleProductHomeError(productHome, entries)
    await writeFile(markerPath, `${JSON.stringify({ schemaVersion: AUTHORITY_SCHEMA_VERSION })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } else {
    let marker: unknown
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'))
    } catch {
      throw new IncompatibleProductHomeError(productHome, entries)
    }
    const parsed = z.object({ schemaVersion: z.literal(AUTHORITY_SCHEMA_VERSION) }).strict().safeParse(marker)
    if (!parsed.success) throw new IncompatibleProductHomeError(productHome, entries)
  }
  const databasePath = join(productHome, AUTHORITY_DATABASE)
  return { databasePath, fresh: !(await exists(databasePath)) }
}

async function acquireWriterLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
      await handle.sync()
      return handle
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      let activePid: number | undefined
      try {
        const lock: unknown = JSON.parse(await readFile(path, 'utf8'))
        const parsed = z.object({ pid: z.number().int().positive() }).passthrough().safeParse(lock)
        if (parsed.success) activePid = parsed.data.pid
      } catch {
        // A malformed lock has no live owner and can be moved aside.
      }
      if (activePid !== undefined) {
        try {
          process.kill(activePid, 0)
          throw new AuthorityWriterLockError(`Authority database writer is already active with pid ${activePid}.`)
        } catch (error) {
          if (error instanceof AuthorityWriterLockError) throw error
          if (errorCode(error) !== 'ESRCH') throw error
        }
      }
      try {
        await rename(path, `${path}.stale.${Date.now()}.${process.pid}`)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
      }
    }
  }
  throw new AuthorityWriterLockError('Could not acquire the authority database writer lock.')
}

function authorityRecord(row: z.output<typeof databaseAuthorityRowSchema>): AuthorityRecord {
  return {
    domain: row.domain,
    id: row.id,
    ownerPrincipalId: row.ownerPrincipalId,
    revision: row.revision,
    value: parseJson(row.payloadJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function assertLocalOwner(principalId: PrincipalId): void {
  if (principalId !== LOCAL_OWNER_PRINCIPAL_ID) throw new AuthorityConflictError('The requested authority scope is unavailable.')
}

function changed(result: unknown): boolean {
  const parsed = databaseChangesSchema.parse(result)
  return typeof parsed.changes === 'bigint' ? parsed.changes === 1n : parsed.changes === 1
}

function pageOffset(cursor: DecimalString | undefined): number {
  if (cursor === undefined) return 0
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('page cursor exceeds the supported local range')
  return value
}

function snapshotToken(principalId: PrincipalId, asOfCursor: DecimalString): string {
  const digest = canonicalSha256({ schemaVersion: AUTHORITY_SCHEMA_VERSION, principalId, asOfCursor })
  return `${AUTHORITY_SCHEMA_VERSION}:${asOfCursor}:${digest}`
}

function snapshotCursor(principalId: PrincipalId, token: string): DecimalString {
  const match = /^(\d+):(\d+):([a-f0-9]{64})$/u.exec(token)
  if (match === null) throw new AuthorityConflictError('Snapshot token is invalid.')
  const [, version, cursorText, digest] = match
  if (version !== String(AUTHORITY_SCHEMA_VERSION) || cursorText === undefined || digest === undefined) {
    throw new AuthorityConflictError('Snapshot token is incompatible.')
  }
  const cursor = decimalStringSchema.parse(cursorText)
  if (snapshotToken(principalId, cursor) !== token) throw new AuthorityConflictError('Snapshot token is invalid.')
  return cursor
}

/**
 * The product's sole relational authority. It opens only a marked fresh-home
 * schema and never migrates, imports, resets, or reinterprets existing data.
 */
export class RelationalAuthority {
  private closed = false

  private constructor(
    readonly productHome: string,
    private readonly databasePath: string,
    private readonly database: DatabaseSync,
    private readonly lockHandle: Awaited<ReturnType<typeof open>>,
  ) {}

  static async open(productHome: string): Promise<RelationalAuthority> {
    const prepared = await prepareProductHome(productHome)
    const lockPath = `${prepared.databasePath}.writer.lock`
    const lockHandle = await acquireWriterLock(lockPath)
    const database = new DatabaseSync(prepared.databasePath)
    try {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
      if (prepared.fresh) RelationalAuthority.initialize(database)
      else RelationalAuthority.verifySchema(database)
      return new RelationalAuthority(productHome, prepared.databasePath, database, lockHandle)
    } catch (error) {
      database.close()
      await lockHandle.close().catch(() => undefined)
      await unlink(lockPath).catch(() => undefined)
      throw error
    }
  }

  private static initialize(database: DatabaseSync): void {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE authority_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE authority_rows (
        domain TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(domain, entity_id)
      ) STRICT;
      CREATE INDEX authority_rows_owner_domain ON authority_rows(owner_principal_id, domain, entity_id);
      CREATE TABLE authority_projections (
        projection TEXT NOT NULL CHECK(projection = 'machine-connection'),
        entity_id TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        PRIMARY KEY(projection, entity_id)
      ) STRICT;
      CREATE INDEX authority_projections_owner ON authority_projections(owner_principal_id, projection, entity_id);
      CREATE TABLE authority_feed (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_principal_id TEXT NOT NULL,
        projection TEXT NOT NULL CHECK(projection = 'machine-connection'),
        entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        change TEXT NOT NULL CHECK(change IN ('upsert', 'remove')),
        value_json TEXT CHECK(value_json IS NULL OR json_valid(value_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX authority_feed_owner_cursor ON authority_feed(owner_principal_id, cursor);
      CREATE TABLE authority_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_principal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject_domain TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        details_json TEXT NOT NULL CHECK(json_valid(details_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX authority_audit_owner_subject ON authority_audit(owner_principal_id, subject_domain, subject_id, sequence);
      CREATE TABLE approval_receipts (
        id TEXT PRIMARY KEY,
        owner_principal_id TEXT NOT NULL,
        effect_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'consumed', 'revoked')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;
      CREATE TABLE authority_idempotency (
        owner_principal_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_principal_id, scope, key_hash)
      ) STRICT;
      INSERT INTO authority_meta(key, value) VALUES ('schema_version', '${AUTHORITY_SCHEMA_VERSION}');
      COMMIT;
    `)
  }

  private static verifySchema(database: DatabaseSync): void {
    let row: unknown
    try {
      row = database.prepare("SELECT value FROM authority_meta WHERE key='schema_version'").get()
    } catch {
      throw new IncompatibleProductHomeError('authority database', [])
    }
    const parsed = databaseMetaSchema.safeParse(row)
    if (!parsed.success || parsed.data.value !== String(AUTHORITY_SCHEMA_VERSION)) {
      throw new IncompatibleProductHomeError('authority database', [])
    }
  }

  get(principalId: PrincipalId, domainInput: string, idInput: string): AuthorityRecord | undefined {
    this.assertOpen()
    assertLocalOwner(principalId)
    const domain = domainNameSchema.parse(domainInput)
    const id = entityIdSchema.parse(idInput)
    const row = this.database.prepare(`SELECT domain, entity_id AS id, owner_principal_id AS ownerPrincipalId,
      revision, payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt
      FROM authority_rows WHERE owner_principal_id=? AND domain=? AND entity_id=?`).get(principalId, domain, id)
    if (row === undefined) return undefined
    return authorityRecord(databaseAuthorityRowSchema.parse(row))
  }

  list(principalId: PrincipalId, domainInput: string, limit = 100): readonly AuthorityRecord[] {
    this.assertOpen()
    assertLocalOwner(principalId)
    const domain = domainNameSchema.parse(domainInput)
    const boundedLimit = z.number().int().min(1).max(500).parse(limit)
    const rows = this.database.prepare(`SELECT domain, entity_id AS id, owner_principal_id AS ownerPrincipalId,
      revision, payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt
      FROM authority_rows WHERE owner_principal_id=? AND domain=? ORDER BY entity_id LIMIT ?`).all(principalId, domain, boundedLimit)
    return z.array(databaseAuthorityRowSchema).parse(rows).map(authorityRecord)
  }

  /** Pages one authority domain in stable entity-id order. */
  listPage(input: {
    readonly principalId: PrincipalId
    readonly domain: string
    readonly afterId?: string
    readonly limit?: number
  }): readonly AuthorityRecord[] {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    const domain = domainNameSchema.parse(input.domain)
    const afterId = input.afterId === undefined ? '' : entityIdSchema.parse(input.afterId)
    const limit = z.number().int().min(1).max(500).parse(input.limit ?? 100)
    const rows = this.database.prepare(`SELECT domain, entity_id AS id, owner_principal_id AS ownerPrincipalId,
      revision, payload_json AS payloadJson, created_at AS createdAt, updated_at AS updatedAt
      FROM authority_rows WHERE owner_principal_id=? AND domain=? AND entity_id>?
      ORDER BY entity_id LIMIT ?`).all(input.principalId, domain, afterId, limit)
    return z.array(databaseAuthorityRowSchema).parse(rows).map(authorityRecord)
  }

  /** Returns one current presentation projection by its stable identity. */
  projection(
    principalId: PrincipalId,
    projectionInput: ProjectionName,
    idInput: string,
  ): AuthorityProjectionRecord | undefined {
    this.assertOpen()
    assertLocalOwner(principalId)
    const projection = projectionNameSchema.parse(projectionInput)
    const id = entityIdSchema.parse(idInput)
    const row = this.database.prepare(`SELECT projection, entity_id AS id, owner_principal_id AS ownerPrincipalId,
      revision, value_json AS valueJson FROM authority_projections
      WHERE owner_principal_id=? AND projection=? AND entity_id=?`).get(principalId, projection, id)
    if (row === undefined) return undefined
    const parsed = databaseProjectionRowSchema.parse(row)
    return {
      projection: parsed.projection,
      id: parsed.id,
      ownerPrincipalId: parsed.ownerPrincipalId,
      revision: parsed.revision,
      value: parseJson(parsed.valueJson),
    }
  }

  /** Returns the original result for an exact idempotent request without running service validation again. */
  idempotencyResult(input: AuthorityIdempotencyLookupInput & { readonly principalId: PrincipalId }): JsonValue | undefined {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    return this.idempotencyReplay(input.principalId, input)
  }

  issueApproval(input: {
    readonly principalId: PrincipalId
    readonly effectDigest: Sha256
    readonly expiresAt: Instant
  }): ApprovalReceiptRecord {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    const effectDigest = sha256Schema.parse(input.effectDigest)
    const expiresAt = instantSchema.parse(input.expiresAt)
    if (Date.parse(expiresAt) <= Date.now()) throw new AuthorityApprovalError('Approval expiry must be in the future.')
    const id = approvalReceiptIdSchema.parse(createUuidV7())
    const createdAt = toInstant()
    this.insertApproval(input.principalId, { receiptId: id, effectDigest, expiresAt }, createdAt)
    return { id, ownerPrincipalId: input.principalId, effectDigest, state: 'active', expiresAt, createdAt }
  }

  approval(principalId: PrincipalId, receiptId: string): ApprovalReceiptRecord | undefined {
    this.assertOpen()
    assertLocalOwner(principalId)
    const id = approvalReceiptIdSchema.parse(receiptId)
    const row = this.database.prepare(`SELECT id, owner_principal_id AS ownerPrincipalId, effect_digest AS effectDigest,
      state, expires_at AS expiresAt, created_at AS createdAt, consumed_at AS consumedAt
      FROM approval_receipts WHERE owner_principal_id=? AND id=?`).get(principalId, id)
    if (row === undefined) return undefined
    const parsed = databaseApprovalRowSchema.parse(row)
    return {
      id: parsed.id,
      ownerPrincipalId: parsed.ownerPrincipalId,
      effectDigest: parsed.effectDigest,
      state: parsed.state,
      expiresAt: parsed.expiresAt,
      createdAt: parsed.createdAt,
      ...(parsed.consumedAt === null ? {} : { consumedAt: parsed.consumedAt }),
    }
  }

  /** Runs SQLite's bounded internal consistency check against the live authority. */
  integrityCheck(): AuthorityIntegrityResult {
    this.assertOpen()
    const rows = z.array(z.record(z.string(), z.unknown())).parse(this.database.prepare('PRAGMA quick_check').all())
    const messages = rows.flatMap(row => Object.values(row)).filter((value): value is string => typeof value === 'string')
    const findings = messages.filter(message => message !== 'ok')
    return { ok: findings.length === 0 && messages.includes('ok'), findings }
  }

  /** Creates a consistent online SQLite backup without transferring database ownership. */
  async backup(destination: string): Promise<AuthorityBackupManifest> {
    this.assertOpen()
    if (!isAbsolute(destination)) throw new TypeError('Authority backup destination must be absolute.')
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await sqliteBackup(this.database, destination)
    await chmod(destination, 0o600)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(destination)) hash.update(chunk)
    const metadata = await stat(destination)
    return {
      schemaVersion: AUTHORITY_SCHEMA_VERSION,
      createdAt: toInstant(),
      sizeBytes: metadata.size,
      digest: sha256Schema.parse(hash.digest('hex')),
    }
  }

  transact(input: AuthorityTransactionInput): AuthorityTransactionResult {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    const mutations = input.mutations ?? []
    const projections = input.projections ?? []
    const audit = input.audit ?? []
    this.database.exec('BEGIN IMMEDIATE')
    try {
      if (input.idempotency !== undefined) {
        const replay = this.idempotencyReplay(input.principalId, input.idempotency)
        if (replay !== undefined) {
          this.database.exec('ROLLBACK')
          return { kind: 'replayed', records: [], result: replay }
        }
      }
      if (input.issueApproval !== undefined) this.insertApproval(input.principalId, input.issueApproval, toInstant())
      if (input.approval !== undefined) this.consumeApproval(input.principalId, input.approval)
      const records = mutations.map(mutation => this.applyMutation(input.principalId, mutation))
      projections.forEach(projection => { this.applyProjection(input.principalId, projection) })
      const now = toInstant()
      mutations.forEach((mutation, index) => {
        const record = records[index]
        const revision = record?.revision ?? (mutation.kind === 'insert' ? 1 : mutation.expectedRevision)
        this.appendAudit(input.principalId, {
          kind: `authority.${mutation.kind}`,
          subjectDomain: mutation.domain,
          subjectId: mutation.id,
          details: { revision },
        }, now)
      })
      audit.forEach(item => { this.appendAudit(input.principalId, item, now) })
      if (input.idempotency !== undefined) this.recordIdempotency(input.principalId, input.idempotency, now)
      this.database.exec('COMMIT')
      return {
        kind: 'committed',
        records: records.flatMap(record => record === undefined ? [] : [record]),
        ...(input.idempotency === undefined ? {} : { result: input.idempotency.result }),
      }
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  baseline(input: {
    readonly principalId: PrincipalId
    readonly pageSize?: number
    readonly pageCursor?: DecimalString
    readonly snapshotToken?: string
  }): ProjectionBaseline {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    const pageSize = z.number().int().min(1).max(500).parse(input.pageSize ?? 100)
    if (input.pageCursor !== undefined && input.snapshotToken === undefined) {
      throw new AuthorityConflictError('Paginated baseline requests require the original snapshot token.')
    }
    const offset = pageOffset(input.pageCursor)
    const asOfCursor = input.snapshotToken === undefined
      ? decimalStringSchema.parse(String(z.object({ cursor: z.number().int().nonnegative() }).strict().parse(
        this.database.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM authority_feed WHERE owner_principal_id=?').get(input.principalId),
      ).cursor))
      : snapshotCursor(input.principalId, input.snapshotToken)
    const token = snapshotToken(input.principalId, asOfCursor)
    const rows = z.array(databaseProjectionRowSchema).parse(this.database.prepare(`WITH latest AS (
        SELECT projection, entity_id, MAX(cursor) AS cursor
        FROM authority_feed
        WHERE owner_principal_id=? AND cursor<=? AND projection='machine-connection'
        GROUP BY projection, entity_id
      )
      SELECT feed.projection, feed.entity_id AS id, feed.owner_principal_id AS ownerPrincipalId,
        feed.revision, feed.value_json AS valueJson
      FROM authority_feed AS feed
      INNER JOIN latest ON latest.cursor=feed.cursor
      WHERE feed.owner_principal_id=? AND feed.change='upsert'
      ORDER BY feed.projection, feed.entity_id LIMIT ? OFFSET ?`)
      .all(input.principalId, pageOffset(asOfCursor), input.principalId, pageSize + 1, offset))
    const page = rows.slice(0, pageSize)
    const complete = rows.length <= pageSize
    return {
      schemaVersion: 1,
      snapshotToken: token,
      asOfCursor,
      values: page.map(row => ({ projection: row.projection, id: row.id, revision: row.revision, value: parseJson(row.valueJson) })),
      complete,
      ...(complete ? {} : { nextPageCursor: decimalStringSchema.parse(String(offset + pageSize)) }),
    }
  }

  feed(input: {
    readonly principalId: PrincipalId
    readonly afterCursor?: DecimalString
    readonly limit?: number
  }): readonly ProjectionEvent[] {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    const afterCursor = pageOffset(input.afterCursor)
    const limit = z.number().int().min(1).max(1_000).parse(input.limit ?? 100)
    const rows = z.array(databaseFeedRowSchema).parse(this.database.prepare(`SELECT cursor, projection, entity_id AS id,
      revision, change, value_json AS valueJson FROM authority_feed
      WHERE owner_principal_id=? AND cursor>? AND projection='machine-connection'
      ORDER BY cursor LIMIT ?`).all(input.principalId, afterCursor, limit))
    return rows.map(row => ({
      schemaVersion: 1,
      cursor: decimalStringSchema.parse(String(row.cursor)),
      projection: row.projection,
      id: row.id,
      revision: row.revision,
      change: row.change,
      ...(row.valueJson === null ? {} : { value: parseJson(row.valueJson) }),
    }))
  }

  audit(input: {
    readonly principalId: PrincipalId
    readonly subjectDomain?: string
    readonly subjectId?: string
    readonly limit?: number
  }): readonly AuthorityAuditRecord[] {
    this.assertOpen()
    assertLocalOwner(input.principalId)
    if ((input.subjectDomain === undefined) !== (input.subjectId === undefined)) {
      throw new TypeError('audit filtering requires both subjectDomain and subjectId')
    }
    const limit = z.number().int().min(1).max(1_000).parse(input.limit ?? 100)
    const rows = input.subjectDomain === undefined
      ? this.database.prepare(`SELECT sequence, kind, subject_domain AS subjectDomain, subject_id AS subjectId,
          details_json AS detailsJson, created_at AS createdAt FROM authority_audit
          WHERE owner_principal_id=? ORDER BY sequence DESC LIMIT ?`).all(input.principalId, limit)
      : this.database.prepare(`SELECT sequence, kind, subject_domain AS subjectDomain, subject_id AS subjectId,
          details_json AS detailsJson, created_at AS createdAt FROM authority_audit
          WHERE owner_principal_id=? AND subject_domain=? AND subject_id=? ORDER BY sequence DESC LIMIT ?`).all(
          input.principalId,
          domainNameSchema.parse(input.subjectDomain),
          entityIdSchema.parse(input.subjectId),
          limit,
        )
    return z.array(databaseAuditRowSchema).parse(rows).map(row => ({
      sequence: row.sequence,
      kind: row.kind,
      subjectDomain: row.subjectDomain,
      subjectId: row.subjectId,
      details: parseJson(row.detailsJson),
      createdAt: row.createdAt,
    }))
  }

  private idempotencyReplay(principalId: PrincipalId, input: AuthorityIdempotencyLookupInput): JsonValue | undefined {
    const scope = domainNameSchema.parse(input.scope)
    const keyHash = canonicalSha256({ scope, key: z.string().min(1).max(512).parse(input.key) })
    const requestHash = canonicalSha256(input.request)
    const row = this.database.prepare(`SELECT request_hash AS requestHash, result_json AS resultJson
      FROM authority_idempotency WHERE owner_principal_id=? AND scope=? AND key_hash=?`).get(principalId, scope, keyHash)
    if (row === undefined) return undefined
    const parsed = databaseIdempotencyRowSchema.parse(row)
    if (parsed.requestHash !== requestHash) throw new AuthorityConflictError('Idempotency key is already bound to another request.')
    return parseJson(parsed.resultJson)
  }

  private recordIdempotency(principalId: PrincipalId, input: AuthorityIdempotencyInput, now: Instant): void {
    const scope = domainNameSchema.parse(input.scope)
    const keyHash = canonicalSha256({ scope, key: z.string().min(1).max(512).parse(input.key) })
    this.database.prepare(`INSERT INTO authority_idempotency(
      owner_principal_id, scope, key_hash, request_hash, result_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?)`).run(
      principalId,
      scope,
      keyHash,
      canonicalSha256(input.request),
      stringifyJson(input.result),
      now,
    )
  }

  private consumeApproval(principalId: PrincipalId, input: AuthorityApprovalInput): void {
    const receiptId = approvalReceiptIdSchema.parse(input.receiptId)
    const effectDigest = sha256Schema.parse(input.effectDigest)
    const row = this.database.prepare(`SELECT id, owner_principal_id AS ownerPrincipalId, effect_digest AS effectDigest,
      state, expires_at AS expiresAt, created_at AS createdAt, consumed_at AS consumedAt
      FROM approval_receipts WHERE owner_principal_id=? AND id=?`).get(principalId, receiptId)
    if (row === undefined) throw new AuthorityApprovalError('Approval receipt does not exist.')
    const approval = databaseApprovalRowSchema.parse(row)
    if (approval.state !== 'active') throw new AuthorityApprovalError(`Approval receipt is ${approval.state}.`)
    if (approval.effectDigest !== effectDigest) throw new AuthorityApprovalError('Approval effect digest does not match.')
    if (Date.parse(approval.expiresAt) <= Date.now()) throw new AuthorityApprovalError('Approval receipt expired.')
    const consumedAt = toInstant()
    const result = this.database.prepare(`UPDATE approval_receipts SET state='consumed', consumed_at=?
      WHERE owner_principal_id=? AND id=? AND state='active'`).run(consumedAt, principalId, receiptId)
    if (!changed(result)) throw new AuthorityApprovalError('Approval receipt could not be consumed.')
  }

  private insertApproval(
    principalId: PrincipalId,
    input: AuthorityApprovalIssueInput,
    createdAt: Instant,
  ): void {
    const receiptId = approvalReceiptIdSchema.parse(input.receiptId)
    const effectDigest = sha256Schema.parse(input.effectDigest)
    const expiresAt = instantSchema.parse(input.expiresAt)
    if (Date.parse(expiresAt) <= Date.now()) throw new AuthorityApprovalError('Approval expiry must be in the future.')
    this.database.prepare(`INSERT INTO approval_receipts(
      id, owner_principal_id, effect_digest, state, expires_at, created_at
    ) VALUES(?, ?, ?, 'active', ?, ?)`).run(receiptId, principalId, effectDigest, expiresAt, createdAt)
  }

  private applyMutation(principalId: PrincipalId, input: AuthorityMutation): AuthorityRecord | undefined {
    const domain = domainNameSchema.parse(input.domain)
    const id = entityIdSchema.parse(input.id)
    const now = toInstant()
    if (input.kind === 'insert') {
      try {
        this.database.prepare(`INSERT INTO authority_rows(
          domain, entity_id, owner_principal_id, revision, payload_json, created_at, updated_at
        ) VALUES(?, ?, ?, 1, ?, ?, ?)`).run(domain, id, principalId, stringifyJson(input.value), now, now)
      } catch (error) {
        if (errorCode(error) === 'SQLITE_CONSTRAINT_PRIMARYKEY' || errorCode(error) === 'SQLITE_CONSTRAINT') {
          throw new AuthorityConflictError(`${domain} '${id}' already exists.`)
        }
        throw error
      }
      return this.requireRecord(principalId, domain, id)
    }
    const current = this.requireRecord(principalId, domain, id)
    if (current.revision !== input.expectedRevision) throw new AuthorityConflictError(`${domain} '${id}' revision conflict.`)
    if (input.kind === 'remove') {
      const result = this.database.prepare(`DELETE FROM authority_rows
        WHERE owner_principal_id=? AND domain=? AND entity_id=? AND revision=?`).run(principalId, domain, id, input.expectedRevision)
      if (!changed(result)) throw new AuthorityConflictError(`${domain} '${id}' revision conflict.`)
      return undefined
    }
    const nextRevision = revisionSchema.parse(current.revision + 1)
    const result = this.database.prepare(`UPDATE authority_rows SET revision=?, payload_json=?, updated_at=?
      WHERE owner_principal_id=? AND domain=? AND entity_id=? AND revision=?`).run(
      nextRevision,
      stringifyJson(input.value),
      now,
      principalId,
      domain,
      id,
      input.expectedRevision,
    )
    if (!changed(result)) throw new AuthorityConflictError(`${domain} '${id}' revision conflict.`)
    return this.requireRecord(principalId, domain, id)
  }

  private requireRecord(principalId: PrincipalId, domain: string, id: string): AuthorityRecord {
    const record = this.get(principalId, domain, id)
    if (record === undefined) throw new AuthorityConflictError(`${domain} '${id}' does not exist.`)
    return record
  }

  private applyProjection(principalId: PrincipalId, input: ProjectionMutation): void {
    const projection = projectionNameSchema.parse(input.projection)
    const id = entityIdSchema.parse(input.id)
    const row = this.database.prepare(`SELECT projection, entity_id AS id, owner_principal_id AS ownerPrincipalId,
      revision, value_json AS valueJson FROM authority_projections
      WHERE owner_principal_id=? AND projection=? AND entity_id=?`).get(principalId, projection, id)
    const current = row === undefined ? undefined : databaseProjectionRowSchema.parse(row)
    if (input.kind === 'remove') {
      if (current === undefined || current.revision !== input.expectedRevision) throw new AuthorityConflictError(`${projection} projection '${id}' revision conflict.`)
      const revision = revisionSchema.parse(current.revision + 1)
      const result = this.database.prepare(`DELETE FROM authority_projections
        WHERE owner_principal_id=? AND projection=? AND entity_id=? AND revision=?`).run(principalId, projection, id, input.expectedRevision)
      if (!changed(result)) throw new AuthorityConflictError(`${projection} projection '${id}' revision conflict.`)
      this.appendFeed(principalId, projection, id, revision, 'remove')
      return
    }
    if (current === undefined) {
      if (input.expectedRevision !== 0) throw new AuthorityConflictError(`${projection} projection '${id}' revision conflict.`)
      const revision = revisionSchema.parse(1)
      this.database.prepare(`INSERT INTO authority_projections(
        projection, entity_id, owner_principal_id, revision, value_json
      ) VALUES(?, ?, ?, ?, ?)`).run(projection, id, principalId, revision, stringifyJson(input.value))
      this.appendFeed(principalId, projection, id, revision, 'upsert', input.value)
      return
    }
    if (current.revision !== input.expectedRevision) throw new AuthorityConflictError(`${projection} projection '${id}' revision conflict.`)
    const revision = revisionSchema.parse(current.revision + 1)
    const result = this.database.prepare(`UPDATE authority_projections SET revision=?, value_json=?
      WHERE owner_principal_id=? AND projection=? AND entity_id=? AND revision=?`).run(
      revision,
      stringifyJson(input.value),
      principalId,
      projection,
      id,
      current.revision,
    )
    if (!changed(result)) throw new AuthorityConflictError(`${projection} projection '${id}' revision conflict.`)
    this.appendFeed(principalId, projection, id, revision, 'upsert', input.value)
  }

  private appendFeed(
    principalId: PrincipalId,
    projection: ProjectionName,
    id: string,
    revision: Revision,
    change: 'upsert' | 'remove',
    value?: JsonValue,
  ): void {
    this.database.prepare(`INSERT INTO authority_feed(
      owner_principal_id, projection, entity_id, revision, change, value_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
      principalId,
      projection,
      id,
      revision,
      change,
      value === undefined ? null : stringifyJson(value),
      toInstant(),
    )
  }

  private appendAudit(principalId: PrincipalId, input: AuthorityAuditInput, now: Instant): void {
    this.database.prepare(`INSERT INTO authority_audit(
      owner_principal_id, kind, subject_domain, subject_id, details_json, created_at
    ) VALUES(?, ?, ?, ?, ?, ?)`).run(
      principalId,
      auditKindSchema.parse(input.kind),
      domainNameSchema.parse(input.subjectDomain),
      entityIdSchema.parse(input.subjectId),
      stringifyJson(input.details),
      now,
    )
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Authority database is closed.')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.database.close()
    await this.lockHandle.close()
    await unlink(`${this.databasePath}.writer.lock`).catch(() => undefined)
  }
}
