import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse as parsePath,
  posix,
  resolve,
} from 'node:path'
import { KnowledgeError, errorCode } from './errors.js'

export const MAX_DOCUMENT_BYTES = 1024 * 1024
export const MAX_AGENT_WRITE_BYTES = 64 * 1_024
export const MAX_SECTION_REPLACEMENTS = 32
export const MAX_HEADING_PATH_DEPTH = 6
export const MAX_DOCUMENTS_PER_SOURCE = 5_000
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024
export const MAX_SCAN_DEPTH = 16
export const MAX_SCAN_ENTRIES = 20_000
export const MAX_SCAN_DIRECTORIES = 2_000
export const MAX_RELATIVE_PATH_CHARS = 1_024
export const MAX_ROOT_PATH_CHARS = 4_096
export const MAX_QUERY_CHARS = 1_024
export const MAX_SEARCH_LIMIT = 20
export const DEFAULT_SEARCH_LIMIT = 8
export const MAX_READ_BYTES = 64 * 1_024
export const DEFAULT_READ_BYTES = 8 * 1_024
export const MAX_REBUILD_DOCUMENTS = 10_000
export const MAX_REBUILD_BYTES = 64 * 1_024 * 1_024
export const MAX_SETTINGS_SCAN_ENTRIES = 50_000
export const MAX_SETTINGS_SCAN_DIRECTORIES = 5_000

export interface SafeFileRead {
  readonly bytes: Buffer
  readonly size: number
  readonly mtimeMs: number
  readonly dev: number
  readonly ino: number
  readonly mode: number
}

export function normalizeAbsoluteRoot(root: string): string {
  if (root.length === 0 || root.length > MAX_ROOT_PATH_CHARS) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `Knowledge root must contain 1 to ${MAX_ROOT_PATH_CHARS} characters.`,
    )
  }
  if (root.includes('\0')) {
    throw new KnowledgeError('KNOWLEDGE_SECURITY', 'Knowledge root contains a NUL byte.')
  }
  if (!isAbsolute(root)) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge root must be absolute.')
  }
  const normalized = normalize(resolve(root))
  if (normalized === parsePath(normalized).root) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_ARGUMENT',
      'Knowledge root cannot be a filesystem or volume root.',
    )
  }
  return normalized
}

export function normalizeRelativeMarkdownPath(relativePath: string): string {
  if (relativePath.length === 0 || relativePath.length > MAX_RELATIVE_PATH_CHARS) {
    throw new KnowledgeError(
      'KNOWLEDGE_BOUNDS',
      `Knowledge path must contain 1 to ${MAX_RELATIVE_PATH_CHARS} characters.`,
    )
  }
  if (relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new KnowledgeError(
      'KNOWLEDGE_SECURITY',
      'Knowledge paths cannot contain NUL bytes or backslashes.',
    )
  }
  if (posix.isAbsolute(relativePath)) {
    throw new KnowledgeError('KNOWLEDGE_SECURITY', 'Knowledge path must be relative.')
  }

  const segments = relativePath.split('/')
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\0'),
    )
  ) {
    throw new KnowledgeError(
      'KNOWLEDGE_SECURITY',
      'Knowledge path contains an empty, current-directory, or parent-directory segment.',
    )
  }

  const normalized = posix.normalize(relativePath)
  if (normalized !== relativePath || !normalized.toLocaleLowerCase().endsWith('.md')) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_ARGUMENT',
      'Knowledge path must be a normalized relative path ending in .md.',
    )
  }
  return normalized
}

async function validateExistingDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) {
    throw new KnowledgeError('KNOWLEDGE_SECURITY', `Symbolic-link directory is not allowed: ${path}`)
  }
  if (!stat.isDirectory()) {
    throw new KnowledgeError('KNOWLEDGE_SECURITY', `Expected a directory: ${path}`)
  }
  const canonical = normalize(await realpath(path))
  if (canonical !== normalize(path)) {
    throw new KnowledgeError(
      'KNOWLEDGE_SECURITY',
      `Knowledge directory resolves through a symbolic link: ${path}`,
    )
  }
}

export async function inspectExistingKnowledgeRoot(root: string): Promise<'ready' | 'missing'> {
  const normalized = normalizeAbsoluteRoot(root)
  try {
    await validateExistingDirectory(normalized)
    return 'ready'
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

export async function ensureKnowledgeRoot(root: string): Promise<string> {
  const normalized = normalizeAbsoluteRoot(root)
  const missing: string[] = []
  let cursor = normalized

  while (true) {
    try {
      await validateExistingDirectory(cursor)
      break
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      missing.unshift(cursor)
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }

  for (const path of missing) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    await validateExistingDirectory(path)
  }
  return normalized
}

function relativeSegments(relativePath: string): readonly string[] {
  return normalizeRelativeMarkdownPath(relativePath).split('/')
}

export async function resolveSafeExistingDocument(
  root: string,
  relativePath: string,
): Promise<string> {
  const normalizedRoot = normalizeAbsoluteRoot(root)
  await validateExistingDirectory(normalizedRoot)
  const segments = relativeSegments(relativePath)
  const target = join(normalizedRoot, ...segments)
  const stat = await lstat(target)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new KnowledgeError(
      'KNOWLEDGE_SECURITY',
      `Knowledge document is not a regular non-symbolic-link file: ${relativePath}`,
    )
  }
  const canonical = normalize(await realpath(target))
  if (canonical !== normalize(target)) {
    throw new KnowledgeError(
      'KNOWLEDGE_SECURITY',
      `Knowledge document resolves through a symbolic link: ${relativePath}`,
    )
  }
  return target
}

export async function readSafeRegularFile(path: string, maximumBytes: number): Promise<SafeFileRead> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const nonBlocking = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximumBytes) {
      throw new KnowledgeError(
        'KNOWLEDGE_BOUNDS',
        `Knowledge document must be a regular file no larger than ${maximumBytes} bytes.`,
      )
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      bytes.length > maximumBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new KnowledgeError(
        'KNOWLEDGE_CONFLICT',
        'Knowledge document changed while it was being read.',
      )
    }
    return {
      bytes,
      size: after.size,
      mtimeMs: after.mtimeMs,
      dev: after.dev,
      ino: after.ino,
      mode: after.mode,
    }
  } finally {
    await handle.close()
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_MARKDOWN',
      'Knowledge document is not valid UTF-8.',
      { cause: error },
    )
  }
}

export async function prepareSafeWriteTarget(
  root: string,
  relativePath: string,
): Promise<string> {
  const normalizedRoot = await ensureKnowledgeRoot(root)
  const segments = relativeSegments(relativePath)
  let directory = normalizedRoot

  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    await validateExistingDirectory(directory)
  }

  const fileName = segments.at(-1)
  if (fileName === undefined) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Knowledge path has no file name.')
  }
  return join(directory, fileName)
}

export function filesystemRoot(path: string): string {
  return parsePath(path).root
}
