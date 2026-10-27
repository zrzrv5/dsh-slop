import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile, copyFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import { promisify } from 'node:util'
import { isMap, isSeq, parseDocument } from 'yaml'

const execute = promisify(execFile)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
async function exists(path: string): Promise<boolean> {
  try { const info = await lstat(path); if (!info.isFile()) throw new Error(`Migration requires a regular file: ${path}`); return true }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** A running old Host has no new launcher lock. Its open databases are authoritative. */
async function requireStopped(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    const result = await execute('lsof', ['-t', '--', ...paths])
    if (result.stdout.trim()) throw new Error('Stop the existing DSH Host before migrating component configuration.')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return
    throw error
  }
}

/** Pure, conservative mapping. Unknown legacy customization is never overwritten. */
export function mapComponentOverrides(source: string, callbacksEnabled: boolean): string {
  const document = parseDocument(source)
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Component migration requires a valid profile override sequence.')
  const seen = new Set<string>()
  let hostDisabled = false
  for (const row of document.contents.items) {
    if (!isMap(row)) throw new Error('Component migration cannot map a non-object profile override.')
    const id = row.get('id')
    if (typeof id !== 'string') {
      // Insertion/removal trees can contain renamed or duplicate SLOP entries.
      if (/slop-host|slop-ui|@dsh-slop\/(?:plugin|ui)/u.test(String(row))) throw new Error('Custom SLOP composition needs explicit migration; original configuration was preserved.')
      continue
    }
    if (seen.has(id) && ['slop-host', 'slop-ui', 'slop-queue-callbacks'].includes(id)) throw new Error('Duplicate SLOP overrides cannot be mapped losslessly.')
    seen.add(id)
    if (id === 'slop-machine' || id === 'slop-runtime' || id === 'slop-queue' || id === 'slop-queue-callbacks') throw new Error('Mixed old and new SLOP component overrides require explicit migration.')
    if (id !== 'slop-host' && id !== 'slop-ui') continue
    if (row.items.some(pair => !['id', 'name', 'disabled', 'config'].includes(String(pair.key)))) throw new Error('Custom legacy SLOP lifecycle fields cannot be mapped losslessly.')
    const disabled = row.get('disabled')
    if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error('Dynamic legacy SLOP enablement requires explicit migration.')
    const name = row.get('name')
    if (name !== undefined && String(name) !== (id === 'slop-host' ? '@dsh-slop/plugin' : '@dsh-slop/ui')) throw new Error('Custom legacy SLOP plugin identity requires explicit migration.')
    const config = row.get('config', true)
    if (config !== undefined && (!isMap(config) || config.items.length > 0)) throw new Error('Custom legacy Host/UI configuration requires explicit migration; original configuration was preserved.')
    if (id === 'slop-ui' && disabled === true) throw new Error('The old UI was disabled independently of its backend. Choose capability enablement before migration; original configuration was preserved.')
    if (id === 'slop-host') hostDisabled = disabled === true
  }
  document.contents.items = document.contents.items.filter(row => !isMap(row) || !['slop-host', 'slop-ui'].includes(String(row.get('id'))))
  if (hostDisabled) {
    document.add({ id: 'slop-machine', disabled: true })
    document.add({ id: 'slop-queue', disabled: true })
  }
  document.add({ id: 'slop-queue-callbacks', disabled: !callbacksEnabled })
  return document.toString()
}

