import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

/** Only the bundled contribution is scoped; upstream project/user providers remain intact. */
export function registerCapabilitySkills(ctx: Context, capability: 'machine' | 'queue', directory = process.env.DSH_SLOP_SKILL_DIR): void {
  const root = directory ?? join(dirname(fileURLToPath(import.meta.resolve('@dsh-slop/plugin/package.json'))), 'lib', 'skills')
  const names = new Set(capability === 'machine' ? ['onboard-slop', 'deep-discover', 'machine-onboarding', 'machine-discovery', 'project-work'] : ['queue-tracking', 'project-work'])
  const select = (candidates: readonly SkillCandidate[]) => candidates.filter(candidate => names.has(candidate.name)).map(candidate => ({ ...candidate, rank: BUNDLED_SKILL_RANK, source: 'bundled' }))
  ctx.effect(() => {
    let filesystem: FileSystemSkillProvider | undefined
    const unregister = ctx.skills.registerProvider(control => {
      const provider = new FileSystemSkillProvider(ctx, control, { providerName: `slop-${capability}`, includeDefaultRoots: false, customSkillDirs: [root], watch: false })
      filesystem = provider
      return {
        name: provider.name,
        async list(options) {
          const result = await provider.list(options)
          if (Array.isArray(result)) return select(result)
          return { ...result, candidates: select(result.candidates) }
        },
        async get(candidate, options) {
          const definition = await provider.get(candidate, options)
          return definition === undefined ? undefined : { ...definition, source: 'bundled' }
        },
      }
    })
    return async () => { unregister(); await filesystem?.dispose() }
  })
}
