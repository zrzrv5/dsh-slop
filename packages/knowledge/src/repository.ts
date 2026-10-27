import { randomUUID } from 'node:crypto'
import { link, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { KnowledgeCache, type RankedKnowledgeSearchHit } from './cache.js'
import { KnowledgeError, errorCode } from './errors.js'
import {
  DEFAULT_READ_BYTES,
  DEFAULT_SEARCH_LIMIT,
  MAX_AGENT_WRITE_BYTES,
  MAX_DOCUMENT_BYTES,
  MAX_HEADING_PATH_DEPTH,
  MAX_QUERY_CHARS,
  MAX_READ_BYTES,
  MAX_REBUILD_BYTES,
  MAX_REBUILD_DOCUMENTS,
  MAX_SEARCH_LIMIT,
  MAX_SETTINGS_SCAN_DIRECTORIES,
  MAX_SETTINGS_SCAN_ENTRIES,
  MAX_SECTION_REPLACEMENTS,
  decodeUtf8,
  normalizeRelativeMarkdownPath,
  prepareSafeWriteTarget,
  readSafeRegularFile,
  resolveSafeExistingDocument,
} from './fs-safety.js'
import {
  MAX_KNOWLEDGE_HEADING_BYTES,
  MAX_KNOWLEDGE_SNIPPET_BYTES,
  parseMarkdownDocument,
  selectMarkdownHeading,
  truncateUtf8,
} from './markdown.js'
import {
  documentDigest,
  documentReference,
  scanKnowledgeSource,
} from './source.js'
import {
  KNOWLEDGE_SCHEMA_VERSION,
  UNTRUSTED_KNOWLEDGE_WARNING,
  type IndexedKnowledgeDocument,
  type CachedKnowledgeDocument,
  type KnowledgeHeading,
  type KnowledgeReadInput,
  type KnowledgeReadResult,
  type KnowledgeRebuildResult,
  type KnowledgeSearchHit,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSectionReplacement,
  type KnowledgeSource,
  type KnowledgeSourceStatus,
  type KnowledgeWriteInput,
  type KnowledgeWriteResult,
  type ScannedKnowledgeSource,
} from './types.js'

function requireSafeInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `${label} must be a safe integer from ${minimum} through ${maximum}.`,
    )
  }
  return resolved
}

function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_ARGUMENT',
      'expectedDigest has an invalid opaque digest format.',
    )
  }
}

function validateDocRef(docRef: string): void {
  if (!/^knowledge:[a-f0-9]{40}$/u.test(docRef)) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'docRef is invalid.')
  }
}

function validateContent(content: string): void {
  const size = Buffer.byteLength(content, 'utf8')
  if (size > MAX_AGENT_WRITE_BYTES) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `Agent knowledge writes cannot exceed ${MAX_AGENT_WRITE_BYTES} UTF-8 bytes.`,
    )
  }
}

function validateDocumentSize(content: string): void {
  const size = Buffer.byteLength(content, 'utf8')
  if (size > MAX_DOCUMENT_BYTES) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `Knowledge documents cannot exceed ${MAX_DOCUMENT_BYTES} UTF-8 bytes.`,
    )
  }
}

function validateSectionReplacements(
  replacements: readonly KnowledgeSectionReplacement[],
): void {
  if (replacements.length === 0 || replacements.length > MAX_SECTION_REPLACEMENTS) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `replace-sections requires 1 through ${MAX_SECTION_REPLACEMENTS} section replacements.`,
    )
  }
  let payloadBytes = 0
  for (const replacement of replacements) {
    if (
      replacement.headingPath.length === 0 ||
      replacement.headingPath.length > MAX_HEADING_PATH_DEPTH
    ) {
      throw new KnowledgeError(
        'KNOWLEDGE_INVALID_ARGUMENT',
        `Each section replacement headingPath must contain 1 through ${MAX_HEADING_PATH_DEPTH} headings.`,
      )
    }
    for (const heading of replacement.headingPath) {
      const trimmed = heading.trim()
      if (
        trimmed.length === 0 ||
        Buffer.byteLength(trimmed, 'utf8') > MAX_KNOWLEDGE_HEADING_BYTES
      ) {
        throw new KnowledgeError(
          'KNOWLEDGE_INVALID_ARGUMENT',
          `Each headingPath entry must contain 1 through ${MAX_KNOWLEDGE_HEADING_BYTES} UTF-8 bytes after trimming.`,
        )
      }
    }
    payloadBytes += Buffer.byteLength(replacement.body, 'utf8')
  }
  if (payloadBytes > MAX_AGENT_WRITE_BYTES) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `Section replacement bodies cannot exceed ${MAX_AGENT_WRITE_BYTES} total UTF-8 bytes.`,
    )
  }
}

