import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  type SettingsDescriptor,
} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { KnowledgeError, errorCode } from './errors.js'
import { normalizeAbsoluteRoot } from './fs-safety.js'
import { KnowledgeRepository } from './repository.js'
import { createHomeSource, createWorkspaceSource } from './source.js'
import {
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeReadInput,
  type KnowledgeReadResult,
  type KnowledgeRebuildResult,
  type KnowledgeSearchInput,
  type KnowledgeSearchResult,
  type KnowledgeSettingsView,
  type KnowledgeSettingsSourcesView,
  type KnowledgeSource,
  type KnowledgeSourceStatus,
  type KnowledgeWriteInput,
  type KnowledgeWriteResult,
  type UpdateKnowledgeHomeRootInput,
} from './types.js'

export const KNOWLEDGE_SETTINGS_NAMESPACE = 'dsh-slop-knowledge'
const SETTINGS_NAMESPACE = KNOWLEDGE_SETTINGS_NAMESPACE
export const DEFAULT_KNOWLEDGE_HOME_ROOT = join(homedir(), '.slop', 'knowledge')

export interface Config {
  readonly homeRoot: Volatile<string>
}

export interface KnowledgeWorkspaceLookup {
  list(): readonly Workspace[]
  resolveByPath(path: string): Promise<Workspace | undefined>
}

export const Config = z.object({
  homeRoot: z.transform(z.string(), normalizeAbsoluteRoot).default(DEFAULT_KNOWLEDGE_HOME_ROOT).volatile(),
})

function descriptorUserOverridesHomeRoot(descriptor: SettingsDescriptor): boolean {
  if (typeof descriptor.user !== 'object' || descriptor.user === null) return false
  return Object.prototype.hasOwnProperty.call(descriptor.user, 'homeRoot')
}

function validateExpectedRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new KnowledgeError(
      'KNOWLEDGE_INVALID_ARGUMENT',
      'expectedRevision must be a non-negative safe integer.',
    )
  }
}

function sourceForWorkspace(workspace: Workspace): KnowledgeSource {
  return createWorkspaceSource({
    workspaceId: workspace.id,
    workspaceTitle: workspace.title,
    workspacePath: workspace.path,
  })
}

export function allKnowledgeSources(
  homeRoot: string,
  workspaceLookup: KnowledgeWorkspaceLookup,
): readonly KnowledgeSource[] {
  return [
    createHomeSource(homeRoot),
    ...workspaceLookup.list().map((workspace) => sourceForWorkspace(workspace)),
  ]
}

export async function accessibleKnowledgeSources(
  homeRoot: string,
  cwd: string | undefined,
  workspaceLookup: KnowledgeWorkspaceLookup,
): Promise<readonly KnowledgeSource[]> {
  const home = createHomeSource(homeRoot)
  const workspace = await resolveCurrentKnowledgeWorkspace(cwd, workspaceLookup)
  return workspace === undefined ? [home] : [home, sourceForWorkspace(workspace)]
}

export async function resolveCurrentKnowledgeWorkspace(
  cwd: string | undefined,
  workspaceLookup: KnowledgeWorkspaceLookup,
): Promise<Workspace | undefined> {
  if (cwd === undefined) return undefined
  try {
    return await workspaceLookup.resolveByPath(cwd)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slopKnowledge: SlopKnowledgeService
  }
}

export class SlopKnowledgeService extends Service {
  static inject = ['settings', 'workspaceRegistry']

  private readonly repository: KnowledgeRepository
  private readonly defaultHomeRoot: string

  constructor(ctx: Context, private readonly config: Config, private readonly settingsNamespace = SETTINGS_NAMESPACE) {
    super(ctx, 'slopKnowledge')
    const baseRoot = normalizeAbsoluteRoot(config.homeRoot.get())
    this.defaultHomeRoot = baseRoot
    this.repository = new KnowledgeRepository()
    ctx.effect(() => () => this.repository.close(), 'slopKnowledge.close')
  }

  getSettingsView(): KnowledgeSettingsView {
    const descriptor = this.descriptor()
    return {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      namespace: KNOWLEDGE_SETTINGS_NAMESPACE,
      revision: descriptor.revision,
      homeRoot: this.homeRoot(),
      defaultHomeRoot: this.baseHomeRoot(descriptor),
      overridden: descriptorUserOverridesHomeRoot(descriptor),
    }
  }

