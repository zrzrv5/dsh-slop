import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { Server, utils, type Connection, type SFTPWrapper, type Attributes } from 'ssh2'

export const fixtureKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
export function parsedKey(key: string) { const value = utils.parseKey(key); if (value instanceof Error || Array.isArray(value)) throw new Error('Invalid fixture key'); return value }

/** Real SSH-agent wire protocol over a Windows named pipe (Unix socket on CI). */
export async function nativeAgent(path: string, privateKey: string) {
  const key = parsedKey(privateKey), sockets = new Set<Socket>()
  let signatures = 0
  const uint = (number: number): Buffer => { const value = Buffer.alloc(4); value.writeUInt32BE(number); return value }
  const field = (value: Buffer): Buffer => Buffer.concat([uint(value.length), value])
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let pending = Buffer.alloc(0)
    socket.on('data', data => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
        const packet = pending.subarray(4, 4 + pending.readUInt32BE(0))
        pending = pending.subarray(packet.length + 4)
        let response: Buffer
        if (packet[0] === 11) response = Buffer.concat([Buffer.from([12]), uint(1), field(key.getPublicSSH()), field(Buffer.from('fixture key'))])
        else if (packet[0] === 13) {
          const keyLength = packet.readUInt32BE(1), dataOffset = 5 + keyLength, dataLength = packet.readUInt32BE(dataOffset)
          const data = packet.subarray(dataOffset + 4, dataOffset + 4 + dataLength), flags = packet.readUInt32BE(dataOffset + 4 + dataLength)
          const algorithm = flags & 4 ? 'rsa-sha2-512' : flags & 2 ? 'rsa-sha2-256' : 'ssh-rsa'
          const signature = key.sign(data, flags & 4 ? 'sha512' : flags & 2 ? 'sha256' : 'sha1')
          signatures++
          response = Buffer.concat([Buffer.from([14]), field(Buffer.concat([field(Buffer.from(algorithm)), field(signature)]))])
        } else response = Buffer.from([5])
        socket.write(Buffer.concat([uint(response.length), response]))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  return { get signatures() { return signatures }, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

/** Synthetic local account only. The fixture never executes a submitted command. */
export async function nativeServer(root: string, hostKey: string, userKey: string) {
  const connections = new Set<Connection>()
  const authenticated: string[] = [], commands: string[] = []
  const state = { stallReads: false, stallSftp: false }
  const key = parsedKey(userKey)
  const server = new Server({ hostKeys: [hostKey] }, client => {
    connections.add(client)
    client.on('close', () => connections.delete(client))
    client.on('error', () => {})
    let passwordPassed = false
    client.on('authentication', auth => {
      if (auth.username === 'key' && auth.method === 'publickey' && auth.key.data.equals(key.getPublicSSH()) && (auth.signature === undefined || key.verify(auth.blob!, auth.signature, auth.hashAlgo))) { auth.accept(); return }
      if (auth.username === 'interactive') {
        if (auth.method === 'password' && auth.password === 'fixture-password') { passwordPassed = true; auth.reject(['keyboard-interactive'], true); return }
        if (auth.method === 'keyboard-interactive' && passwordPassed) {
          auth.prompt([{ prompt: 'Verification code: ', echo: false }], answers => answers[0] === '654321' ? auth.accept() : auth.reject())
          return
        }
        auth.reject(passwordPassed ? ['keyboard-interactive'] : ['publickey', 'password']); return
      }
      auth.reject(['publickey'])
    })
    client.on('ready', () => {
      authenticated.push('authenticated')
      client.on('session', accept => {
        const session = accept()
        session.on('exec', (acceptChannel, _reject, info) => {
          commands.push(info.command)
          const channel = acceptChannel()
          channel.on('error', () => {})
          if (info.command === 'hang') return
          if (info.command === 'disconnect') { client.end(); return }
          if (info.command === 'flood') { channel.write(Buffer.alloc(8192, 120)); channel.exit(0); channel.end(); return }
          channel.stderr.write('fixture-stderr\n')
          channel.write('fixture-stdout\n')
          channel.exit(info.command === 'status255' ? 255 : 0)
          channel.end()
        })
        session.on('sftp', acceptSftp => { if (!state.stallSftp) serveSftp(acceptSftp(), root, () => state.stallReads) })
      })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Fixture did not listen')
  return { port: address.port, authenticated, commands, state, async close() { for (const client of connections) client.end(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

function serveSftp(sftp: SFTPWrapper, root: string, stallReads: () => boolean): void {
  const files = new Map<string, FileHandle>(), directories = new Map<string, string[]>()
  let nextHandle = 0
  const path = (remote: string): string => {
    const result = join(root, remote)
    const rel = relative(root, result)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Fixture path escaped')
    return result
  }
  const attrs = (stats: Awaited<ReturnType<typeof lstat>>): Attributes => ({ mode: stats.mode, uid: stats.uid, gid: stats.gid, size: stats.size, atime: Math.floor(stats.atimeMs / 1000), mtime: Math.floor(stats.mtimeMs / 1000) })
  const request = (id: number, action: () => Promise<void>): void => { void action().catch(error => sftp.status(id, error.code === 'ENOENT' ? 2 : 4)) }
  sftp.on('error', () => {})
  sftp.on('close', () => { for (const file of files.values()) void file.close().catch(() => {}) })
  for (const event of ['STAT', 'LSTAT'] as const) sftp.on(event, (id, remote) => request(id, async () => { sftp.attrs(id, attrs(await lstat(path(remote)))) }))
  sftp.on('OPEN', (id, remote, flags) => request(id, async () => {
    const file = await open(path(remote), utils.sftp.flagsToString(flags) ?? 'r')
    const handle = Buffer.from(String(++nextHandle))
    files.set(handle.toString(), file); sftp.handle(id, handle)
  }))
  sftp.on('FSTAT', (id, handle) => request(id, async () => { sftp.attrs(id, attrs(await files.get(handle.toString())!.stat())) }))
  sftp.on('READ', (id, handle, offset, length) => request(id, async () => {
    if (stallReads()) return
    const buffer = Buffer.alloc(Math.min(length, 32768))
    const { bytesRead } = await files.get(handle.toString())!.read(buffer, 0, buffer.length, offset)
    if (bytesRead) sftp.data(id, buffer.subarray(0, bytesRead)); else sftp.status(id, 1)
  }))
  sftp.on('WRITE', (id, handle, offset, data) => request(id, async () => { await files.get(handle.toString())!.write(data, 0, data.length, offset); sftp.status(id, 0) }))
  sftp.on('CLOSE', (id, handle) => request(id, async () => {
    const name = handle.toString(); await files.get(name)?.close(); files.delete(name); directories.delete(name); sftp.status(id, 0)
  }))
  sftp.on('MKDIR', (id, remote) => request(id, async () => { await mkdir(path(remote)); sftp.status(id, 0) }))
  sftp.on('OPENDIR', (id, remote) => request(id, async () => {
    const handle = Buffer.from(String(++nextHandle)); directories.set(handle.toString(), (await readdir(path(remote))).map(name => remote.replace(/\/$/u, '') + '/' + name)); sftp.handle(id, handle)
  }))
  sftp.on('READDIR', (id, handle) => request(id, async () => {
    const entries = directories.get(handle.toString())!.splice(0)
    if (!entries.length) { sftp.status(id, 1); return }
    sftp.name(id, await Promise.all(entries.map(async remote => ({ filename: remote.slice(remote.lastIndexOf('/') + 1), longname: '', attrs: attrs(await lstat(path(remote))) }))))
  }))
}
