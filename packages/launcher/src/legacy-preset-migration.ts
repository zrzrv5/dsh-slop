import { prepareLegacySessionFilenames } from './legacy-session-files.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, rename, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LEGACY_PRESETS = new Set(['slop-chore', 'slop-pro'])
const STANDARD_PRESET = 'standard'
const MIGRATION_MARKER = '.dsh-slop-standard-preset-migration.json'

async function markerComplete(path: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return value !== null && typeof value === 'object' && 'schema' in value
      && value.schema === 1 && 'effectivePreset' in value && value.effectivePreset === STANDARD_PRESET
  } catch {
    return false
  }
}

/** Count physical Session directories so persistence cannot silently omit an unreadable header. */
async function sessionInventory(root: string): Promise<{ count: number; compression: 'none' | 'zstd' }> {
  let count = 0
  const encodings = new Set<'none' | 'zstd'>()
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    let hasLog = false
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(path, entry.name))
      if (!entry.isFile()) continue
      const compressed = entry.name.endsWith('.zstd')
      const name = compressed ? entry.name.slice(0, -5) : entry.name
      if (parseSessionFormatLogFilename(name) === undefined) continue
      hasLog = true
      encodings.add(compressed ? 'zstd' : 'none')
    }
    if (hasLog) count += 1
  }
  await visit(root)
  if (encodings.size > 1) throw new Error('legacy preset migration refuses mixed session log encodings')
  return { count, compression: encodings.has('none') ? 'none' : 'zstd' }
}

async function presetState(handle: SessionHandle): Promise<{ preset: string | undefined; nextSeq: number }> {
  const { events } = await handle.read()
  let preset = handle.header.agentPreset
  for (const event of events) {
    if (event.type === 'agent-preset/selected' && 'agentPreset' in event.data && typeof event.data.agentPreset === 'string') {
      preset = event.data.agentPreset
    }
  }
  return { preset, nextSeq: events.length }
}

async function migrateSessions(root: string, now: () => number): Promise<number> {
  const inventory = await sessionInventory(root)
  if (inventory.count === 0) return 0
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: inventory.compression })
  try {
    const persistence = ctx.sessionPersistence
    const sessions = await persistence.list()
    if (sessions.length !== inventory.count) throw new Error('legacy preset migration could not validate every session header')
    const candidates = []
    // Read handles validate and prepare old generations without publishing or taking write ownership.
    for (const { header } of sessions) {
      const handle = await persistence.open(header.id, 'read')
      try {
        const state = await presetState(handle)
        if (state.preset !== undefined && LEGACY_PRESETS.has(state.preset)) candidates.push(header.id)
      } finally {
        await handle.close()
      }
    }
    let migrated = 0
    for (const id of candidates) {
      // Upstream owns the cross-process lock, immutable successor publication, encoding, and flush.
      const handle = await persistence.open(id, 'write')
      try {
        const state = await presetState(handle)
        if (state.preset === undefined || !LEGACY_PRESETS.has(state.preset)) continue
        const event = { type: 'agent-preset/selected', seq: SessionSeq(state.nextSeq), time: now(), data: { agentPreset: STANDARD_PRESET } } satisfies SessionEvent
        await handle.append([event])
        await handle.flush()
        migrated += 1
      } finally {
        await handle.close()
      }
    }
    return migrated
  } finally {
    await ctx.fiber.dispose()
  }
}

async function retireLegacyPresetDirectories(dshHome: string): Promise<void> {
  const sourceRoot = join(dshHome, '.agent-presets')
  const retiredRoot = join(dshHome, '.retired-dsh-slop-agent-presets')
  for (const preset of LEGACY_PRESETS) {
    const source = join(sourceRoot, preset)
    try {
      const entry = await lstat(source)
      if (!entry.isDirectory()) throw new Error(`legacy preset path is not a directory: ${source}`)
      await mkdir(retiredRoot, { recursive: true, mode: 0o700 })
      await rename(source, join(retiredRoot, `${preset}-${randomUUID()}`))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
}

/** Append a Standard selection through DSH's current persistence API, preserving historical generations. */
export async function migrateLegacyAgentPresets(dshHome: string, now: () => number = Date.now): Promise<number> {
  await prepareLegacySessionFilenames(join(dshHome, 'sessions'))
  const marker = join(dshHome, MIGRATION_MARKER)
  let migrated = 0
  if (!(await markerComplete(marker))) {
    migrated = await migrateSessions(join(dshHome, 'sessions'), now)
    const temporaryMarker = `${marker}.${randomUUID()}.tmp`
    await writeFile(temporaryMarker, `${JSON.stringify({ schema: 1, effectivePreset: STANDARD_PRESET })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryMarker, marker)
  }
  await retireLegacyPresetDirectories(dshHome)
  return migrated
}