interface ResolvedSectionReplacement {
  readonly start: number
  readonly end: number
  readonly body: string
  readonly displayPath: string
}

function normalizedHeading(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function headingPaths(
  headings: readonly KnowledgeHeading[],
): readonly (readonly string[])[] {
  const stack: { readonly level: number; readonly title: string }[] = []
  return headings.map((heading) => {
    let parent = stack.at(-1)
    while (parent !== undefined && parent.level >= heading.level) {
      stack.pop()
      parent = stack.at(-1)
    }
    stack.push({ level: heading.level, title: heading.title })
    return stack.map((entry) => normalizedHeading(entry.title))
  })
}

const MAX_READ_HEADING_PATHS = 128
const MAX_READ_HEADING_PATH_BYTES = 16 * 1_024

function availableHeadingPaths(
  headings: readonly KnowledgeHeading[],
): {
  readonly paths: readonly (readonly string[])[]
  readonly truncated: boolean
} {
  const stack: { readonly level: number; readonly title: string }[] = []
  const paths: string[][] = []
  let bytes = 0

  for (const heading of headings) {
    let parent = stack.at(-1)
    while (parent !== undefined && parent.level >= heading.level) {
      stack.pop()
      parent = stack.at(-1)
    }
    stack.push({ level: heading.level, title: heading.title })
    const path = stack.map((entry) => entry.title)
    const pathBytes = Buffer.byteLength(JSON.stringify(path), 'utf8')
    if (
      paths.length >= MAX_READ_HEADING_PATHS ||
      bytes + pathBytes > MAX_READ_HEADING_PATH_BYTES
    ) {
      return { paths, truncated: true }
    }
    paths.push(path)
    bytes += pathBytes
  }

  return { paths, truncated: false }
}

function headingBodyStart(content: string, headingStart: number, headingEnd: number): number {
  const remainder = content.slice(headingStart, headingEnd)
  const lineEnding = /\r\n|\n|\r/u.exec(remainder)
  return lineEnding === null
    ? headingStart + remainder.length
    : headingStart + lineEnding.index + lineEnding[0].length
}

function preferredLineEnding(content: string): string {
  return /\r\n/u.test(content) ? '\r\n' : /\r/u.test(content) ? '\r' : '\n'
}

function replaceSectionBodies(
  content: string,
  relativePath: string,
  replacements: readonly KnowledgeSectionReplacement[],
): string {
  validateSectionReplacements(replacements)
  const parsed = parseMarkdownDocument(content, relativePath)
  if (parsed.errors.length > 0) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_MARKDOWN',
      'replace-sections requires a document with parseable Markdown frontmatter.',
    )
  }
  const headings = parsed.headings
  const paths = headingPaths(headings)
  const resolved: ResolvedSectionReplacement[] = replacements.map((replacement) => {
    const requested = replacement.headingPath.map(normalizedHeading)
    const matches = headings.flatMap((heading, index) => {
      const path = paths[index]
      if (
        path === undefined ||
        path.length !== requested.length ||
        path.some((title, pathIndex) => title !== requested[pathIndex])
      ) {
        return []
      }
      return [heading]
    })
    const displayPath = replacement.headingPath.map((heading) => heading.trim()).join(' > ')
    if (matches.length === 0) {
      throw new KnowledgeError(
        'KNOWLEDGE_NOT_FOUND',
        `No section matches the complete headingPath: ${displayPath}`,
      )
    }
    if (matches.length > 1) {
      throw new KnowledgeError(
        'KNOWLEDGE_INVALID_ARGUMENT',
        `The complete headingPath is ambiguous: ${displayPath}`,
      )
    }
    const heading = matches[0]
    if (heading === undefined) {
      throw new KnowledgeError('KNOWLEDGE_NOT_FOUND', 'Section heading was not found.')
    }
    return {
      start: headingBodyStart(content, heading.start, heading.end),
      end: heading.end,
      body: replacement.body,
      displayPath,
    }
  })

  const ordered = [...resolved].sort((left, right) => left.start - right.start)
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]
    const next = ordered[index + 1]
    if (current === undefined) continue
    if (
      next !== undefined &&
      (next.start === current.start || next.start < current.end)
    ) {
      throw new KnowledgeError(
        'KNOWLEDGE_INVALID_ARGUMENT',
        `Section replacement targets overlap: ${current.displayPath} and ${next.displayPath}`,
      )
    }
  }

  const lineEnding = preferredLineEnding(content)
  let updated = content
  for (const replacement of ordered.reverse()) {
    const headingHasLineEnding =
      replacement.start > 0 && /[\r\n]/u.test(content[replacement.start - 1] ?? '')
    const prefix = replacement.body.length > 0 && !headingHasLineEnding ? lineEnding : ''
    const suffix =
      replacement.body.length > 0 &&
      replacement.end < content.length &&
      !/(?:\r\n|\n|\r)$/u.test(replacement.body)
        ? lineEnding
        : ''
    updated = `${updated.slice(0, replacement.start)}${prefix}${replacement.body}${suffix}${updated.slice(replacement.end)}`
  }
  validateDocumentSize(updated)
  return updated
}

