#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-slop-plugin-smoke-'))
const cli = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const env = { ...process.env, DSH_HOME: join(temporary, 'home') }
delete env.DSH_SLOP_HOME
delete env.DSH_SLOP_SKILL_DIR
delete env.DSH_BUNDLED_SKILL_DIR
let host
let exited
let output = ''
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: temporary, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
})

try {
  run(process.execPath, [join(root, 'scripts/pack-plugin.mjs'), ...process.argv.slice(2)], {
    env: { ...env, DSH_SLOP_PLUGIN_DIR: temporary },
  })
  const { version } = JSON.parse(await readFile(join(root, 'packages/bundle/package.json'), 'utf8'))
  const archive = join(temporary, `dsh-slop-${version}.tgz`)
  const contents = run('tar', ['-tzf', archive])
  assert(!contents.includes('deployments/'), 'No operator deployment in the plugin')
  assert(!contents.includes('/node_modules/.pnpm/'), 'No checkout symlink graph in the plugin')
  const archivePaths = contents.trim().split(/\r?\n/u)
  assert(!archivePaths.some(path => path.endsWith('.tsbuildinfo')), 'No TypeScript build cache in the plugin')
  assert(!archivePaths.some(path => path.endsWith('.node')), 'No platform-specific native addon in the plugin')
  assert(!archivePaths.some(path => /^package\/node_modules\/[^/]+\/(?:test|tests|example|examples|bench|benchmark|benchmarks)\//u.test(path)), 'No dependency development fixtures in the plugin')
  for (const name of ['ssh2', 'asn1', 'bcrypt-pbkdf', 'safer-buffer', 'tweetnacl']) {
    assert(archivePaths.includes(`package/node_modules/${name}/LICENSE`), `${name} license must remain in the plugin`)
  }
  // A harmless pre-existing dependency exercises profile preservation without
  // introducing a provider or account into the test.
  run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', 'is-number@7.0.0'])
  const fixture = join(temporary, 'live-install.mjs')
  await writeFile(fixture, `
export const inject = ['pluginManager', 'webServer', 'agentPresets']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture-install', handler: async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    try {
      const result = await ctx.pluginManager.installBundle(${JSON.stringify(archive)})
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ...result, presets: await ctx.agentPresets.list() }))
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  } }))
}
`)
  const fixturePatch = join(temporary, 'live-install.yml')
  await writeFile(fixturePatch, JSON.stringify([{ insert: [{ id: 'fixture-install', name: pathToFileURL(fixture).href }] }]))
  // No source checkout or build tool is the running Host's working directory.
  host = spawn(process.execPath, [cli, 'web', '--patch', fixturePatch, '--no-open', '--port', '0'], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(host, 'exit')
  host.stdout.on('data', data => { output += data })
  host.stderr.on('data', data => { output += data })
  let launch
  for (let attempt = 0; attempt < 150; attempt++) {
    launch = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
    if (launch || host.exitCode !== null) break
    await delay(200)
  }
  assert(launch, 'The installed plugin must start within 30 seconds')
  const origin = new URL(launch).origin
  const entry = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const cookie = entry.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const installation = await fetch(`${origin}/fixture-install`, { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(120000) })
  assert.equal(installation.status, 200)
  const applied = await installation.json()
  assert.equal(applied.application, 'applied', JSON.stringify(applied))
  for (const target of ['local', 'machine']) {
    const preset = applied.presets.find(row => row.id === `slop-queue-query-${target}`)
    assert(preset && !preset.broken, `Installed query preset must mount: ${JSON.stringify(preset)}`)
  }
  const profile = join(env.DSH_HOME, 'profiles/web')
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert(manifest.dsh.profile.bundles.includes('dsh-slop'))
  assert.equal(manifest.dependencies['is-number'], '7.0.0')
  const installed = join(profile, 'node_modules/dsh-slop')
  if (process.env.DSH_SLOP_SMOKE_NODE) {
    const receipt = run(process.env.DSH_SLOP_SMOKE_NODE, [join(root, 'scripts/native-ssh-runtime-smoke.mjs')], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_SLOP_SMOKE_PACKAGE: installed }, timeout: 30_000,
    })
    process.stdout.write(receipt)
  }
  const packaged = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(packaged.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.1-rc.3')
  assert(packaged.bundledDependencies.includes('ssh2'), 'Native SSH must be bundled without lifecycle build requirements')
  for (const name of packaged.bundledDependencies) {
    const component = JSON.parse(await readFile(join(installed, 'node_modules', name, 'package.json'), 'utf8'))
    assert.equal(component.dependencies, undefined, 'Private components must not request registry packages')
    assert.equal(component.scripts, undefined, 'Bundled dependencies must not request lifecycle scripts')
  }
  // Bare names resolve to native real paths that can miss the profile layer on
  // Windows, so every component is named by a path anchored beside the patch.
  const patchText = await readFile(join(installed, 'cordis.patch.yml'), 'utf8')
  const componentNames = [...patchText.matchAll(/^\s*name:\s*(\S+)\s*$/gmu)].map(match => match[1])
  assert.equal(componentNames.length, 5, 'The bundle patch names five components')
  for (const name of componentNames) {
    assert.match(name, /^\.\/node_modules\/@dsh-slop\/[a-z-]+\/[\w/.-]+\.js$/u, `Component ${name} must use an anchored relative path`)
    await readFile(join(installed, name))
  }
  assert.equal(packaged.engines.dsh, '0.2.1-rc.3')
  const sshPackage = JSON.parse(await readFile(join(installed, 'node_modules/ssh2/package.json'), 'utf8'))
  assert.equal(sshPackage.version, '1.17.0')
  assert.equal(sshPackage.optionalDependencies, undefined, 'The native SSH backend must run without C++ addons')
  // Run Node's actual ESM/CommonJS loader against the installed archive. Test
  // bundlers can otherwise hide named-export incompatibilities in SSH clients.
  run(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', pathToFileURL(join(installed, 'node_modules/@dsh-slop/execution/dist/index.js')).href])
  const bootstrap = await fetch(`${origin}/dsh-slop/browser-bootstrap`, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
  assert.equal(bootstrap.status, 200)
  const boot = await bootstrap.json()
  assert.equal(typeof boot.csrfNonce, 'string')
  for (const path of [boot.knowledgeSettingsBridgePath, boot.queueSettingsBridgePath]) {
    const response = await fetch(new URL(path, origin), { headers: { cookie, 'x-dsh-slop-csrf': boot.csrfNonce }, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200, path)
    await response.json()
  }
  // Exercises the real event upgrade, nonce protocol and Machine service.
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/dsh-slop/events`, `dsh-slop.v1.${boot.csrfNonce}`)
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ kind: 'subscribe', feedId: 'slop', asOfCursor: '0', snapshotToken: 'installation-smoke-unknown-snapshot' }))
        }, { once: true })
        socket.addEventListener('message', event => {
          try {
            assert.equal(JSON.parse(event.data).kind, 'resync-required')
            resolve()
          } catch (error) { reject(error) }
        }, { once: true })
        socket.addEventListener('error', () => reject(new Error('Machine event WebSocket failed')), { once: true })
      }),
      delay(5000, undefined, { ref: false }).then(() => { throw new Error('Machine event WebSocket timed out') }),
    ])
  } finally { socket.close() }
  const productHome = join(env.DSH_HOME, 'slop-plugin')
  assert((await readdir(join(productHome, 'slop'))).includes('authority'))
  host.kill('SIGTERM')
  await exited
  host = undefined
  run(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-slop'])
  const after = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert(!after.dsh.profile.bundles.includes('dsh-slop'))
  assert.equal(after.dependencies['is-number'], '7.0.0')
  assert((await readdir(join(productHome, 'slop'))).includes('authority'), 'Uninstall must retain user data')
  // Replacement must preserve the data of the previously installed version.
  run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', archive])
  const reinstalled = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert(reinstalled.dsh.profile.bundles.includes('dsh-slop'))
  assert.equal(reinstalled.dependencies['is-number'], '7.0.0')
  assert((await readdir(join(productHome, 'slop'))).includes('authority'))
  run(process.execPath, [cli, 'plugin', '--profile', 'web', 'remove', 'dsh-slop'])
  // A release filename must not silently acquire new bytes.
  await writeFile(archive, 'existing release sentinel')
  assert.throws(() => run(process.execPath, [join(root, 'scripts/pack-plugin.mjs'), '--no-build'], {
    env: { ...env, DSH_SLOP_PLUGIN_DIR: temporary },
  }), /do not overwrite a shared plugin archive/)
  assert.equal(await readFile(archive, 'utf8'), 'existing release sentinel')
  process.stdout.write('Plugin smoke passed: live install without restart, HTTP, Machine events, remove/reinstall with data preservation, and archive overwrite protection.\n')
} catch (error) {
  // Keep credentials and launch tokens out of CI output.
  const detail = output.replace(/([?&](?:token|auth)=)[^\s&]+/g, '$1[redacted]')
  process.stderr.write(detail)
  throw error
} finally {
  if (host && host.exitCode === null) { host.kill('SIGTERM'); await exited }
  await rm(temporary, { recursive: true, force: true })
}
