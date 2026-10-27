import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SettingsConflictError,
} from '@deepseek-ai/dsh-settings'
import { WorkspaceId, type Workspace } from '@deepseek-ai/dsh-workspace'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeError } from '../src/errors.js'
import { KnowledgeRepository } from '../src/repository.js'
import {
  accessibleKnowledgeSources,
  allKnowledgeSources,
  type KnowledgeWorkspaceLookup,
} from '../src/service.js'
import type { KnowledgeSource, KnowledgeSourceStatus } from '../src/types.js'
import { knowledgeSettingsFixture } from './settings-fixture.js'

function workspace(id: string, path: string, title: string): Workspace {
  return {
    id: WorkspaceId(id),
    path,
    title,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
    setTitle: () => Promise.resolve(),
    attachSession: () => Promise.resolve(),
    insertSessionBefore: () => Promise.resolve(),
    detachSession: () => Promise.resolve(),
    status: () => Promise.resolve('ok'),
  }
}

class TrackingWorkspaceLookup implements KnowledgeWorkspaceLookup {
  readonly requestedPaths: string[] = []

  constructor(private readonly workspaces: readonly Workspace[]) {}

  list(): readonly Workspace[] {
    return this.workspaces
  }

  resolveByPath(path: string): Promise<Workspace | undefined> {
    this.requestedPaths.push(path)
    return Promise.resolve(this.workspaces.find((candidate) => candidate.path === path))
  }
}

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-slop-knowledge-settings-'))
  const canonical = await realpath(created)
  temporaryRoots.push(canonical)
  return canonical
}

function sourceStatuses(sources: readonly KnowledgeSource[]): readonly KnowledgeSourceStatus[] {
  return sources.map((source) => {
    const common = {
      root: source.root,
      state: 'missing' as const,
      documentCount: 0,
    }
    return source.kind === 'home'
      ? { kind: 'home', ...common }
      : {
          kind: 'workspace',
          workspaceId: source.workspaceId,
          workspaceTitle: source.workspaceTitle,
          workspacePath: source.workspacePath,
          ...common,
        }
  })
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('SlopKnowledgeService settings', () => {
  it('uses the normalized composition base as default and unsets matching overrides', async () => {
    const baseParent = await temporaryRoot()
    const customBase = join(baseParent, 'custom-default', '..', 'custom-default')
    const alternate = join(baseParent, 'alternate')
    const { ctx, serviceFiber, service } = await knowledgeSettingsFixture(await temporaryRoot(), customBase)

    expect(service.getSettingsView()).toMatchObject({
      revision: 0,
      homeRoot: join(baseParent, 'custom-default'),
      defaultHomeRoot: join(baseParent, 'custom-default'),
      overridden: false,
    })
    const overridden = await service.updateHomeRoot({
      homeRoot: alternate,
      expectedRevision: 0,
    })
    expect(overridden).toMatchObject({ revision: 1, homeRoot: alternate, overridden: true })

    const reset = await service.updateHomeRoot({
      homeRoot: join(baseParent, 'custom-default'),
      expectedRevision: 1,
    })
    expect(reset).toMatchObject({
      revision: 2,
      homeRoot: join(baseParent, 'custom-default'),
      defaultHomeRoot: join(baseParent, 'custom-default'),
      overridden: false,
    })
    await serviceFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects invalid roots and preserves native settings revision conflicts', async () => {
    const base = await temporaryRoot()
    const { ctx, serviceFiber, service } = await knowledgeSettingsFixture(await temporaryRoot(), base)

    await expect(
      service.updateHomeRoot({ homeRoot: 'relative/knowledge', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_ARGUMENT' })
    await expect(
      service.updateHomeRoot({ homeRoot: '/', expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(KnowledgeError)

    await expect(ctx.settings.update('slop-knowledge', {
      homeRoot: 'relative/knowledge',
    }, 0)).rejects.toThrow()
    expect(service.getSettingsView()).toMatchObject({ revision: 0, homeRoot: base })

    await service.updateHomeRoot({ homeRoot: join(base, 'new'), expectedRevision: 0 })
    await expect(
      service.updateHomeRoot({ homeRoot: join(base, 'stale'), expectedRevision: 0 }),
    ).rejects.toBeInstanceOf(SettingsConflictError)
    await serviceFiber.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps settings and source status from one snapshot during concurrent changes', async () => {
    const base = await temporaryRoot()
    const alternate = join(base, 'alternate')
    const third = join(base, 'third')
    const { ctx, serviceFiber, service } = await knowledgeSettingsFixture(await temporaryRoot(), base)
    const repository = Reflect.get(service, 'repository') as KnowledgeRepository

    vi.spyOn(repository, 'listSources').mockImplementationOnce(async (sources) => {
      await service.updateHomeRoot({ homeRoot: alternate, expectedRevision: 0 })
      return sourceStatuses(sources)
    })
    const listed = await service.getSettingsSourcesView()
    expect(listed).toMatchObject({ revision: 0, homeRoot: base })
    expect(listed.sources).toEqual([
      expect.objectContaining({ kind: 'home', root: base }),
    ])

    vi.spyOn(repository, 'rebuild').mockImplementationOnce(async (sources) => {
      await service.updateHomeRoot({ homeRoot: third, expectedRevision: 1 })
      return { schemaVersion: 1, indexedDocuments: 0, sources: sourceStatuses(sources) }
    })
    const rebuilt = await service.rebuildSettingsSourcesView()
    expect(rebuilt).toMatchObject({ revision: 1, homeRoot: alternate })
    expect(rebuilt.sources).toEqual([
      expect.objectContaining({ kind: 'home', root: alternate }),
    ])
    expect(service.getSettingsView()).toMatchObject({ revision: 2, homeRoot: third })

    await serviceFiber.dispose()
    await ctx.fiber.dispose()
  })
})

describe('Workspace knowledge source resolution', () => {
  it('uses only Home and the Workspace resolved from the exact session cwd', async () => {
    const base = await temporaryRoot()
    const currentPath = join(base, 'current')
    const otherPath = join(base, 'other')
    const lookup = new TrackingWorkspaceLookup([
      workspace('current-id', currentPath, 'Current'),
      workspace('other-id', otherPath, 'Other'),
    ])

    const accessible = await accessibleKnowledgeSources(join(base, 'home'), currentPath, lookup)
    expect(lookup.requestedPaths).toEqual([currentPath])
    expect(accessible.map((source) => source.kind)).toEqual(['home', 'workspace'])
    expect(accessible[1]?.root).toBe(join(currentPath, '.dsh', 'knowledge'))
    expect(accessible.some((source) => source.root.startsWith(otherPath))).toBe(false)

    const all = allKnowledgeSources(join(base, 'home'), lookup)
    expect(all).toHaveLength(3)
  })

  it('keeps Home available when cwd is absent or not a registered Workspace', async () => {
    const base = await temporaryRoot()
    const lookup = new TrackingWorkspaceLookup([])

    expect(await accessibleKnowledgeSources(join(base, 'home'), undefined, lookup)).toHaveLength(1)
    expect(await accessibleKnowledgeSources(join(base, 'home'), join(base, 'unknown'), lookup))
      .toHaveLength(1)
  })
})
