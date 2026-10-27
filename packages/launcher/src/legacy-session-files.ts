import { link, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { parseSessionFormatLogFilename, sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'

const ZSTD_MAGIC = 0xFD2FB528

interface FrameRange {
  readonly start: number
  readonly end: number
}

function completeZstdFrames(buffer: Buffer): readonly FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('legacy preset migration found a corrupt or incomplete Zstandard session log')
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error('legacy preset migration found an invalid Zstandard frame descriptor')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) throw new Error('legacy preset migration found a truncated Zstandard frame header')
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error('legacy preset migration found a truncated Zstandard block header')
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      if (blockType === 3) throw new Error('legacy preset migration found a reserved Zstandard block type')
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) throw new Error('legacy preset migration found a truncated Zstandard block')
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error('legacy preset migration found a truncated Zstandard checksum')
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}


/** Preserve pre-0.1.5 unversioned filenames while providing the canonical immutable generation name. */
export async function prepareLegacySessionFilenames(root: string): Promise<void> {
  const copies: Array<{ source: string; target: string; bytes: Buffer; canonical: Buffer }> = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) if (entry.isDirectory()) await visit(join(directory, entry.name))
    // Existing named generations own the Session; retained originals are never read or rewritten.
    if (entries.some(entry => {
      const name = entry.name.replace(/\.zstd$/u, '')
      const version = parseSessionFormatLogFilename(name)
      return version !== undefined && version > 0
    })) return
    for (const entry of entries) {
      if (!entry.isFile() || !['session.jsonl', 'session.jsonl.zstd'].includes(entry.name)) continue
      const source = join(directory, entry.name)
      const bytes = await readFile(source)
      const compressed = entry.name.endsWith('.zstd')
      const text = compressed
        ? completeZstdFrames(bytes).map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')).join('')
        : bytes.toString('utf8')
      const lines = text.split('\n').filter(line => line.length > 0)
      const first = lines.shift()
      if (first === undefined) throw new Error(`empty session log: ${source}`)
      const header: unknown = JSON.parse(first)
      const classification = sessionFormatCatalog.readHeader(header)
      if (classification.status === 'malformed' || classification.status === 'unsupported') throw new Error(`cannot migrate ${source}: ${classification.reason}`)
      // V0 already uses its canonical name. Its eventual conversion belongs to DSH on open.
      if (classification.storedVersion === 0) continue
      // The alpha.1 persistence provider owns full historical restoration,
      // including V3→V4 child-catalog evidence. Filename preparation only
      // validates the header and preserves the original generation bytes.
      const target = join(directory, sessionFormatLogFilename(classification.storedVersion) + (compressed ? '.zstd' : ''))
      copies.push({ source, target, bytes, canonical: !compressed && bytes.at(-1) !== 10 ? Buffer.concat([bytes, Buffer.from('\n')]) : bytes })
    }
  }
  await visit(root)
  // Every source is validated before publishing any alias. Copies are exclusive and originals survive.
  for (const { source, target, bytes, canonical } of copies) {
    if (!(await readFile(source)).equals(bytes)) throw new Error(`session changed during filename migration: ${source}`)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, canonical, { flag: 'wx', mode: 0o600 })
      const handle = await open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      if (!(await readFile(source)).equals(bytes)) throw new Error(`session changed during filename migration: ${source}`)
      try {
        await link(temporary, target)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        if (!(await readFile(target)).equals(canonical)) throw new Error(`session generation already contains different bytes: ${target}`)
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
