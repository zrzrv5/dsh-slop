#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temporary = await mkdtemp(join(tmpdir(), 'slop launcher smoke '))
try {
  // Test-only endpoint reads the exact release's public plugin inventory API.
  const fixture = join(temporary, 'inventory.mjs')
  await writeFile(fixture, `
import { verifyNativeRuntime } from ${JSON.stringify(new URL('./fixtures/native-runtime.mjs', import.meta.url).href)}
export const inject = ['pluginInventory', 'webServer', 'workspaceRegistry', 'agents', 'agentPresets', 'worktrees', 'workingDirectory', 'tools', 'slopKnowledge', 'ptcRuntime', 'llm', 'subagents']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture-inventory', handler: async (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(await ctx.pluginInventory.list()))
  } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/fixture-native', handler: async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    try { res.end(JSON.stringify(await verifyNativeRuntime(ctx, ${JSON.stringify(join(temporary, 'repository'))}))) }
    catch (error) { res.writeHead(500); res.end(String(error.stack)) }
  } }))
}
`)
  const patch = join(temporary, 'inventory.yml')
  await writeFile(patch, JSON.stringify([
    { id: 'ptc-runtime', config: { executionMode: 'persistent-in-memory' } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
    { id: 'approval', config: { policy: 'never' } },
    { insert: [{ id: 'fixture-inventory', name: pathToFileURL(fixture).href }] },
  ]))
  {
    const composition = 'core'
    const home = join(temporary, composition)
    const cli = fileURLToPath(new URL('../packages/launcher/dist/bin.js', import.meta.url))
    const host = spawn(process.execPath, [cli, '--home', home, '--patch', patch, '--no-open', '--port', '0'], {
      cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(host, 'exit')
    let output = ''
    host.stdout.on('data', data => { output += data })
    host.stderr.on('data', data => { output += data })
    try {
      let launch
      for (let attempt = 0; attempt < 150; attempt++) {
        launch = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]
        if (launch || host.exitCode !== null) break
        await delay(200)
      }
      assert(launch, `${composition} Host must start within 30 seconds`)
      const manifest = JSON.parse(await readFile(join(home, 'dsh', 'profiles', 'slop', 'package.json'), 'utf8'))
      assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-slop/bundle', '@dsh-slop/web-runtime'])
      const origin = new URL(launch).origin
      const entry = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const cookie = entry.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      const getResponse = async (path, nonce) => {
        const response = await fetch(new URL(path, origin), { headers: { cookie, ...(nonce ? { 'x-dsh-slop-csrf': nonce } : {}) }, signal: AbortSignal.timeout(5000) })
        assert.equal(response.status, 200, `${composition}: ${path}`)
        return response
      }
      const get = async (path, nonce) => (await getResponse(path, nonce)).json()
      // Active Host fibers do not prove that their browser files were shipped.
      // Read the exact release's client boot catalog, then fetch each asset.
      const html = await (await getResponse('/')).text()
      const catalog = html.match(/globalThis\["__DSH_BOOT__"\] = (.*?)<\/script>/s)
      assert(catalog, `${composition}: client boot catalog is missing`)
      const clientBoot = JSON.parse(catalog[1].replace(/;\s*$/, ''))
      for (const name of ['runtime', 'machine', 'knowledge', 'queue-plugin']) {
        const id = `@dsh-slop/${name}`
        const client = clientBoot.entries.find(entry => entry.id === id)
        assert(client, `${composition}: ${id} is missing from the browser catalog`)
        const response = await getResponse(client.url)
        assert.match(response.headers.get('content-type') ?? '', /javascript/, `${composition}: ${id} content type`)
        assert((await response.text()).includes('__ModuleLoader__.load('), `${composition}: ${id} must serve a client factory`)
      }
      const boot = await get('/dsh-slop/browser-bootstrap')
      assert.equal(typeof boot.csrfNonce, 'string')
      for (const path of [boot.knowledgeSettingsBridgePath, boot.queueSettingsBridgePath]) await get(path, boot.csrfNonce)
      const inventory = await get('/fixture-inventory')
      for (const name of ['runtime', 'machine', 'knowledge', 'queue-plugin']) {
        const entry = inventory.entries.find(entry => entry.moduleName === `@dsh-slop/${name}`)
        assert(entry?.enabled && entry.fiberPhase === 'active', `${composition}: ${name} must activate: ${JSON.stringify(entry)}`)
      }
      for (const moduleName of ['@deepseek-ai/dsh-experimental-worktree', '@deepseek-ai/dsh-experimental-tool-worktree', '@deepseek-ai/dsh-plugin-market']) {
        assert(inventory.entries.some(entry => entry.moduleName === moduleName && entry.fiberPhase === 'active'), `${composition}: ${moduleName} must activate`)
      }
      if (composition === 'core') {
        const native = await fetch(new URL('/fixture-native', origin), { method: 'POST', headers: { cookie }, signal: AbortSignal.timeout(30000) })
        const receipt = await native.text()
        assert.equal(native.status, 200, receipt)
        console.log(`Native runtime: ${receipt}`)
      }
      console.log(`${composition} launcher passed: fresh home, profile, browser client assets, bootstrap, Knowledge/Queue settings and active plugin inventory.`)
    } catch (error) {
      process.stderr.write(output.replace(/([?&](?:token|auth)=)[^\s&]+/g, '$1[redacted]'))
      throw error
    } finally {
      if (host.exitCode === null) {
        // Windows SIGTERM cannot run the wrapper's signal-forwarding handler.
        // Stop only this smoke-test process tree before removing its home.
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(host.pid), '/t', '/f'], { stdio: 'ignore' })
        else host.kill('SIGTERM')
      }
      await exited
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
