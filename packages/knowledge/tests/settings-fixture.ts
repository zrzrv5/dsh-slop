import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import * as KnowledgePlugin from '../src/index.js'

class EmptyWorkspaceRegistry extends Service {
  constructor(ctx: Context) { super(ctx, 'workspaceRegistry') }
  list(): readonly [] { return [] }
  resolveByPath(): Promise<undefined> { return Promise.resolve(undefined) }
}

export class RecordingTools extends Service {
  readonly definitions = new Map<string, ToolDefinition>()
  readonly disposed: string[] = []
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(definition: ToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => { this.definitions.delete(definition.name); this.disposed.push(definition.name) }
  }
}

/** Exercise the published Loader, profile patch writer, and Config-derived Settings together. */
export async function knowledgeSettingsFixture(home: string, homeRoot: string) {
  const dir = join(home, 'profile')
  initProfile(dir, ['knowledge-test-bundle'])
  const bundle = join(dir, 'node_modules', 'knowledge-test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"knowledge-test"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'knowledge-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'slop-knowledge', name: 'cordis:knowledge', config: { homeRoot } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['knowledge-test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), async ctx => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    await ctx.plugin(EmptyWorkspaceRegistry)
    await ctx.plugin(RecordingTools)
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, knowledge: KnowledgePlugin })
  })
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'slop-knowledge')
  if (entry?.fiber === undefined) throw new Error('Knowledge profile entry did not activate')
  return { ctx, serviceFiber: entry.fiber, service: ctx.slopKnowledge, profile }
}