  async updateHomeRoot(input: UpdateKnowledgeHomeRootInput): Promise<KnowledgeSettingsView> {
    validateExpectedRevision(input.expectedRevision)
    const homeRoot = normalizeAbsoluteRoot(input.homeRoot)
    if (homeRoot === this.baseHomeRoot(this.descriptor())) {
      await this.ctx.settings.mutate(
        this.settingsNamespace,
        [{ op: 'unset', path: ['homeRoot'] }],
        input.expectedRevision,
      )
    } else {
      await this.ctx.settings.update(
        this.settingsNamespace,
        { homeRoot },
        input.expectedRevision,
      )
    }
    return this.getSettingsView()
  }

  async listSources(): Promise<readonly KnowledgeSourceStatus[]> {
    return this.repository.listSources(this.allSources())
  }

  async getSettingsSourcesView(): Promise<KnowledgeSettingsSourcesView> {
    const view = this.getSettingsView()
    const sources = allKnowledgeSources(view.homeRoot, this.ctx.workspaceRegistry)
    return {
      ...view,
      sources: await this.repository.listSources(sources),
    }
  }

  async rebuild(): Promise<KnowledgeRebuildResult> {
    return this.repository.rebuild(this.allSources())
  }

  async rebuildSettingsSourcesView(): Promise<KnowledgeSettingsSourcesView> {
    const view = this.getSettingsView()
    const sources = allKnowledgeSources(view.homeRoot, this.ctx.workspaceRegistry)
    const rebuilt = await this.repository.rebuild(sources)
    return { ...view, sources: rebuilt.sources }
  }

  async search(
    input: KnowledgeSearchInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<KnowledgeSearchResult> {
    return this.repository.search(input, await this.accessibleSources(agent), signal)
  }

  async read(
    input: KnowledgeReadInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<KnowledgeReadResult> {
    return this.repository.read(input, await this.accessibleSources(agent), signal)
  }

  async write(
    input: KnowledgeWriteInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<KnowledgeWriteResult> {
    const source =
      input.scope === 'home' ? this.homeSource() : await this.currentWorkspaceSource(agent)
    if (source === undefined) {
      throw new KnowledgeError(
        'KNOWLEDGE_WORKSPACE_REQUIRED',
        'Workspace knowledge requires a registered Workspace resolved from this agent session cwd.',
      )
    }
    return this.repository.write(input, source, signal)
  }

  private descriptor(): SettingsDescriptor {
    const descriptor = this.ctx.settings
      .describe({ redactSecrets: true })
      .find((candidate) => candidate.ns === this.settingsNamespace)
    if (descriptor === undefined) {
      throw new KnowledgeError(
        'KNOWLEDGE_NOT_FOUND',
        `Settings namespace ${KNOWLEDGE_SETTINGS_NAMESPACE} is not registered.`,
      )
    }
    return descriptor
  }

  private homeSource(): KnowledgeSource {
    return createHomeSource(this.homeRoot())
  }

  private allSources(): readonly KnowledgeSource[] {
    return allKnowledgeSources(this.homeRoot(), this.ctx.workspaceRegistry)
  }

  private async accessibleSources(agent: Agent): Promise<readonly KnowledgeSource[]> {
    return accessibleKnowledgeSources(
      this.homeRoot(),
      agent.session.header.cwd,
      this.ctx.workspaceRegistry,
    )
  }

  private homeRoot(): string {
    return normalizeAbsoluteRoot(this.config.homeRoot.get())
  }

  private baseHomeRoot(descriptor: SettingsDescriptor): string {
    const base = descriptor.base
    return typeof base === 'object' && base !== null && 'homeRoot' in base && typeof base.homeRoot === 'string'
      ? normalizeAbsoluteRoot(base.homeRoot)
      : this.defaultHomeRoot
  }

  private async currentWorkspaceSource(agent: Agent): Promise<KnowledgeSource | undefined> {
    const workspace = await resolveCurrentKnowledgeWorkspace(
      agent.session.header.cwd,
      this.ctx.workspaceRegistry,
    )
    return workspace === undefined ? undefined : sourceForWorkspace(workspace)
  }
}
