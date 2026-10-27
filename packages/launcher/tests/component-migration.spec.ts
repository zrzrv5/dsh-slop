import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { describe, it, expect, vi } from 'vitest'
import { parse } from 'yaml'
import { mapComponentOverrides, migrateComponentConfiguration } from '../src/component-migration.js'

async function fixture(enabled = true) {
  const productHome = await mkdtemp(join(tmpdir(), 'slop-components-migration-'))
  const profileDir = join(productHome, 'dsh/profiles/slop')
  await mkdir(join(profileDir, 'node_modules/@dsh-slop'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules/@dsh-slop/.dsh-slop-runtime-links.json'), JSON.stringify({ packages: { bundle: '@dsh-slop/bundle', plugin: '@dsh-slop/plugin', ui: '@dsh-slop/ui', knowledge: '@dsh-slop/knowledge' } }))
  const source = '# retain operator configuration\n- id: slop-knowledge\n  config:\n    homeRoot: /original/knowledge\n- id: custom-provider\n  disabled: true\n'
  const path = join(profileDir, 'cordis.patch.yml')
  await writeFile(path, source)
  await writeFile(join(profileDir, 'package.json'), '{"description":"operator"}')
  await mkdir(join(productHome, 'slop/queue'), { recursive: true })
  const database = new DatabaseSync(join(productHome, 'slop/queue/webhook.sqlite'))
  database.exec('PRAGMA journal_mode=WAL; CREATE TABLE settings (id INTEGER PRIMARY KEY, body TEXT)')
  database.prepare('INSERT INTO settings VALUES (1, ?)').run(JSON.stringify({ enabled, provider: 'external', publicOrigin: 'https://existing.example', tunnelToken: '' }))
  database.close()
  return { productHome, profileDir, source, path, assertStopped: vi.fn(async () => {}) }
}

describe('capability configuration migration', () => {
  it('preserves independent overrides and saved callback preference while mapping the old Host off', () => {
    const rows = parse(mapComponentOverrides('- id: slop-host\n  disabled: true\n- id: custom\n  config: { value: original }\n', true))
    expect(rows).toEqual([{ id: 'custom', config: { value: 'original' } }, { id: 'slop-machine', disabled: true }, { id: 'slop-queue', disabled: true }, { id: 'slop-queue-callbacks', disabled: false }])
  })
  it.each(['- id: slop-host\n  config: { dataRoot: /custom }\n', '- id: slop-ui\n  disabled: true\n', '- id: slop-queue\n  disabled: false\n'])('refuses ambiguous customization: %s', source => {
    expect(() => mapComponentOverrides(source, false)).toThrow(/migration|map|choose/i)
  })
  it.each([true, false])('backs up originals and inherits callback enablement %s, idempotently', async enabled => {
    const f = await fixture(enabled)
    await migrateComponentConfiguration(f)
    expect(f.assertStopped).toHaveBeenCalledOnce()
    const migrated = await readFile(f.path, 'utf8')
    expect(parse(migrated)).toContainEqual({ id: 'slop-queue-callbacks', disabled: !enabled })
    expect(parse(migrated)[0]).toEqual(parse(f.source)[0])
    const backup = join(f.productHome, '.component-migration-v1')
    expect(await readFile(join(backup, 'cordis.patch.yml.before'), 'utf8')).toBe(f.source)
    const saved = new DatabaseSync(join(backup, 'webhook.sqlite.before'), { readOnly: true })
    expect(JSON.parse(String(saved.prepare('SELECT body FROM settings').get()?.body)).enabled).toBe(enabled)
    saved.close()
    if (process.platform !== 'win32') expect((await stat(join(backup, 'webhook.sqlite.before'))).mode & 0o777).toBe(0o600)
    await migrateComponentConfiguration(f)
    expect(await readFile(f.path, 'utf8')).toBe(migrated)
    expect(f.assertStopped).toHaveBeenCalledOnce()
  })
  it('does not publish a patch if the existing Host is running', async () => {
    const f = await fixture()
    f.assertStopped.mockRejectedValueOnce(new Error('Stop Host'))
    await expect(migrateComponentConfiguration(f)).rejects.toThrow('Stop Host')
    expect(await readFile(f.path, 'utf8')).toBe(f.source)
  })
  it('recovers after atomic publication but before marking the migration complete', async () => {
    const f = await fixture()
    await migrateComponentConfiguration(f)
    const path = join(f.productHome, '.component-migration-v1/receipt.json')
    const receipt = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...receipt, complete: false }))
    await migrateComponentConfiguration(f)
    expect(JSON.parse(await readFile(path, 'utf8')).complete).toBe(true)
  })
})
