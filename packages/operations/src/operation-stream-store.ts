import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type OperationStream = 'stdout' | 'stderr' | 'data'
export type OperationTerminal = 'success' | 'cancelled' | 'timeout' | 'rejected' | 'ambiguous' | 'lost'

interface StreamMetadata {
  schemaVersion: 1
  baseOffset: string
  nextOffset: string
  terminal?: OperationTerminal
}

export interface StreamRead {
  stream: OperationStream
  offset: string
  nextOffset: string
  earliestOffset: string
  bytes: Uint8Array
  eof: boolean
}

export class ResyncRequiredError extends Error {
  readonly code = 'RESYNC_REQUIRED'
  constructor(readonly earliestOffset: string) {
    super(`requested bytes are no longer retained; earliest offset is ${earliestOffset}`)
  }
}

/** File-backed independent operation streams with bounded retention and offset replay. */
export class FileOperationStreamStore {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly root: string, private readonly maxRetainedBytes = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes <= 0) throw new Error('maxRetainedBytes must be a positive safe integer')
  }

  private streamDir(operationId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('invalid operation id')
    return join(this.root, operationId)
  }

  private async metadata(operationId: string, stream: OperationStream): Promise<StreamMetadata> {
    try {
      const parsed = JSON.parse(await readFile(join(this.streamDir(operationId), `${stream}.json`), 'utf8')) as StreamMetadata
      if (parsed.schemaVersion !== 1 || !/^\d+$/.test(parsed.baseOffset) || !/^\d+$/.test(parsed.nextOffset)) throw new Error('invalid stream metadata')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, baseOffset: '0', nextOffset: '0' }
    }
  }

  private async saveMetadata(operationId: string, stream: OperationStream, value: StreamMetadata): Promise<void> {
    const directory = this.streamDir(operationId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, `${stream}.json`)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }

  private async exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
    const queued = prior.then(() => current)
    this.queues.set(key, queued)
    await prior
    try {
      return await action()
    } finally {
      release()
      if (this.queues.get(key) === queued) this.queues.delete(key)
    }
  }

  async append(operationId: string, stream: OperationStream, bytes: Uint8Array): Promise<{ offset: string; nextOffset: string }> {
    return await this.exclusive(`${operationId}:${stream}`, async () => {
      const metadata = await this.metadata(operationId, stream)
      if (metadata.terminal !== undefined) throw new Error('cannot append to a closed operation stream')
      const offset = BigInt(metadata.nextOffset)
      const directory = this.streamDir(operationId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, `${stream}.bin`)
      const handle = await open(path, 'a', 0o600)
      try {
        await handle.write(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const nextOffset = offset + BigInt(bytes.byteLength)
      let baseOffset = BigInt(metadata.baseOffset)
      const size = Number(nextOffset - baseOffset)
      if (size > this.maxRetainedBytes) {
        const content = await readFile(path)
        const kept = content.subarray(content.byteLength - this.maxRetainedBytes)
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, kept, { mode: 0o600 })
        await rename(temporary, path)
        baseOffset = nextOffset - BigInt(kept.byteLength)
      }
      await this.saveMetadata(operationId, stream, { schemaVersion: 1, baseOffset: String(baseOffset), nextOffset: String(nextOffset) })
      return { offset: String(offset), nextOffset: String(nextOffset) }
    })
  }

  async read(operationId: string, stream: OperationStream, offsetText: string, limit: number): Promise<StreamRead> {
    if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid stream read range')
    return await this.exclusive(`${operationId}:${stream}`, async () => {
      const metadata = await this.metadata(operationId, stream)
      const offset = BigInt(offsetText)
      const base = BigInt(metadata.baseOffset)
      const next = BigInt(metadata.nextOffset)
      if (offset < base) throw new ResyncRequiredError(metadata.baseOffset)
      if (offset > next) throw new Error('stream offset is beyond the current end')
      const available = Number(next - offset)
      const length = Math.min(limit, available)
      const bytes = new Uint8Array(length)
      if (length > 0) {
        const handle = await open(join(this.streamDir(operationId), `${stream}.bin`), 'r')
        try {
          await handle.read(bytes, 0, length, Number(offset - base))
        } finally {
          await handle.close()
        }
      }
      const returnedNext = offset + BigInt(length)
      return { stream, offset: offsetText, nextOffset: String(returnedNext), earliestOffset: metadata.baseOffset, bytes, eof: metadata.terminal !== undefined && returnedNext === next }
    })
  }

  async close(operationId: string, stream: OperationStream, terminal: OperationTerminal): Promise<void> {
    await this.exclusive(`${operationId}:${stream}`, async () => {
      const metadata = await this.metadata(operationId, stream)
      if (metadata.terminal !== undefined && metadata.terminal !== terminal) throw new Error('operation stream already closed with another terminal state')
      await this.saveMetadata(operationId, stream, { ...metadata, terminal })
    })
  }

  async describe(operationId: string): Promise<Record<OperationStream, StreamMetadata>> {
    return {
      stdout: await this.metadata(operationId, 'stdout'),
      stderr: await this.metadata(operationId, 'stderr'),
      data: await this.metadata(operationId, 'data'),
    }
  }

  async release(operationId: string): Promise<void> {
    const directory = this.streamDir(operationId)
    await rm(directory, { recursive: true, force: true })
  }
}