function validateAgentCreatedMarkdown(content: string, relativePath: string): void {
  const parsed = parseMarkdownDocument(content, relativePath)
  if (!parsed.agentMetadataComplete) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_MARKDOWN',
      'New agent-created Markdown must start with YAML frontmatter containing only a lowercase hyphenated name slug, a non-empty description, and optional non-empty string tags.',
    )
  }
}

function unknownFrontmatter(
  content: string,
  relativePath: string,
): readonly (readonly [string, unknown])[] {
  const parsed = parseMarkdownDocument(content, relativePath)
  const unknown: [string, unknown][] = []
  for (const key of parsed.frontmatterKeys) {
    if (key === 'name' || key === 'description' || key === 'tags') continue
    unknown.push([key, parsed.frontmatterValues?.[key]])
  }
  return unknown.sort(([left], [right]) => left.localeCompare(right))
}

function validatePreservedUnknownFrontmatter(
  beforeContent: string,
  nextContent: string,
  relativePath: string,
): void {
  const before = unknownFrontmatter(beforeContent, relativePath)
  const next = unknownFrontmatter(nextContent, relativePath)
  if (!isDeepStrictEqual(before, next)) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_MARKDOWN',
      'Update must preserve existing unknown frontmatter keys and cannot add new unknown keys.',
      {
        details: {
          existingUnknownKeys: truncateUtf8(before.map(([key]) => key).join(','), 512),
          submittedUnknownKeys: truncateUtf8(next.map(([key]) => key).join(','), 512),
        },
      },
    )
  }
}

function sourceKeys(sources: readonly KnowledgeSource[]): readonly string[] {
  return sources.map((source) => source.key)
}

