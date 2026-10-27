#!/usr/bin/env node
// Local protocol fixture only: no real account, password, host or scheduler.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import ssh2 from 'ssh2'
import { DshProcessDriver, OpenSshBroker, SshPlatform, persistPinnedKnownHost } from '../packages/execution/dist/index.js'
import { DshAuthFlow, controlSocketRoot } from '../packages/operations/dist/index.js'

assert.equal(process.platform, 'win32', 'This receipt checks Windows + WSL.')
const { utils } = ssh2
const fromDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const fromBase = createRequire(fromDsh.resolve('@deepseek-ai/dsh-base/package.json'))
const { Context } = await import(pathToFileURL(fromBase.resolve('@deepseek-ai/cordis')))
const { default: LocalSubprocessRuntime } = await import(pathToFileURL(fromBase.resolve('@deepseek-ai/dsh-subprocess-local')))
const ctx = new Context()
const subprocessFiber = await ctx.plugin(LocalSubprocessRuntime)
const root = await mkdtemp(join(tmpdir(), 'slop Windows SSH '))
const local = new DshProcessDriver(ctx.subprocess)
const platform = new SshPlatform(local, root)
const driver = new DshProcessDriver(ctx.subprocess, platform.prepareCommand)
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
const hostKey = key()
const userKey = key()
const hostPublic = utils.parseKey(hostKey)
let broker, auth, linuxRoot, configPath
const prepareCommand = argv => platform.prepareCommand(argv[0] === 'ssh' && configPath ? ['ssh', '-F', configPath, ...argv.slice(1)] : argv)
const sshDriver = new DshProcessDriver(ctx.subprocess, prepareCommand)
const receipt = join(root, 'authentications')
const authentications = async () => (await readFile(receipt, 'utf8')).trim().split('\n').length
const capture = async argv => {
  const result = await driver.capture({ argv, cwd: root, timeoutMs: 20_000, maxOutputBytes: 16_384 })
  assert.equal(result.exitCode, 0, Buffer.from(result.stderr).toString())
  return Buffer.from(result.stdout).toString().trim()
}
try {
  const host = '127.0.0.1', port = 22222
  linuxRoot = await capture(['mktemp', '-d', '/tmp/slop-windows-smoke-XXXXXXXX'])
  assert.match(linuxRoot, /^\/tmp\/slop-windows-smoke-[A-Za-z0-9]+$/)
  const keyPath = `${linuxRoot}/key`
  const saved = await driver.capture({ argv: ['sh', '-c', 'umask 077; cat > "$1"', 'save-fixture-key', keyPath], cwd: root, stdin: Buffer.from(userKey), timeoutMs: 10_000, maxOutputBytes: 1024 })
  assert.equal(saved.exitCode, 0)
  const hostFile = join(root, 'host.pem'), userFile = join(root, 'user.pem')
  await writeFile(hostFile, hostKey)
  await writeFile(userFile, userKey)
  const linuxPath = path => capture(['wslpath', '-u', path])
  const tooling = fileURLToPath(new URL('../artifacts/ssh-fixture-tools/', import.meta.url))
  await capture(['tar', '-xJf', await linuxPath(join(tooling, 'node-linux.tar.xz')), '-C', linuxRoot])
  const nodeLinux = `${linuxRoot}/node-v24.11.1-linux-x64/bin/node`
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const proxyPaths = await Promise.all([fileURLToPath(new URL('./ssh-fixture-stdio.mjs', import.meta.url)), hostFile, userFile, receipt, join(tooling, 'node_modules/ssh2/lib/index.js')].map(linuxPath))
  const proxy = [nodeLinux, ...proxyPaths].map(quote).join(' ')
  configPath = `${linuxRoot}/config`
  const config = `Host *\n  ProxyCommand ${proxy}\n  UserKnownHostsFile /dev/null\n  IdentitiesOnly yes\n`
  const configured = await driver.capture({ argv: ['sh', '-c', 'umask 077; cat > "$1"', 'save-fixture-config', configPath], cwd: root, stdin: Buffer.from(config), timeoutMs: 10_000, maxOutputBytes: 1024 })
  assert.equal(configured.exitCode, 0)
  const knownHosts = join(root, 'approved known_hosts')
  const fingerprint = `SHA256:${createHash('sha256').update(hostPublic.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
  await persistPinnedKnownHost(knownHosts, `[${host}]:${port} ${hostPublic.type} ${hostPublic.getPublicSSH().toString('base64')}\n`, fingerprint, [fingerprint])
  const keyId = '00000000-0000-7000-8000-000000000001'
  const interactiveId = '00000000-0000-7000-8000-000000000002'
  const profiles = { get: async machineId => ({ machineId, revision: 1, alias: `${machineId === keyId ? 'key' : 'interactive'}@${host}`, port,
    ...(machineId === keyId ? { localKeyFilePath: keyPath } : {}),
    trust: { mode: 'pinned', expectedFingerprints: [fingerprint], appKnownHostsPath: knownHosts }, ownership: 'app-managed', connectTimeoutSeconds: 5, keepaliveSeconds: 30, idleTimeoutSeconds: 43200, concurrencyLimit: 8 }) }
  broker = new OpenSshBroker(profiles, sshDriver, controlSocketRoot(root), root, {
    begin: async request => {
      const view = await auth.create({ ownerPrincipalId: request.ownerPrincipalId, machineId: request.profile.machineId, connectionIdentityDigest: request.identityDigest, argv: request.bootstrapArgv, cwd: request.cwd, expiresInMs: 30_000 })
      return { flowId: view.flowId, expiresAt: view.expiresAt }
    },
  })
  auth = new DshAuthFlow(ctx.subprocess, async request => {
    const lease = await broker.connect(request.machineId, request.ownerPrincipalId)
    await broker.release(lease.id, request.ownerPrincipalId)
    return true
  }, prepareCommand)
  const probe = async id => {
    const lease = await broker.connect(id, 'local-owner')
    try {
      const result = await broker.run(lease.id, ['fixture-probe'], undefined, 10_000, 1024)
      assert.equal(Buffer.from(result.stdout).toString(), 'reused-session\n')
    } finally { await broker.release(lease.id, 'local-owner') }
  }
  await probe(keyId)
  await probe(keyId)
  assert.equal(await authentications(), 1, 'Key commands must reuse one authenticated master')
  await assert.rejects(broker.connect(interactiveId, 'local-owner'), error => error.code === 'AUTH_REQUIRED')
  const flow = await broker.beginAuth(interactiveId, 'local-owner')
  let transcript = '', passwordSent = false, codeSent = false
  auth.subscribe(flow.flowId, 'local-owner', bytes => {
    transcript += Buffer.from(bytes).toString()
    if (!passwordSent && transcript.includes('Fixture password:')) { passwordSent = true; void auth.write(flow.flowId, 'local-owner', 'fixture-password\r') }
    if (!codeSent && transcript.includes('Fixture verification code:')) { codeSent = true; void auth.write(flow.flowId, 'local-owner', '654321\r') }
  })
  for (let attempt = 0; attempt < 150 && auth.describe(flow.flowId, 'local-owner').state !== 'ready'; attempt++) await delay(100)
  assert.equal(auth.describe(flow.flowId, 'local-owner').state, 'ready', 'Protected WSL PTY must complete password + code authentication')
  assert(passwordSent && codeSent)
  assert(!transcript.includes('fixture-password') && !transcript.includes('654321'), 'Protected terminal must not echo credentials')
  await probe(interactiveId)
  await probe(interactiveId)
  assert.equal(await authentications(), 2, '2FA commands must reuse the protected terminal master')
} finally {
  await auth?.close()
  await broker?.close()
  if (linuxRoot && /^\/tmp\/slop-windows-smoke-[A-Za-z0-9]+$/.test(linuxRoot)) await capture(['rm', '-r', '--', linuxRoot])
  await driver.close()
  await local.close()
  await sshDriver.close()
  await subprocessFiber.dispose()
  await rm(root, { recursive: true, force: true })
}
console.log('Windows SSH smoke passed: WSL, spaced trust path, pinned host key, key auth, protected password/code PTY, and master reuse for both modes.')
// RC2's ConPTY dependency retains a MessagePort after provider disposal.
// Exit this standalone fixture only after every owned process and file is closed.
process.exit(0)
