#!/usr/bin/env node
// Run with the desktop executable and ELECTRON_RUN_AS_NODE=1. All SSH traffic
// stays on loopback with a temporary synthetic account and a trusted test key.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execution = process.env.DSH_SLOP_SMOKE_PACKAGE
  ? join(resolve(process.env.DSH_SLOP_SMOKE_PACKAGE), 'node_modules/@dsh-slop/execution')
  : fileURLToPath(new URL('../packages/execution/', import.meta.url))
const require = createRequire(join(execution, 'package.json'))
const { Server, utils } = require('ssh2')
const { nativeAlgorithms } = await import(pathToFileURL(join(execution, 'dist/native-ssh-algorithms.js')))
const { openNativeConnection, captureNativeCommand } = await import(pathToFileURL(join(execution, 'dist/native-ssh-client.js')))
const { sshFingerprint } = await import(pathToFileURL(join(execution, 'dist/native-ssh-trust.js')))
const root = await mkdtemp(join(tmpdir(), 'slop-electron-ssh-'))
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const publicKey = utils.parseKey(hostKey)
assert(!(publicKey instanceof Error) && !Array.isArray(publicKey))
const connections = new Set()
const server = new Server({ hostKeys: [hostKey], algorithms: { cipher: ['aes256-ctr'] } }, connection => {
  connections.add(connection)
  connection.on('close', () => connections.delete(connection))
  connection.on('error', () => {})
  let passwordAccepted = false
  connection.on('authentication', auth => {
    if (auth.username === 'key' && auth.method === 'publickey' && auth.key.data.equals(publicKey.getPublicSSH()) && (auth.signature === undefined || publicKey.verify(auth.blob, auth.signature, auth.hashAlgo))) { auth.accept(); return }
    if (auth.username === 'synthetic') {
      if (auth.method === 'password' && auth.password === 'fixture-password') { passwordAccepted = true; auth.reject(['keyboard-interactive'], true); return }
      if (passwordAccepted && auth.method === 'keyboard-interactive') {
        auth.prompt([{ prompt: 'Verification code: ', echo: false }], answers => answers[0] === '654321' ? auth.accept() : auth.reject())
        return
      }
      auth.reject(passwordAccepted ? ['keyboard-interactive'] : ['publickey', 'password']); return
    }
    auth.reject(['publickey'])
  })
  connection.on('ready', () => connection.on('session', accept => {
    accept().on('exec', (acceptChannel, _reject, info) => {
      assert.equal(info.command, 'fixture-probe')
      const channel = acceptChannel()
      channel.exit(0)
      channel.end('runtime-ssh-ok\n')
    })
  }))
})
let client, listening = false
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  listening = true
  const port = server.address().port
  const knownHosts = join(root, 'known_hosts')
  const keyPath = join(root, 'fixture-key.pem')
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${publicKey.type} ${publicKey.getPublicSSH().toString('base64')}\n`)
  await writeFile(keyPath, hostKey)
  const algorithms = nativeAlgorithms(key => key === 'ciphers' ? 'chacha20-poly1305@openssh.com,aes256-ctr' : undefined)
  const profile = { machineId: '018f0000-0000-7000-8000-0000000000a1', revision: 1, alias: 'synthetic', trust: { mode: 'tofu', expectedFingerprints: [sshFingerprint(publicKey.getPublicSSH())] }, ownership: 'app-managed', connectTimeoutSeconds: 5, keepaliveSeconds: 30, idleTimeoutSeconds: 43200, concurrencyLimit: 8 }
  const config = { host: '127.0.0.1', port, username: 'synthetic', identityFiles: [], knownHostsFiles: [knownHosts], algorithms,
    agent: process.platform === 'win32' ? `\\\\.\\pipe\\slop-runtime-missing-${randomUUID()}` : join(root, 'missing-agent.sock') }
  await assert.rejects(openNativeConnection(config, profile, new AbortController().signal), { code: 'AUTH_REQUIRED' })
  const labels = []
  const prompt = { signal: new AbortController().signal, prompt: async label => {
    labels.push(label)
    if (label === 'Password: ') return 'fixture-password'
    if (label === 'Verification code: ') return '654321'
    throw new Error('Unexpected synthetic authentication prompt')
  } }
  client = await openNativeConnection(config, profile, prompt.signal, prompt)
  const result = await captureNativeCommand(client, ['fixture-probe'], undefined, 5000, 1024)
  assert.equal(result.exitCode, 0)
  assert.equal(Buffer.from(result.stdout).toString(), 'runtime-ssh-ok\n')
  assert.deepEqual(labels, ['Password: ', 'Verification code: '])
  client.destroy()
  client = await openNativeConnection({ ...config, username: 'key', identityFiles: [keyPath] }, profile, new AbortController().signal)
  const keyResult = await captureNativeCommand(client, ['fixture-probe'], undefined, 5000, 1024)
  assert.equal(keyResult.exitCode, 0)
  assert.equal(Buffer.from(keyResult.stdout).toString(), 'runtime-ssh-ok\n')
  console.log(JSON.stringify({ runtime: process.versions.electron ? `Electron ${process.versions.electron}` : `Node ${process.versions.node}`, ciphers: algorithms.cipher, agentFallback: true, passwordAnd2fa: true, keyFile: true, commandPassed: true }))
} finally {
  client?.destroy()
  for (const connection of connections) connection.end()
  if (listening) await new Promise(resolve => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
