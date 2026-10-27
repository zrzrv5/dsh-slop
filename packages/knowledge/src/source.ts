import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { join, normalize, posix } from 'node:path'
import { describeError } from './errors.js'
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_SOURCE,
  MAX_SCAN_DEPTH,
  MAX_SCAN_DIRECTORIES,
  MAX_SCAN_ENTRIES,
  MAX_RELATIVE_PATH_CHARS,
  MAX_SOURCE_BYTES,
  decodeUtf8,
  inspectExistingKnowledgeRoot,
  normalizeAbsoluteRoot,
  normalizeRelativeMarkdownPath,
  readSafeRegularFile,
} from './fs-safety.js'
import { parseMarkdownDocument, truncateUtf8 } from './markdown.js'
import type {
  IndexedKnowledgeDocument,
  KnowledgeSource,
  KnowledgeSourceStatus,
  ScannedKnowledgeSource,
} from './types.js'

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function sourceIdentity(root: string): string {
  return sha256(normalizeAbsoluteRoot(root)).slice(0, 24)
}

export function createHomeSource(root: string): KnowledgeSource {
  const normalizedRoot = normalizeAbsoluteRoot(root)
  return {
    kind: 'home',
    key: `home:${sourceIdentity(normalizedRoot)}`,
    root: normalizedRoot,
  }
}

export function createWorkspaceSource(input: {
  readonly workspaceId: string
  readonly workspaceTitle: string
  readonly workspacePath: string
}): KnowledgeSource {
  const workspacePath = normalizeAbsoluteRoot(input.workspacePath)
  return {
    kind: 'workspace',
    key: `workspace:${input.workspaceId}`,
    workspaceId: input.workspaceId,
    workspaceTitle: input.workspaceTitle,
    workspacePath,
    root: join(workspacePath, '.dsh', 'knowledge'),
  }
}

export function documentReference(source: KnowledgeSource, relativePath: string): string {
  return `knowledge:${sha256(`${source.key}\0${relativePath}`).slice(0, 40)}`
}

export function documentDigest(content: string | Uint8Array): string {
  return typeof content === 'string'
    ? sha256(Buffer.from(content, 'utf8'))
    : sha256(content)
}

function makeStatus(
  source: KnowledgeSource,
  state: 'ready' | 'missing' | 'error',
  documentCount: number,
  indexedAt: string,
  error?: string,
): KnowledgeSourceStatus {
  const common = {
    root: source.root,
    state,
    documentCount,
    indexedAt,
    ...(error === undefined ? {} : { error }),
  }
  if (source.kind === 'home') return { kind: 'home', ...common }
  return {
    kind: 'workspace',
    workspaceId: source.workspaceId,
    workspaceTitle: source.workspaceTitle,
    workspacePath: source.workspacePath,
    ...common,
  }
}

interface ScanState {
  readonly documents: IndexedKnowledgeDocument[]
  readonly errors: string[]
  attemptedBytes: number
  discoveredDocuments: number
  suppressedErrors: number
  limitReached: boolean
  visitedDirectories: number
  visitedEntries: number
  readonly maximumDocuments: number
  readonly maximumBytes: number
  readonly maximumEntries: number
  readonly maximumDirectories: number
}

export interface KnowledgeScanLimits {
  readonly maximumDocuments?: number
  readonly maximumBytes?: number
  readonly maximumEntries?: number
  readonly maximumDirectories?: number
}

function addScanError(state: ScanState, message: string): void {
  if (state.errors.length < 20) state.errors.push(truncateUtf8(message, 2_048))
  else state.suppressedErrors += 1
}

