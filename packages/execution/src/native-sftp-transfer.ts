import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { Transform, Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'
import { LOCAL_OWNER_PRINCIPAL_ID, type ConnectionLeaseId, type MachineId } from '@dsh-slop/core'
import type { NativeSshBroker } from './native-ssh-broker.ts'
import { SshConnectionError } from './ssh-broker.ts'
import type { MachineTransferEndpoint, MachineTransferRequest, MachineTransferResult } from './machine-transfer-service.ts'

interface Entry { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
interface FileSystem {
  stat(path: string): Promise<Entry>
  names(path: string): Promise<string[]>
  mkdir(path: string): Promise<void>
  read(path: string): Readable
  write(path: string): Writable
  join(path: string, name: string): string
  parent(path: string): string
  basename(path: string): string
}

const localFiles: FileSystem = {
  stat: lstat, names: readdir, mkdir: async path => { await mkdir(path) },
  read: createReadStream, write: path => createWriteStream(path, { mode: 0o600 }),
  join, parent: dirname, basename,
}

function remoteFiles(sftp: SFTPWrapper, signal: AbortSignal): FileSystem {
  const call = async <T>(invoke: (done: (error: Error | undefined | null, value: T) => void) => void): Promise<T> => {
    signal.throwIfAborted()
    return await new Promise<T>((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener('abort', abort); sftp.removeListener('close', closed) }
      const abort = (): void => { cleanup(); reject(new Error('SFTP request cancelled')) }
      const closed = (): void => { cleanup(); reject(new Error('SFTP channel closed; a partial destination may exist.')) }
      signal.addEventListener('abort', abort, { once: true }); sftp.once('close', closed)
      try { invoke((error, value) => { cleanup(); if (error) reject(error); else resolve(value) }) }
      catch (error) { cleanup(); reject(error) }
    })
  }
  const close = async (handle: Buffer): Promise<void> => {
    if (signal.aborted) return // The owner closes the SFTP channel on cancellation.
    await call<void>(done => sftp.close(handle, error => done(error, undefined)))
  }
  const read = async function* (path: string): AsyncGenerator<Buffer> {
    const handle = await call<Buffer>(done => sftp.open(path, 'r', done))
    let offset = 0
    try {
      while (true) {
        const buffer = Buffer.alloc(64 * 1024)
        const length = await call<number>(done => sftp.read(handle, buffer, 0, buffer.length, offset, (error, bytesRead) => done(error, bytesRead)))
        if (!length) return
        offset += length
        yield buffer.subarray(0, length)
      }
    } finally { await close(handle) }
  }
  return {
    stat: async path => await call<Entry>(done => sftp.lstat(path, done)),
    names: async path => await call<string[]>(done => sftp.readdir(path, (error, entries) => done(error, entries?.map(entry => entry.filename) ?? []))),
    mkdir: async path => { await call<void>(done => sftp.mkdir(path, { mode: 0o700 }, error => done(error, undefined))) },
    read: path => Readable.from(read(path)),
    write: path => {
      let handle: Buffer | undefined, offset = 0
      return new Writable({
        construct(done) { void call<Buffer>(callback => sftp.open(path, 'w', { mode: 0o600 }, callback)).then(value => { handle = value; done() }, done) },
        write(data: Buffer, _encoding, done) {
          void call<void>(callback => sftp.write(handle!, data, 0, data.length, offset, error => callback(error, undefined))).then(() => { offset += data.length; done() }, done)
        },
        destroy(error, done) { if (handle === undefined) done(error); else void close(handle).then(() => done(error), failure => done(failure instanceof Error ? failure : new Error('SFTP close failed'))) },
        autoDestroy: true,
      })
    },
    join: posix.join, parent: posix.dirname, basename: posix.basename,
  }
}

async function existing(files: FileSystem, path: string): Promise<Entry | undefined> {
  try { return await files.stat(path) } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 2)) return undefined
    throw error
  }
}

function safeName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\\/\0\r\n]/u.test(name)) throw new Error('The source contains an unsafe filename.')
  if (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/u.test(name) || /[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))) throw new Error('The source filename cannot be represented safely on Windows.')
}