function sourceStatuses(scanned: readonly ScannedKnowledgeSource[]): readonly KnowledgeSourceStatus[] {
  return scanned.map((item) => item.status)
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const MAX_CJK_GRAMS = 64
const CJK_FALLBACK_RANK_BASE = -1_000_000

interface CjkFallbackQuery {
  readonly matcher: RegExp
}

interface CjkFallbackMatch {
  readonly distinctMatches: number
  readonly firstIndex: number
  readonly longestMatch: number
  readonly text: string
}

function codePointLength(value: string): number {
  return [...value].length
}

function sampled<T>(values: readonly T[], limit: number): readonly T[] {
  if (values.length <= limit) return values
  if (limit === 1) return [values[0] as T]
  return Array.from(
    { length: limit },
    (_, index) => values[Math.floor((index * (values.length - 1)) / (limit - 1))] as T,
  )
}

function cjkSearchGrams(query: string): readonly string[] {
  const grams = new Set<string>()
  for (const run of query.match(CJK_RUN) ?? []) {
    const points = [...run]
    if (points.length < 3) {
      grams.add(run)
      continue
    }
    for (let index = 0; index <= points.length - 3; index += 1) {
      grams.add(points.slice(index, index + 3).join(''))
    }
  }
  return [...grams]
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function cjkFallbackQuery(query: string): CjkFallbackQuery | undefined {
  const normalized = query.normalize('NFKC')
  const grams = sampled(cjkSearchGrams(normalized), MAX_CJK_GRAMS)
  if (grams.length === 0) return undefined
  return {
    matcher: new RegExp(grams.map((gram) => escapeRegularExpression(gram)).join('|'), 'gu'),
  }
}

function cjkFallbackMatch(text: string, query: CjkFallbackQuery): CjkFallbackMatch | undefined {
  const normalized = text.normalize('NFKC')
  const distinct = new Set<string>()
  let firstIndex: number | undefined
  let longestMatch = 0
  let observedMatches = 0
  for (const match of normalized.matchAll(query.matcher)) {
    const value = match[0]
    if (value === undefined || match.index === undefined) continue
    firstIndex ??= match.index
    distinct.add(value)
    longestMatch = Math.max(longestMatch, codePointLength(value))
    observedMatches += 1
    if (observedMatches >= MAX_CJK_GRAMS) break
  }
  if (firstIndex === undefined) return undefined
  return {
    distinctMatches: distinct.size,
    firstIndex,
    longestMatch,
    text: normalized,
  }
}

function cjkFallbackSnippet(match: CjkFallbackMatch): string {
  const start = Math.max(0, match.firstIndex - 96)
  const end = Math.min(match.text.length, match.firstIndex + 256)
  const excerpt = match.text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return truncateUtf8(
    `${start > 0 ? '… ' : ''}${excerpt}${end < match.text.length ? ' …' : ''}`,
    MAX_KNOWLEDGE_SNIPPET_BYTES,
  )
}

function sourceSearchHit(
  document: IndexedKnowledgeDocument,
  snippet: string,
): KnowledgeSearchHit {
  const workspace = document.source.kind === 'workspace' ? document.source : undefined
  return {
    docRef: document.docRef,
    scope: document.source.kind,
    relativePath: document.relativePath,
    ...(workspace === undefined
      ? {}
      : {
          workspaceId: workspace.workspaceId,
          workspaceTitle: workspace.workspaceTitle,
        }),
    name: document.name,
    description: document.description,
    tags: document.tags,
    snippet,
  }
}

function cjkFallbackCandidates(
  documents: readonly IndexedKnowledgeDocument[],
  query: string,
  limit: number,
  signal?: AbortSignal,
): readonly RankedKnowledgeSearchHit[] {
  const fallbackQuery = cjkFallbackQuery(query)
  if (fallbackQuery === undefined) return []
  const normalizedQuery = query.normalize('NFKC').trim().toLocaleLowerCase()
  const candidates: RankedKnowledgeSearchHit[] = []
  for (const document of documents) {
    signal?.throwIfAborted()
    const fields: readonly (readonly [string, number])[] = [
      [document.name, 10],
      [document.tags.join('\n'), 6],
      [document.description, 4],
      [document.headings.map((heading) => heading.title).join('\n'), 2],
      [document.searchBody, 1],
    ]
    let best: { readonly match: CjkFallbackMatch; readonly weight: number } | undefined
    for (const [text, weight] of fields) {
      const match = cjkFallbackMatch(text, fallbackQuery)
      if (match === undefined) continue
      best = { match, weight }
      break
    }
    if (best === undefined) continue
    const name = document.name.normalize('NFKC').trim().toLocaleLowerCase()
    const tags = document.tags.map((tag) => tag.normalize('NFKC').trim().toLocaleLowerCase())
    const score = best.weight * 1_000 + best.match.longestMatch * 100 + best.match.distinctMatches
    candidates.push({
      hit: sourceSearchHit(document, cjkFallbackSnippet(best.match)),
      exactName: name === normalizedQuery,
      exactTag: tags.includes(normalizedQuery),
      // FTS5 unicode61 indexes a continuous CJK sentence as one token. Put
      // bounded n-gram evidence ahead of non-exact BM25 candidates; the exact
      // name/tag flags above remain the strongest ordering keys.
      rank: CJK_FALLBACK_RANK_BASE - score,
    })
  }
  return candidates.sort(compareKnowledgeCandidates).slice(0, limit)
}

function compareKnowledgeCandidates(
  left: RankedKnowledgeSearchHit,
  right: RankedKnowledgeSearchHit,
): number {
  if (left.exactName !== right.exactName) return left.exactName ? -1 : 1
  if (left.exactTag !== right.exactTag) return left.exactTag ? -1 : 1
  if (left.rank !== right.rank) return left.rank - right.rank
  if (left.hit.scope !== right.hit.scope) return left.hit.scope === 'workspace' ? -1 : 1
  return left.hit.docRef.localeCompare(right.hit.docRef)
}

function mergeSourceCandidates(
  primary: readonly RankedKnowledgeSearchHit[],
  fallback: readonly RankedKnowledgeSearchHit[],
  limit: number,
): readonly RankedKnowledgeSearchHit[] {
  const byReference = new Map<string, RankedKnowledgeSearchHit>()
  for (const candidate of [...primary, ...fallback]) {
    const current = byReference.get(candidate.hit.docRef)
    if (current === undefined || compareKnowledgeCandidates(candidate, current) < 0) {
      byReference.set(candidate.hit.docRef, candidate)
    }
  }
  return [...byReference.values()].sort(compareKnowledgeCandidates).slice(0, limit)
}

function budgetExhaustedStatus(source: KnowledgeSource): KnowledgeSourceStatus {
  const common: {
    readonly root: string
    readonly state: 'error'
    readonly documentCount: number
    readonly indexedAt: string
    readonly error: string
  } = {
    root: source.root,
    state: 'error',
    documentCount: 0,
    indexedAt: new Date().toISOString(),
    error: 'Global knowledge scan budget was exhausted before this source was scanned.',
  }
  return source.kind === 'home'
    ? { kind: 'home', ...common }
    : {
        kind: 'workspace',
        workspaceId: source.workspaceId,
        workspaceTitle: source.workspaceTitle,
        workspacePath: source.workspacePath,
        ...common,
      }
}

async function scanSourcesForRebuild(
  sources: readonly KnowledgeSource[],
  signal?: AbortSignal,
): Promise<readonly ScannedKnowledgeSource[]> {
  const scanned: ScannedKnowledgeSource[] = []
  let documentCount = 0
  let scannedBytes = 0
  let scannedEntries = 0
  let scannedDirectories = 0
  for (const source of sources) {
    signal?.throwIfAborted()
    const remainingDocuments = MAX_REBUILD_DOCUMENTS - documentCount
    const remainingBytes = MAX_REBUILD_BYTES - scannedBytes
    const remainingEntries = MAX_SETTINGS_SCAN_ENTRIES - scannedEntries
    const remainingDirectories = MAX_SETTINGS_SCAN_DIRECTORIES - scannedDirectories
    if (
      remainingDocuments <= 0 ||
      remainingBytes <= 0 ||
      remainingEntries <= 0 ||
      remainingDirectories <= 0
    ) {
      scanned.push({
        source,
        documents: [],
        scannedBytes: 0,
        scannedEntries: 0,
        scannedDirectories: 0,
        status: budgetExhaustedStatus(source),
      })
      continue
    }
    const item = await scanKnowledgeSource(source, signal, {
      maximumDocuments: remainingDocuments,
      maximumBytes: remainingBytes,
      maximumEntries: remainingEntries,
      maximumDirectories: remainingDirectories,
    })
    scanned.push(item)
    documentCount += item.documents.length
    scannedBytes += item.scannedBytes
    scannedEntries += item.scannedEntries
    scannedDirectories += item.scannedDirectories
  }
  return scanned
}

async function scanSourceStatusesBounded(
  sources: readonly KnowledgeSource[],
  signal?: AbortSignal,
): Promise<readonly KnowledgeSourceStatus[]> {
  const statuses: KnowledgeSourceStatus[] = []
  let documentCount = 0
  let scannedBytes = 0
  let scannedEntries = 0
  let scannedDirectories = 0
  for (const source of sources) {
    signal?.throwIfAborted()
    const remainingDocuments = MAX_REBUILD_DOCUMENTS - documentCount
    const remainingBytes = MAX_REBUILD_BYTES - scannedBytes
    const remainingEntries = MAX_SETTINGS_SCAN_ENTRIES - scannedEntries
    const remainingDirectories = MAX_SETTINGS_SCAN_DIRECTORIES - scannedDirectories
    if (
      remainingDocuments <= 0 ||
      remainingBytes <= 0 ||
      remainingEntries <= 0 ||
      remainingDirectories <= 0
    ) {
      statuses.push(budgetExhaustedStatus(source))
      continue
    }
    const item = await scanKnowledgeSource(source, signal, {
      maximumDocuments: remainingDocuments,
      maximumBytes: remainingBytes,
      maximumEntries: remainingEntries,
      maximumDirectories: remainingDirectories,
    })
    statuses.push(item.status)
    documentCount += item.documents.length
    scannedBytes += item.scannedBytes
    scannedEntries += item.scannedEntries
    scannedDirectories += item.scannedDirectories
  }
  return statuses
}

async function scanSources(
  sources: readonly KnowledgeSource[],
  signal?: AbortSignal,
): Promise<readonly ScannedKnowledgeSource[]> {
  const scanned: ScannedKnowledgeSource[] = []
  for (const source of sources) {
    signal?.throwIfAborted()
    scanned.push(await scanKnowledgeSource(source, signal))
  }
  return scanned
}

interface Utf8Page {
  readonly content: string
  readonly byteOffset: number
  readonly byteLimit: number
  readonly totalBytes: number
  readonly nextByteOffset?: number
}

function requireUtf8Boundary(buffer: Buffer, offset: number): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
  } catch (error) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_ARGUMENT',
      'offset must point to a UTF-8 code-point boundary.',
      { cause: error },
    )
  }
}

