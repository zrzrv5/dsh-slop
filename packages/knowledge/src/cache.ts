import { DatabaseSync } from 'node:sqlite'
import { KnowledgeError } from './errors.js'
import { MAX_KNOWLEDGE_SNIPPET_BYTES, truncateUtf8 } from './markdown.js'
import type {
  CachedKnowledgeDocument,
  KnowledgeHeading,
  KnowledgeSearchHit,
  KnowledgeSource,
  ScannedKnowledgeSource,
} from './types.js'

function field(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null) return undefined
  return Reflect.get(row, key)
}

function requiredString(row: unknown, key: string): string {
  const value = field(row, key)
  if (typeof value !== 'string') {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', `Invalid cache field: ${key}`)
  }
  return value
}

function requiredNumber(row: unknown, key: string): number {
  const value = field(row, key)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', `Invalid cache field: ${key}`)
  }
  return value
}

function optionalString(row: unknown, key: string): string | undefined {
  const value = field(row, key)
  return typeof value === 'string' ? value : undefined
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch (error) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge cache contains invalid JSON.', {
      cause: error,
    })
  }
}

function parseTags(value: string): readonly string[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge cache contains invalid tags.')
  }
  return parsed.filter((item): item is string => typeof item === 'string')
}

function parseHeadings(value: string): readonly KnowledgeHeading[] {
  const parsed = parseJson(value)
  if (!Array.isArray(parsed)) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge cache contains invalid headings.')
  }
  const headings: KnowledgeHeading[] = []
  for (const item of parsed) {
    const level = field(item, 'level')
    const title = field(item, 'title')
    const start = field(item, 'start')
    const end = field(item, 'end')
    if (
      typeof level !== 'number' ||
      typeof title !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number'
    ) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge cache contains invalid headings.')
    }
    headings.push({ level, title, start, end })
  }
  return headings
}

function sourceFromRow(row: unknown): KnowledgeSource {
  const scope = requiredString(row, 'scope')
  const key = requiredString(row, 'source_key')
  const root = requiredString(row, 'root')
  if (scope === 'home') return { kind: 'home', key, root }
  if (scope !== 'workspace') {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge cache contains invalid scope.')
  }
  const workspaceId = optionalString(row, 'workspace_id')
  const workspaceTitle = optionalString(row, 'workspace_title')
  const workspacePath = optionalString(row, 'workspace_path')
  if (workspaceId === undefined || workspaceTitle === undefined || workspacePath === undefined) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_ARGUMENT',
      'Knowledge cache is missing workspace identity.',
    )
  }
  return {
    kind: 'workspace',
    key,
    root,
    workspaceId,
    workspaceTitle,
    workspacePath,
  }
}

