import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { describe, expect, it, onTestFinished } from 'vitest'
import { registerCapabilitySkills } from '../src/capability-skills.ts'

describe('capability-owned bundled Skills', () => {
  it('removes only the disabled capability catalog and retains shared and operator Skills', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    ctx.skills.register({ name: 'operator-skill', description: 'Operator instructions', content: 'Operator content', source: 'runtime' })
    const root = fileURLToPath(new URL('../../../skills/', import.meta.url))
    const machine = ctx.plugin({ name: 'machine-fixture', inject: ['skills'], apply: (child: Context) => registerCapabilitySkills(child, 'machine', root) })
    const queue = ctx.plugin({ name: 'queue-fixture', inject: ['skills'], apply: (child: Context) => registerCapabilitySkills(child, 'queue', root) })
    await Promise.all([machine, queue])
    const names = async () => (await ctx.skills.list()).map(skill => skill.name).sort()
    expect(await names()).toEqual(['deep-discover', 'machine-discovery', 'machine-onboarding', 'onboard-slop', 'operator-skill', 'project-work', 'queue-tracking'])
    expect((await ctx.skills.get('machine-discovery'))?.resourceBase).toEqual({ kind: 'directory', path: root + 'machine-discovery' })
    await machine.dispose()
    expect(await names()).toEqual(['operator-skill', 'project-work', 'queue-tracking'])
    expect(await ctx.skills.get('machine-discovery')).toBeUndefined()
    await queue.dispose()
    expect(await names()).toEqual(['operator-skill'])
    const resumed = ctx.plugin({ name: 'machine-resumed', inject: ['skills'], apply: (child: Context) => registerCapabilitySkills(child, 'machine', root) })
    await resumed
    expect(await names()).toEqual(['deep-discover', 'machine-discovery', 'machine-onboarding', 'onboard-slop', 'operator-skill', 'project-work'])
  })
})
