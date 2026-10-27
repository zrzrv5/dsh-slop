import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it, onTestFinished } from 'vitest'
import { prepareLegacyKnowledgeSettings } from '../src/legacy-settings.js'

async function fixture(original: string) {
  const home = await mkdtemp(join(tmpdir(), 'slop-settings-migration-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'settings.yaml')
  await writeFile(path, original)
  return { home, path }
}

it('preserves the original settings and maps Knowledge once for upstream import', async () => {
  const original = '# user settings\nagent-default-model:\n  model: keep\ndsh-slop-knowledge:\n  homeRoot: /tmp/my-knowledge\n'
  const { home, path } = await fixture(original)
  await prepareLegacyKnowledgeSettings(home)
  expect(await readFile(`${path}.before-dsh-017`, 'utf8')).toBe(original)
  const prepared = await readFile(path, 'utf8')
  expect(parse(prepared)).toEqual({ 'agent-default-model': { model: 'keep' }, 'slop-knowledge': { homeRoot: '/tmp/my-knowledge' } })
  await prepareLegacyKnowledgeSettings(home)
  expect(await readFile(path, 'utf8')).toBe(prepared)
})

it.each([
  'dsh-slop-knowledge: [broken]',
  'dsh-slop-knowledge:\n  homeRoot: relative',
  'dsh-slop-knowledge:\n  homeRoot: /tmp/a\nslop-knowledge:\n  homeRoot: /tmp/b',
])('refuses invalid or conflicting input without changing it: %s', async original => {
  const { home, path } = await fixture(original)
  await expect(prepareLegacyKnowledgeSettings(home)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('resumes after publishing the backup and refuses a mismatched backup', async () => {
  const original = 'dsh-slop-knowledge:\n  homeRoot: /tmp/knowledge\n'
  const { home, path } = await fixture(original)
  await writeFile(`${path}.before-dsh-017`, 'different original')
  await expect(prepareLegacyKnowledgeSettings(home)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(original)
  await writeFile(`${path}.before-dsh-017`, original)
  await prepareLegacyKnowledgeSettings(home)
  expect(parse(await readFile(path, 'utf8'))).toEqual({ 'slop-knowledge': { homeRoot: '/tmp/knowledge' } })
})
