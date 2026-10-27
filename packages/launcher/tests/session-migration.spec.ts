import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyAgentPresets } from '../src/legacy-preset-migration.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(compression: 'none' | 'zstd' = 'none', preset = 'slop-pro') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-slop-v3-migration-'))
  roots.push(root)
  const directory = join(root, 'sessions', '--work--', 'session-example')
  await mkdir(directory, { recursive: true })
  const rows = [
    { type: 'session', version: 2, id: 'session-example', createdAt: 1, cwd: '/work', isSeeded: false, delegationDepth: 0, agentPreset: preset },
    { type: 'agent-preset/selected', seq: 0, time: 2, data: { agentPreset: preset } },
  ]
  const chunks = rows.map(row => `${JSON.stringify(row)}\n`)
  const original = compression === 'none' ? Buffer.from(chunks.join('')) : Buffer.concat(chunks.map(chunk => zstdCompressSync(chunk, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })))
  const source = join(directory, `session.jsonl${compression === 'zstd' ? '.zstd' : ''}`)
  await writeFile(source, original)
  return { root, directory, source, original, compression }
}

async function openStore(root: string, compression: 'none' | 'zstd') {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression })
  return ctx
}

async function readEvents(root: string, compression: 'none' | 'zstd'): Promise<readonly SessionEvent[]> {
  const ctx = await openStore(root, compression)
  try {
    const handle = await ctx.sessionPersistence.open(SessionId('session-example'), 'read')
    try { return (await handle.read()).events } finally { await handle.close() }
  } finally { await ctx.fiber.dispose() }
}

describe('released session migration', () => {
  it.each(['none', 'zstd'] as const)('preserves %s V2 bytes, publishes the alpha.1 V4 successor, and reopens after restart', async compression => {
    const f = await fixture(compression)
    await mkdir(join(f.root, '.agent-presets', 'slop-pro'), { recursive: true })
    expect(await migrateLegacyAgentPresets(f.root, () => 3)).toBe(1)
    expect(await readFile(f.source)).toEqual(f.original)
    expect(await readFile(join(f.directory, `session.v2.jsonl${compression === 'zstd' ? '.zstd' : ''}`))).toEqual(f.original)
    expect((await readEvents(f.root, compression)).at(-1)).toMatchObject({ type: 'agent-preset/selected', seq: 1, data: { agentPreset: 'standard' } })
    const current = join(f.directory, `session.v4.jsonl${compression === 'zstd' ? '.zstd' : ''}`)
    const bytes = await readFile(current)
    expect(await migrateLegacyAgentPresets(f.root)).toBe(0)
    expect(await readFile(current)).toEqual(bytes)
    expect(await readdir(join(f.root, '.agent-presets'))).toEqual([])
  })

  it('normalizes old filenames even when the earlier preset migration marker already exists', async () => {
    const f = await fixture('none', 'code')
    await writeFile(join(f.root, '.dsh-slop-standard-preset-migration.json'), JSON.stringify({ schema: 1, effectivePreset: 'standard' }))
    expect(await migrateLegacyAgentPresets(f.root)).toBe(0)
    expect(await readFile(f.source)).toEqual(f.original)
    expect((await readEvents(f.root, 'none'))[0]).toMatchObject({ data: { agentPreset: 'ptc' } })
  })

  it('preserves a missing final newline in the original and repairs only its canonical copy', async () => {
    const f = await fixture()
    const original = f.original.subarray(0, -1)
    await writeFile(f.source, original)
    expect(await migrateLegacyAgentPresets(f.root)).toBe(1)
    expect(await readFile(f.source)).toEqual(original)
    expect((await readEvents(f.root, 'none'))).toHaveLength(2)
  })

  it('does not reinterpret canonical V0 histories when preset migration already completed', async () => {
    const f = await fixture()
    const original = f.original.toString().replace('"version":2', '"version":0').replace(',"isSeeded":false', '')
    await writeFile(f.source, original)
    await writeFile(join(f.root, '.dsh-slop-standard-preset-migration.json'), JSON.stringify({ schema: 1, effectivePreset: 'standard' }))
    expect(await migrateLegacyAgentPresets(f.root)).toBe(0)
    expect(await readFile(f.source, 'utf8')).toBe(original)
    expect(await readdir(f.directory)).toEqual(['session.jsonl'])
  })

  it('refuses a corrupt later log before publishing any aliases or preset changes', async () => {
    const f = await fixture()
    const bad = join(f.root, 'sessions', '--work--', 'session-bad')
    await mkdir(bad)
    await writeFile(join(bad, 'session.jsonl'), '{broken\n')
    await expect(migrateLegacyAgentPresets(f.root)).rejects.toThrow()
    expect(await readFile(f.source)).toEqual(f.original)
    await expect(stat(join(f.directory, 'session.v2.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(f.root, '.dsh-slop-standard-preset-migration.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('respects a live writer lock and retries safely after the owner stops', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, 'session.v2.jsonl'), f.original)
    const ctx = await openStore(f.root, 'none')
    const held = await ctx.sessionPersistence.open(SessionId('session-example'), 'write')
    try {
      await expect(migrateLegacyAgentPresets(f.root)).rejects.toThrow(/own|lock/i)
      expect((await held.read()).events).toHaveLength(1)
    } finally {
      await held.close()
      await ctx.fiber.dispose()
    }
    expect(await migrateLegacyAgentPresets(f.root)).toBe(1)
    expect(await readFile(f.source)).toEqual(f.original)
  })
})