function documentFromRow(row: unknown): CachedKnowledgeDocument {
  return {
    docRef: requiredString(row, 'doc_ref'),
    source: sourceFromRow(row),
    relativePath: requiredString(row, 'relative_path'),
    digest: requiredString(row, 'digest'),
    name: requiredString(row, 'name'),
    description: requiredString(row, 'description'),
    tags: parseTags(requiredString(row, 'tags_json')),
    headings: parseHeadings(requiredString(row, 'headings_json')),
    sizeBytes: requiredNumber(row, 'size_bytes'),
    mtimeMs: requiredNumber(row, 'mtime_ms'),
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

export interface RankedKnowledgeSearchHit {
  readonly hit: KnowledgeSearchHit
  readonly exactName: boolean
  readonly exactTag: boolean
  readonly rank: number
}

function rankedHitFromRow(row: unknown, normalizedQuery: string): RankedKnowledgeSearchHit {
  const scope = requiredString(row, 'scope')
  if (scope !== 'home' && scope !== 'workspace') {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge cache contains invalid scope.')
  }
  const workspaceId = optionalString(row, 'workspace_id')
  const workspaceTitle = optionalString(row, 'workspace_title')
  const name = requiredString(row, 'name')
  const tags = parseTags(requiredString(row, 'tags_json'))
  return {
    hit: {
      docRef: requiredString(row, 'doc_ref'),
      scope,
      relativePath: requiredString(row, 'relative_path'),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(workspaceTitle === undefined ? {} : { workspaceTitle }),
      name,
      description: requiredString(row, 'description'),
      tags,
      snippet: truncateUtf8(requiredString(row, 'snippet'), MAX_KNOWLEDGE_SNIPPET_BYTES),
    },
    exactName: name.toLocaleLowerCase() === normalizedQuery,
    exactTag: tags.some((tag) => tag.toLocaleLowerCase() === normalizedQuery),
    rank: requiredNumber(row, 'rank'),
  }
}

function compareRankedHits(
  left: RankedKnowledgeSearchHit,
  right: RankedKnowledgeSearchHit,
): number {
  if (left.exactName !== right.exactName) return left.exactName ? -1 : 1
  if (left.exactTag !== right.exactTag) return left.exactTag ? -1 : 1
  if (left.rank !== right.rank) return left.rank - right.rank
  return left.hit.docRef.localeCompare(right.hit.docRef)
}

export function compileFtsQuery(query: string): string {
  const normalized = query.normalize('NFKC').trim()
  const terms = (normalized.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 32)
  const quotedTerms = terms.map((term) => `"${term}"`)
  if (terms.length <= 1) return quotedTerms.join('')
  const phrase = `"${terms.join(' ')}"`
  return [phrase, ...quotedTerms].join(' OR ')
}

export class KnowledgeCache {
  readonly #database: DatabaseSync

  constructor() {
    this.#database = new DatabaseSync(':memory:')
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE documents (
        doc_ref TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('home', 'workspace')),
        workspace_id TEXT,
        workspace_title TEXT,
        workspace_path TEXT,
        root TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        digest TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        headings_json TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        UNIQUE (source_key, relative_path)
      );
      CREATE INDEX documents_source_key_idx ON documents(source_key);
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        doc_ref UNINDEXED,
        name,
        tags,
        description,
        headings,
        body,
        tokenize = 'unicode61'
      );
    `)
  }

  close(): void {
    this.#database.close()
  }

  replaceAll(scannedSources: readonly ScannedKnowledgeSource[]): void {
    this.#transaction(() => {
      this.#database.exec('DELETE FROM documents_fts; DELETE FROM documents;')
      for (const scanned of scannedSources) this.#insertSource(scanned)
    })
  }

  replaceSources(scannedSources: readonly ScannedKnowledgeSource[]): void {
    this.#transaction(() => {
      for (const scanned of scannedSources) {
        this.#deleteSource(scanned.source.key)
        this.#insertSource(scanned)
      }
    })
  }

  count(): number {
    const row = this.#database.prepare('SELECT count(*) AS count FROM documents').get()
    return requiredNumber(row, 'count')
  }

  searchRanked(
    query: string,
    sourceKeys: readonly string[],
    limit: number,
  ): readonly RankedKnowledgeSearchHit[] {
    if (sourceKeys.length === 0) return []
    const ftsQuery = compileFtsQuery(query)
    if (ftsQuery.length === 0) return []
    const ftsStatement = this.#database.prepare(`
      SELECT
        d.doc_ref,
        d.scope,
        d.workspace_id,
        d.workspace_title,
        d.relative_path,
        d.name,
        d.description,
        d.tags_json,
        snippet(documents_fts, 5, '[', ']', ' … ', 18) AS snippet,
        bm25(documents_fts, 0.0, 10.0, 6.0, 4.0, 2.0, 1.0) AS rank
      FROM documents_fts
      JOIN documents AS d ON d.doc_ref = documents_fts.doc_ref
      WHERE documents_fts MATCH ?
        AND d.source_key IN (${placeholders(sourceKeys.length)})
      ORDER BY rank
      LIMIT ?
    `)
    const candidateLimit = 80
    const rows = ftsStatement.all(ftsQuery, ...sourceKeys, candidateLimit)
    const normalizedQuery = query.normalize('NFKC').trim().toLocaleLowerCase()
    const rankedByRef = new Map<string, RankedKnowledgeSearchHit>()
    for (const row of rows) {
      const ranked = rankedHitFromRow(row, normalizedQuery)
      rankedByRef.set(ranked.hit.docRef, ranked)
    }

    const exactRows = this.#database
      .prepare(`
        SELECT
          d.doc_ref,
          d.scope,
          d.workspace_id,
          d.workspace_title,
          d.relative_path,
          d.name,
          d.description,
          d.tags_json,
          '' AS snippet,
          0.0 AS rank
        FROM documents AS d
        WHERE d.source_key IN (${placeholders(sourceKeys.length)})
        ORDER BY d.doc_ref
      `)
      .all(...sourceKeys)
    for (const row of exactRows) {
      const ranked = rankedHitFromRow(row, normalizedQuery)
      if (!ranked.exactName && !ranked.exactTag) continue
      const existing = rankedByRef.get(ranked.hit.docRef)
      rankedByRef.set(ranked.hit.docRef, {
        ...ranked,
        rank: existing?.rank ?? ranked.rank,
        hit: existing?.hit ?? ranked.hit,
      })
    }

    return [...rankedByRef.values()].sort(compareRankedHits).slice(0, limit)
  }

  search(query: string, sourceKeys: readonly string[], limit: number): readonly KnowledgeSearchHit[] {
    return this.searchRanked(query, sourceKeys, limit).map((item) => item.hit)
  }

  get(docRef: string, sourceKeys: readonly string[]): CachedKnowledgeDocument | undefined {
    if (sourceKeys.length === 0) return undefined
    const row = this.#database
      .prepare(
        `SELECT * FROM documents WHERE doc_ref = ? AND source_key IN (${placeholders(sourceKeys.length)})`,
      )
      .get(docRef, ...sourceKeys)
    return row === undefined ? undefined : documentFromRow(row)
  }

  #transaction(operation: () => void): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #deleteSource(sourceKey: string): void {
    this.#database
      .prepare(
        'DELETE FROM documents_fts WHERE doc_ref IN (SELECT doc_ref FROM documents WHERE source_key = ?)',
      )
      .run(sourceKey)
    this.#database.prepare('DELETE FROM documents WHERE source_key = ?').run(sourceKey)
  }

  #insertSource(scanned: ScannedKnowledgeSource): void {
    const insertDocument = this.#database.prepare(`
      INSERT INTO documents (
        doc_ref, source_key, scope, workspace_id, workspace_title, workspace_path, root,
        relative_path, digest, name, description, tags_json, headings_json,
        size_bytes, mtime_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertFts = this.#database.prepare(`
      INSERT INTO documents_fts (doc_ref, name, tags, description, headings, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    for (const document of scanned.documents) {
      const workspace = document.source.kind === 'workspace' ? document.source : undefined
      insertDocument.run(
        document.docRef,
        document.source.key,
        document.source.kind,
        workspace?.workspaceId ?? null,
        workspace?.workspaceTitle ?? null,
        workspace?.workspacePath ?? null,
        document.source.root,
        document.relativePath,
        document.digest,
        document.name,
        document.description,
        JSON.stringify(document.tags),
        JSON.stringify(document.headings),
        document.sizeBytes,
        document.mtimeMs,
      )
      insertFts.run(
        document.docRef,
        document.name,
        document.tags.join(' '),
        document.description,
        document.headings.map((heading) => heading.title).join('\n'),
        document.searchBody,
      )
    }
  }
}