/** Stream through Host memory with backpressure; never stage payloads on disk. */
export function nativeSftpTransfer(broker: Pick<NativeSshBroker, 'connect' | 'release' | 'openSftp'>): (request: MachineTransferRequest) => Promise<MachineTransferResult> {
  return async request => {
    if (request.protocol === 'scp') throw new Error('Native Windows transfer uses SFTP. Legacy SCP (-O) requires the explicitly selected WSL backend; no automatic fallback was attempted.')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ...request.signal === undefined ? [] : [request.signal]])
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort(new Error('Transfer timed out')) }, request.timeoutMs ?? 30 * 60_000)
    const leases: ConnectionLeaseId[] = []
    const channels = new Map<MachineId, SFTPWrapper>()
    let entryKind: 'file' | 'directory' = 'file', terminalOutput = '', bytes = 0, entries = 0, started = false, lastProgress = Date.now()
    const report = (text: string): void => {
      terminalOutput = Buffer.from(terminalOutput + text).subarray(-128 * 1024).toString('utf8')
      request.onProgress?.(text)
    }
    const abort = (): void => { for (const channel of channels.values()) channel.destroy() }
    signal.addEventListener('abort', abort, { once: true })
    const filesFor = (endpoint: MachineTransferEndpoint): FileSystem => endpoint.kind === 'local' ? localFiles : remoteFiles(channels.get(endpoint.machineId)!, signal)
    try {
      signal.throwIfAborted()
      for (const endpoint of [request.source, request.destination]) {
        if (endpoint.kind === 'local' || channels.has(endpoint.machineId)) continue
        const lease = await broker.connect(endpoint.machineId, LOCAL_OWNER_PRINCIPAL_ID)
        leases.push(lease.id)
        signal.throwIfAborted()
        channels.set(endpoint.machineId, await broker.openSftp(lease.id, LOCAL_OWNER_PRINCIPAL_ID, signal))
      }
      const source = filesFor(request.source), destination = filesFor(request.destination)
      const info = await source.stat(request.source.path)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('The source must be a regular file or directory, not a symbolic link.')
      entryKind = info.isDirectory() ? 'directory' : 'file'
      // Refuse links in the existing destination chain, including Windows junctions.
      for (let path = request.destination.path; ; path = destination.parent(path)) {
        signal.throwIfAborted()
        if ((await existing(destination, path))?.isSymbolicLink()) throw new Error('The destination must not traverse symbolic links or junctions.')
        if (destination.parent(path) === path) break
      }
      const targetInfo = await existing(destination, request.destination.path)
      const sourceName = source.basename(request.source.path)
      safeName(sourceName)
      const target = targetInfo?.isDirectory() ? destination.join(request.destination.path, sourceName) : request.destination.path
      const copy = async (from: string, to: string, depth: number): Promise<void> => {
        signal.throwIfAborted()
        if (++entries > 100_000 || depth > 64) throw new Error('Directory transfer exceeds the entry or depth limit; use an archive.')
        const sourceInfo = await source.stat(from), destinationInfo = await existing(destination, to)
        if (sourceInfo.isSymbolicLink() || destinationInfo?.isSymbolicLink()) throw new Error('Transfers do not follow symbolic links.')
        if (sourceInfo.isDirectory()) {
          if (destinationInfo === undefined) await destination.mkdir(to)
          else if (!destinationInfo.isDirectory()) throw new Error('A destination file conflicts with a source directory.')
          for (const name of await source.names(from)) {
            safeName(name)
            await copy(source.join(from, name), destination.join(to, name), depth + 1)
          }
        } else if (sourceInfo.isFile()) {
          if (destinationInfo !== undefined && !destinationInfo.isFile()) throw new Error('The destination is not a regular file.')
          const count = new Transform({ transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length
            if (Date.now() - lastProgress >= 250) { report(`Transferred ${bytes} bytes across ${entries} entries.\r\n`); lastProgress = Date.now() }
            done(null, chunk)
          } })
          await pipeline(source.read(from), count, destination.write(to), { signal })
          report(`Transferred ${bytes} bytes across ${entries} entries.\r\n`)
        } else throw new Error('The source contains a non-regular file.')
      }
      started = true
      await copy(request.source.path, target, 0)
      report(`Transfer complete: ${bytes} bytes.\r\n`)
      return { kind: 'completed', source: request.source, destination: request.destination, entryKind, relayedThroughHost: request.source.kind === 'machine' && request.destination.kind === 'machine', exitCode: 0, signal: null, timedOut: false, terminalOutput }
    } catch (error) {
      request.signal?.throwIfAborted()
      if (!started && error instanceof SshConnectionError) throw error
      const message = timedOut ? 'Transfer timed out.' : error instanceof Error ? error.message.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ').slice(0, 1024) : 'SFTP transfer failed.'
      report(`${message} A partial destination may exist.\r\n`)
      return { kind: 'completed', source: request.source, destination: request.destination, entryKind, relayedThroughHost: request.source.kind === 'machine' && request.destination.kind === 'machine', exitCode: timedOut ? null : 1, signal: null, timedOut, terminalOutput }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      for (const channel of channels.values()) channel.end()
      await Promise.all(leases.map(id => broker.release(id, LOCAL_OWNER_PRINCIPAL_ID)))
    }
  }
}
