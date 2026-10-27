import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoredArtifact {
  sha256: string
  size: string
  path: string
}

/** Owner-only SHA-256 content-addressed object storage with atomic commits. */
export class LocalArtifactStore {
  constructor(private readonly root: string) {}

  private objectPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid artifact digest')
    return join(this.root, 'objects', digest.slice(0, 2), digest.slice(2))
  }

  async putBytes(bytes: Uint8Array): Promise<StoredArtifact> {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const path = this.objectPath(sha256)
    await mkdir(join(this.root, 'objects', sha256.slice(0, 2)), { recursive: true, mode: 0o700 })
    try {
      const existing = await stat(path)
      if (existing.size !== bytes.byteLength) throw new Error('content-addressed object size mismatch')
      return { sha256, size: String(existing.size), path }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    try {
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
      })
      throw error
    }
    return { sha256, size: String(bytes.byteLength), path }
  }

  async read(digest: string, offset: number, limit: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid artifact range')
    const bytes = await readFile(this.objectPath(digest))
    return bytes.subarray(offset, Math.min(bytes.byteLength, offset + limit))
  }
}
