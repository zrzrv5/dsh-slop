import type {} from '@dsh-slop/runtime-base'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { KNOWLEDGE_SETTINGS_BRIDGE_PATH, serveKnowledgeSettingsBridge } from './settings-bridge.js'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  Config as ConfigSchema,
  SlopKnowledgeService,
  type Config as KnowledgeConfig,
} from './service.js'
import { registerKnowledgeTools } from './tools.js'

export * from './errors.js'
export * from './service.js'
export * from './tools.js'
export * from './markdown-table.js'
export type {
  KnowledgeReadInput,
  KnowledgeReadPage,
  KnowledgeReadResult,
  KnowledgeRebuildResult,
  KnowledgeScope,
  KnowledgeSearchHit,
  KnowledgeSearchInput,
  KnowledgeSearchResult,
  KnowledgeSectionReplacement,
  KnowledgeSettingsView,
  KnowledgeSettingsSourcesView,
  KnowledgeSourceStatus,
  KnowledgeWriteInput,
  KnowledgeWriteResult,
  UpdateKnowledgeHomeRootInput,
} from './types.js'

export const name = 'dsh-slop-knowledge'
export const inject = ['settings', 'workspaceRegistry', 'tools']
export const Config = ConfigSchema
export type Config = KnowledgeConfig

export async function apply(ctx: Context, config: KnowledgeConfig): Promise<void> {
  const service = new SlopKnowledgeService(ctx, config, ctx.fiber.entry?.options.id ?? name)
  ctx.inject(['slopRuntime', 'webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({ kind: 'exact', path: KNOWLEDGE_SETTINGS_BRIDGE_PATH, handler: (req, res) => { void serveKnowledgeSettingsBridge(req, res, scoped.slopRuntime.nonce, service, scoped.slopRuntime.trustedHosts) } }))
  })
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'dsh-slop-knowledge.settings')
  ctx.effect(
    () => registerKnowledgeTools(ctx, service),
    'dsh-slop-knowledge.tools',
  )
}