/** No business-data rewrite: IDs, ledger paths, Knowledge roots and old delivery remain intact. */
export async function migrateComponentConfiguration(input: { productHome: string; profileDir: string; assertStopped?: (paths: readonly string[]) => Promise<void> }): Promise<void> {
  const patchPath = join(input.profileDir, 'cordis.patch.yml')
  if (!await exists(patchPath)) return
  const migration = join(input.productHome, '.component-migration-v1')
  const receiptPath = join(migration, 'receipt.json')
  const source = await readFile(patchPath, 'utf8')
  // A prepared receipt survives a crash between atomic patch publication and commit.
  if (await exists(receiptPath)) {
    const receipt: unknown = JSON.parse(await readFile(receiptPath, 'utf8'))
    if (!object(receipt) || receipt.schema !== 1 || typeof receipt.before !== 'string' || typeof receipt.after !== 'string') throw new Error('Invalid component migration receipt; original files were preserved.')
    if (receipt.complete === true) return
    if (digest(source) === receipt.after) { await writeFile(receiptPath, JSON.stringify({ ...receipt, complete: true }) + '\n', { mode: 0o600 }); return }
    if (digest(source) !== receipt.before) throw new Error('Profile changed during component migration; use the saved originals to reconcile it.')
  } else {
    const ownershipPath = join(input.profileDir, 'node_modules', '@dsh-slop', '.dsh-slop-runtime-links.json')
    if (!await exists(ownershipPath)) return
    const ownership: unknown = JSON.parse(await readFile(ownershipPath, 'utf8'))
    if (!object(ownership) || !object(ownership.packages)) throw new Error('Cannot determine legacy component ownership.')
    if (ownership.packages.runtime === '@dsh-slop/runtime') return
  }
  const databasePaths = [join(input.productHome, 'slop', 'authority', 'authority.sqlite'), join(input.productHome, 'slop', 'queue', 'queue.sqlite'), join(input.productHome, 'slop', 'queue', 'webhook.sqlite')]
  const existingDatabases: string[] = []
  for (const path of databasePaths) if (await exists(path)) existingDatabases.push(path)
  await (input.assertStopped ?? requireStopped)(existingDatabases)
  const webhookPath = databasePaths[2]!
  let callbacksEnabled = false
  if (existingDatabases.includes(webhookPath)) {
    const database = new DatabaseSync(webhookPath, { readOnly: true })
    try {
      const row = database.prepare('SELECT body FROM settings WHERE id=1').get()
      if (!object(row) || typeof row.body !== 'string') throw new Error('Missing legacy callback settings; automatic migration stopped.')
      const settings: unknown = JSON.parse(row.body)
      if (!object(settings) || typeof settings.enabled !== 'boolean') throw new Error('Unknown legacy callback enablement; automatic migration stopped.')
      callbacksEnabled = settings.enabled
    } finally { database.close() }
  }
  const destination = mapComponentOverrides(source, callbacksEnabled)
  await mkdir(migration, { recursive: true, mode: 0o700 })
  const backup = join(migration, 'cordis.patch.yml.before')
  if (await exists(backup)) { if (await readFile(backup, 'utf8') !== source) throw new Error('Component migration original differs from the current profile.') }
  else await writeFile(backup, source, { flag: 'wx', mode: 0o600 })
  const manifest = join(input.profileDir, 'package.json')
  if (await exists(manifest) && !await exists(join(migration, 'package.json.before'))) { await copyFile(manifest, join(migration, 'package.json.before')); await chmod(join(migration, 'package.json.before'), 0o600) }
  if (existingDatabases.includes(webhookPath) && !await exists(join(migration, 'webhook.sqlite.before'))) {
    const database = new DatabaseSync(webhookPath, { readOnly: true })
    try { await sqliteBackup(database, join(migration, 'webhook.sqlite.before')); await chmod(join(migration, 'webhook.sqlite.before'), 0o600) } finally { database.close() }
  }
  const receipt = { schema: 1, before: digest(source), after: digest(destination), complete: false }
  await writeFile(receiptPath, JSON.stringify(receipt) + '\n', { mode: 0o600 })
  const temporary = `${patchPath}.${randomUUID()}.tmp`
  await writeFile(temporary, destination, { flag: 'wx', mode: 0o600 })
  if (await readFile(patchPath, 'utf8') !== source) throw new Error('Profile changed before component migration could commit.')
  await rename(temporary, patchPath)
  await writeFile(receiptPath, JSON.stringify({ ...receipt, complete: true }) + '\n', { mode: 0o600 })
}