async function scanDirectory(
  source: KnowledgeSource,
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
  state: ScanState,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (state.limitReached) return
  state.visitedDirectories += 1
  if (state.visitedDirectories > state.maximumDirectories) {
    addScanError(state, `Stopped after ${state.maximumDirectories} directories.`)
    state.limitReached = true
    return
  }
  if (depth > MAX_SCAN_DEPTH) {
    addScanError(state, `Skipped directory beyond maximum depth ${MAX_SCAN_DEPTH}: ${relativeDirectory}`)
    return
  }

  const directoryStat = await lstat(absoluteDirectory)
  const canonicalDirectory = normalize(await realpath(absoluteDirectory))
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    canonicalDirectory !== normalize(absoluteDirectory)
  ) {
    throw new Error(`Directory is not a safe non-symbolic-link directory: ${relativeDirectory}`)
  }

  const directory = await opendir(absoluteDirectory)
  for await (const entry of directory) {
    signal?.throwIfAborted()
    state.visitedEntries += 1
    if (state.visitedEntries > state.maximumEntries) {
      addScanError(state, `Stopped after ${state.maximumEntries} filesystem entries.`)
      state.limitReached = true
      return
    }
    const relativePath =
      relativeDirectory.length === 0
        ? entry.name
        : posix.join(relativeDirectory, entry.name)
    const absolutePath = join(absoluteDirectory, entry.name)

    if (relativePath.length > MAX_RELATIVE_PATH_CHARS || relativePath.includes('\\')) {
      addScanError(state, `Skipped path outside knowledge path bounds: ${relativePath}`)
      continue
    }

    if (entry.isSymbolicLink()) {
      addScanError(state, `Skipped symbolic link: ${relativePath}`)
      continue
    }
    if (entry.isDirectory()) {
      try {
        await scanDirectory(source, absolutePath, relativePath, depth + 1, state, signal)
      } catch (error) {
        if (signal?.aborted === true) throw error
        addScanError(state, `Skipped unsafe or unreadable directory ${relativePath}: ${describeError(error)}`)
      }
      continue
    }
    if (!relativePath.toLocaleLowerCase().endsWith('.md')) continue
    let normalizedRelativePath: string
    try {
      normalizedRelativePath = normalizeRelativeMarkdownPath(relativePath)
    } catch (error) {
      addScanError(state, `Skipped invalid Markdown path ${relativePath}: ${describeError(error)}`)
      continue
    }
    if (!entry.isFile()) {
      addScanError(state, `Skipped non-regular Markdown entry: ${relativePath}`)
      continue
    }

    state.discoveredDocuments += 1
    if (state.discoveredDocuments > state.maximumDocuments) {
      addScanError(state, `Stopped after ${state.maximumDocuments} Markdown documents.`)
      state.limitReached = true
      return
    }

    try {
      const stat = await lstat(absolutePath)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        addScanError(state, `Skipped unsafe Markdown document: ${relativePath}`)
        continue
      }
      if (stat.size > MAX_DOCUMENT_BYTES) {
        addScanError(state, `Skipped oversized Markdown document: ${relativePath}`)
        continue
      }
      if (state.attemptedBytes + stat.size > state.maximumBytes) {
        addScanError(state, `Stopped at the knowledge source byte limit before: ${relativePath}`)
        state.limitReached = true
        return
      }
      state.attemptedBytes += stat.size

      const safeRead = await readSafeRegularFile(absolutePath, MAX_DOCUMENT_BYTES)
      const growth = Math.max(0, safeRead.size - stat.size)
      if (state.attemptedBytes + growth > state.maximumBytes) {
        addScanError(state, `Stopped at the knowledge source byte limit while reading: ${relativePath}`)
        state.limitReached = true
        return
      }
      state.attemptedBytes += growth
      const canonical = normalize(await realpath(absolutePath))
      if (canonical !== normalize(absolutePath)) {
        addScanError(state, `Skipped symbolic-link-resolved Markdown document: ${relativePath}`)
        continue
      }
      const content = decodeUtf8(safeRead.bytes)
      const parsed = parseMarkdownDocument(content, normalizedRelativePath)
      for (const error of parsed.errors) addScanError(state, `${normalizedRelativePath}: ${error}`)
      state.documents.push({
        docRef: documentReference(source, normalizedRelativePath),
        source,
        relativePath: normalizedRelativePath,
        digest: documentDigest(safeRead.bytes),
        name: parsed.name,
        description: parsed.description,
        tags: parsed.tags,
        searchBody: parsed.searchBody,
        headings: parsed.headings,
        sizeBytes: safeRead.size,
        mtimeMs: safeRead.mtimeMs,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      addScanError(state, `Skipped unreadable Markdown document ${relativePath}: ${describeError(error)}`)
    }
  }
}

export async function scanKnowledgeSource(
  source: KnowledgeSource,
  signal?: AbortSignal,
  limits?: KnowledgeScanLimits,
): Promise<ScannedKnowledgeSource> {
  const indexedAt = new Date().toISOString()
  try {
    signal?.throwIfAborted()
    const rootState = await inspectExistingKnowledgeRoot(source.root)
    if (rootState === 'missing') {
      return {
        source,
        documents: [],
        scannedBytes: 0,
        scannedEntries: 0,
        scannedDirectories: 1,
        status: makeStatus(source, 'missing', 0, indexedAt),
      }
    }

    const state: ScanState = {
      documents: [],
      errors: [],
      attemptedBytes: 0,
      discoveredDocuments: 0,
      suppressedErrors: 0,
      limitReached: false,
      visitedDirectories: 0,
      visitedEntries: 0,
      maximumDocuments: Math.min(
        MAX_DOCUMENTS_PER_SOURCE,
        limits?.maximumDocuments ?? MAX_DOCUMENTS_PER_SOURCE,
      ),
      maximumBytes: Math.min(MAX_SOURCE_BYTES, limits?.maximumBytes ?? MAX_SOURCE_BYTES),
      maximumEntries: Math.min(MAX_SCAN_ENTRIES, limits?.maximumEntries ?? MAX_SCAN_ENTRIES),
      maximumDirectories: Math.min(
        MAX_SCAN_DIRECTORIES,
        limits?.maximumDirectories ?? MAX_SCAN_DIRECTORIES,
      ),
    }
    await scanDirectory(source, source.root, '', 0, state, signal)
    const error =
      state.errors.length === 0
        ? undefined
        : [
            ...state.errors,
            ...(state.suppressedErrors === 0
              ? []
              : [`${state.suppressedErrors} additional scan warnings omitted.`]),
          ].join('\n')
    return {
      source,
      documents: state.documents,
      scannedBytes: state.attemptedBytes,
      scannedEntries: state.visitedEntries,
      scannedDirectories: state.visitedDirectories,
      status: makeStatus(
        source,
        error === undefined ? 'ready' : 'error',
        state.documents.length,
        indexedAt,
        error,
      ),
    }
  } catch (error) {
    if (signal?.aborted === true) throw error
    return {
      source,
      documents: [],
      scannedBytes: 0,
      scannedEntries: 0,
      scannedDirectories: 1,
      status: makeStatus(source, 'error', 0, indexedAt, describeError(error)),
    }
  }
}