function utf8Page(content: string, offsetInput?: number, limitInput?: number): Utf8Page {
  const byteLimit = requireSafeInteger(
    limitInput,
    DEFAULT_READ_BYTES,
    4,
    MAX_READ_BYTES,
    'limit',
  )
  const buffer = Buffer.from(content, 'utf8')
  const byteOffset = requireSafeInteger(offsetInput, 0, 0, buffer.length, 'byteOffset')
  requireUtf8Boundary(buffer, byteOffset)

  let end = Math.min(byteOffset + byteLimit, buffer.length)
  while (end > byteOffset) {
    try {
      const pageContent = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(byteOffset, end),
      )
      return {
        content: pageContent,
        byteOffset,
        byteLimit,
        totalBytes: buffer.length,
        ...(end < buffer.length ? { nextByteOffset: end } : {}),
      }
    } catch {
      end -= 1
    }
  }

  return {
    content: '',
    byteOffset,
    byteLimit,
    totalBytes: buffer.length,
    ...(byteOffset < buffer.length ? { nextByteOffset: byteOffset } : {}),
  }
}

async function writeTemporaryFile(target: string, content: string, mode = 0o600): Promise<string> {
  const temporary = join(dirname(target), `.slop-knowledge-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return temporary
  } catch (error) {
    await bestEffortUnlink(temporary)
    throw error
  }
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {}
}

async function createDocument(target: string, content: string): Promise<void> {
  const temporary = await writeTemporaryFile(target, content)
  try {
    try {
      await link(temporary, target)
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new KnowledgeError(
          'KNOWLEDGE_CONFLICT',
          'Create refused because the knowledge document already exists.',
          { cause: error },
        )
      }
      throw error
    }
  } finally {
    await bestEffortUnlink(temporary)
  }
}

async function updateDocument(
  root: string,
  relativePath: string,
  replacement:
    | { readonly operation: 'replace-document'; readonly content: string }
    | {
        readonly operation: 'replace-sections'
        readonly sectionReplacements: readonly KnowledgeSectionReplacement[]
      },
  expectedDigest: string,
): Promise<{ readonly previousDigest: string; readonly content: string }> {
  validateDigest(expectedDigest)
  let existingPath: string
  try {
    existingPath = await resolveSafeExistingDocument(root, relativePath)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new KnowledgeError(
        'KNOWLEDGE_CONFLICT',
        'Update refused because the knowledge document does not exist.',
        { cause: error },
      )
    }
    throw error
  }
  const target = existingPath
  const before = await readSafeRegularFile(existingPath, MAX_DOCUMENT_BYTES)
  const beforeContent = decodeUtf8(before.bytes)
  const currentDigest = documentDigest(before.bytes)
  if (currentDigest !== expectedDigest) {
    throw new KnowledgeError(
      'KNOWLEDGE_CONFLICT',
      `Update refused because expectedDigest does not match. currentDigest=${currentDigest}`,
      { details: { currentDigest } },
    )
  }
  const content =
    replacement.operation === 'replace-document'
      ? replacement.content
      : replaceSectionBodies(beforeContent, relativePath, replacement.sectionReplacements)
  validatePreservedUnknownFrontmatter(beforeContent, content, relativePath)

  const temporary = await writeTemporaryFile(target, content, before.mode & 0o777)
  try {
    const checkedPath = await resolveSafeExistingDocument(root, relativePath)
    const checked = await readSafeRegularFile(checkedPath, MAX_DOCUMENT_BYTES)
    if (
      checked.dev !== before.dev ||
      checked.ino !== before.ino ||
      documentDigest(checked.bytes) !== expectedDigest
    ) {
      const checkedDigest = documentDigest(checked.bytes)
      throw new KnowledgeError(
        'KNOWLEDGE_CONFLICT',
        `Update refused because the knowledge document changed during the write. currentDigest=${checkedDigest}`,
        { details: { currentDigest: checkedDigest } },
      )
    }
    await rename(temporary, target)
  } finally {
    await bestEffortUnlink(temporary)
  }
  return { previousDigest: currentDigest, content }
}

export class KnowledgeRepository {
  readonly #cache = new KnowledgeCache()
  #operationTail: Promise<void> = Promise.resolve()
  #closed = false
  #closePromise: Promise<void> | undefined

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closed = true
    this.#closePromise = this.#operationTail.then(() => {
      this.#cache.close()
    })
    return this.#closePromise
  }

  rebuild(
    sources: readonly KnowledgeSource[],
    signal?: AbortSignal,
  ): Promise<KnowledgeRebuildResult> {
    return this.#serialize(async () => {
      const scanned = await scanSourcesForRebuild(sources, signal)
      this.#cache.replaceAll(scanned)
      return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        indexedDocuments: this.#cache.count(),
        sources: sourceStatuses(scanned),
      }
    })
  }

  listSources(
    sources: readonly KnowledgeSource[],
    signal?: AbortSignal,
  ): Promise<readonly KnowledgeSourceStatus[]> {
    return this.#serialize(async () => {
      return scanSourceStatusesBounded(sources, signal)
    })
  }

  search(
    input: KnowledgeSearchInput,
    sources: readonly KnowledgeSource[],
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult> {
    return this.#serialize(async () => {
      signal?.throwIfAborted()
      const query = input.query.trim()
      if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
        throw new KnowledgeError(
          'KNOWLEDGE_BOUNDS',
          `Search query must contain 1 to ${MAX_QUERY_CHARS} characters.`,
        )
      }
      const limit = requireSafeInteger(
        input.limit,
        DEFAULT_SEARCH_LIMIT,
        1,
        MAX_SEARCH_LIMIT,
        'limit',
      )
      const scanned = await scanSources(sources, signal)
      this.#cache.replaceAll(scanned)
      const scannedBySource = new Map(scanned.map((item) => [item.source.key, item]))
      const ranked = sources.flatMap((source) => {
        const indexed = scannedBySource.get(source.key)?.documents ?? []
        return mergeSourceCandidates(
          this.#cache.searchRanked(query, [source.key], limit),
          cjkFallbackCandidates(indexed, query, limit, signal),
          limit,
        )
      })
      ranked.sort(compareKnowledgeCandidates)
      const hits: KnowledgeSearchHit[] = ranked.slice(0, limit).map((item) => item.hit)
      return {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        untrustedData: true,
        warning: UNTRUSTED_KNOWLEDGE_WARNING,
        query,
        hits,
        sources: sourceStatuses(scanned),
      }
    })
  }

  read(
    input: KnowledgeReadInput,
    sources: readonly KnowledgeSource[],
    signal?: AbortSignal,
  ): Promise<KnowledgeReadResult> {
    return this.#serialize(async () => {
      signal?.throwIfAborted()
      validateDocRef(input.docRef)
      const scanned = await scanSources(sources, signal)
      this.#cache.replaceAll(scanned)
      const document = this.#cache.get(input.docRef, sourceKeys(sources))
      if (document === undefined) {
        throw new KnowledgeError(
          'KNOWLEDGE_NOT_FOUND',
          'No accessible knowledge document matches this docRef.',
        )
      }

      const path = await resolveSafeExistingDocument(document.source.root, document.relativePath)
      const safeRead = await readSafeRegularFile(path, MAX_DOCUMENT_BYTES)
      const content = decodeUtf8(safeRead.bytes)
      const digest = documentDigest(safeRead.bytes)
      if (digest !== document.digest) {
        throw new KnowledgeError(
          'KNOWLEDGE_CONFLICT',
          'Knowledge document changed while it was being read. Retry the read.',
        )
      }

      const selected =
        input.heading === undefined
          ? undefined
          : selectMarkdownHeading(content, document.headings, input.heading)
      if (input.heading !== undefined && selected === undefined) {
        throw new KnowledgeError(
          'KNOWLEDGE_NOT_FOUND',
          `Heading not found. Available headings: ${document.headings
            .slice(0, 50)
            .map((heading) => heading.title)
            .join(', ')}`,
        )
      }
      const page = utf8Page(selected?.content ?? content, input.byteOffset, input.byteLimit)
      return this.#readResult(document, digest, page, selected?.title)
    })
  }

  write(
    input: KnowledgeWriteInput,
    source: KnowledgeSource,
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    return this.#serialize(async () => {
      signal?.throwIfAborted()
      const relativePath = normalizeRelativeMarkdownPath(input.path)
      if (input.mode === 'create' || input.operation !== 'replace-sections') {
        validateContent(input.content)
      } else {
        validateSectionReplacements(input.sectionReplacements)
      }
      if (input.mode === 'create') validateAgentCreatedMarkdown(input.content, relativePath)

      let previousDigest: string | undefined
      let content: string
      if (input.mode === 'create') {
        content = input.content
        const target = await prepareSafeWriteTarget(source.root, relativePath)
        await createDocument(target, content)
      } else {
        const updated = await updateDocument(
          source.root,
          relativePath,
          input.operation === 'replace-sections'
            ? {
                operation: 'replace-sections',
                sectionReplacements: input.sectionReplacements,
              }
            : { operation: 'replace-document', content: input.content },
          input.expectedDigest,
        )
        previousDigest = updated.previousDigest
        content = updated.content
      }

      const docRef = documentReference(source, relativePath)
      const parsed = parseMarkdownDocument(content, relativePath)
      const document: IndexedKnowledgeDocument = {
        docRef,
        source,
        relativePath,
        digest: documentDigest(Buffer.from(content, 'utf8')),
        name: parsed.name,
        description: parsed.description,
        tags: parsed.tags,
        searchBody: parsed.searchBody,
        headings: parsed.headings,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        mtimeMs: Date.now(),
      }
      return input.mode === 'create'
        ? this.#createResult(document)
        : this.#updateResult(document, previousDigest ?? input.expectedDigest)
    })
  }

  #readResult(
    document: CachedKnowledgeDocument,
    digest: string,
    page: Utf8Page,
    selectedHeading?: string,
  ): KnowledgeReadResult {
    const workspace = document.source.kind === 'workspace' ? document.source : undefined
    const headingPathView = availableHeadingPaths(document.headings)
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      untrustedData: true,
      warning: UNTRUSTED_KNOWLEDGE_WARNING,
      docRef: document.docRef,
      scope: document.source.kind,
      relativePath: document.relativePath,
      ...(workspace === undefined
        ? {}
        : {
            workspaceId: workspace.workspaceId,
            workspaceTitle: workspace.workspaceTitle,
          }),
      name: document.name,
      description: document.description,
      tags: document.tags,
      digest,
      ...(selectedHeading === undefined ? {} : { selectedHeading }),
      availableHeadingPaths: headingPathView.paths,
      headingPathsTruncated: headingPathView.truncated,
      page: {
        byteOffset: page.byteOffset,
        byteLimit: page.byteLimit,
        totalBytes: page.totalBytes,
        ...(page.nextByteOffset === undefined ? {} : { nextByteOffset: page.nextByteOffset }),
      },
      content: page.content,
    }
  }

  #receipt(document: CachedKnowledgeDocument): Omit<KnowledgeWriteResult, 'mode' | 'created' | 'previousDigest'> {
    const workspace = document.source.kind === 'workspace' ? document.source : undefined
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      untrustedData: true,
      warning: UNTRUSTED_KNOWLEDGE_WARNING,
      docRef: document.docRef,
      scope: document.source.kind,
      relativePath: document.relativePath,
      ...(workspace === undefined
        ? {}
        : {
            workspaceId: workspace.workspaceId,
            workspaceTitle: workspace.workspaceTitle,
          }),
      name: document.name,
      description: document.description,
      tags: document.tags,
      digest: document.digest,
    }
  }

  #createResult(document: CachedKnowledgeDocument): KnowledgeWriteResult {
    return {
      ...this.#receipt(document),
      mode: 'create',
      created: true,
    }
  }

  #updateResult(document: CachedKnowledgeDocument, previousDigest: string): KnowledgeWriteResult {
    return {
      ...this.#receipt(document),
      mode: 'update',
      created: false,
      previousDigest,
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge repository is closed.'),
      )
    }
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
