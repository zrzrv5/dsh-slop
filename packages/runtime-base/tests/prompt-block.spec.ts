import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, onTestFinished } from 'vitest'
import { BEHAVIOR_SECTION, registerSlopPromptBlock } from '../src/prompt-block.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, personaSuffix: 'Persona suffix.' })
  return ctx
}

const names = async (ctx: Context) => (await ctx.systemPrompt.assemble({})).sections.map(section => section.name).filter(name => name !== 'deployment:persona-prefix')

describe('DSH-SLOP prompt block', () => {
  it('collects capability sections into one labeled block after the harness sections', async () => {
    const ctx = await fixture()
    ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'Harness shell guidance.' })
    ctx.systemPrompt.section({ name: 'slop:machine', order: 510, text: 'Machine rule.' })
    ctx.systemPrompt.section({ name: 'slop:queue', order: 515, text: 'Queue rule.' })
    onTestFinished(registerSlopPromptBlock(ctx))

    expect(await names(ctx)).toEqual(['tool:bash', 'slop:block', 'deployment:persona-suffix'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({}))
    const block = prompt.slice(prompt.indexOf('<dsh-slop>'), prompt.indexOf('</dsh-slop>'))
    expect(block).toContain('apply only to its tools (slop_*)')
    expect(block).toContain("Everything outside this block is the harness's default behavior")
    expect(block.indexOf('Machine rule.')).toBeLessThan(block.indexOf('Queue rule.'))
    expect(prompt.indexOf('Harness shell guidance.')).toBeLessThan(prompt.indexOf('<dsh-slop>'))
    expect(prompt.indexOf('</dsh-slop>')).toBeLessThan(prompt.indexOf('Persona suffix.'))
    expect(prompt).not.toContain('<dsh-slop><dsh-slop>')
  })

  it('replaces the harness Goal text inside the block and states that it is a change', async () => {
    const ctx = await fixture()
    ctx.systemPrompt.section({ name: 'tool:goal', order: 2400, text: 'create_goal may infer goal intent from a direct human request.' })
    ctx.systemPrompt.section({ name: 'slop:queue', order: 515, text: 'Queue rule.' })
    onTestFinished(registerSlopPromptBlock(ctx))

    const prompt = renderPrompt(await ctx.systemPrompt.assemble({}))
    expect(prompt).not.toContain('may infer goal intent')
    const block = prompt.slice(prompt.indexOf('<dsh-slop>'), prompt.indexOf('</dsh-slop>'))
    expect(block).toContain('Goals (DSH-SLOP replaces the harness default)')
    expect(block).toContain('/goal <objective>')
    expect(block).toContain('A cleared Goal stays cleared')
  })

  it('keeps the behavior section last, after the Goal rules, and adds nothing when no rule is registered', async () => {
    const ctx = await fixture()
    ctx.systemPrompt.section({ name: 'tool:bash', order: 1000, text: 'Harness shell guidance.' })
    const off = registerSlopPromptBlock(ctx)
    expect((await names(ctx)).filter(name => name !== 'deployment:persona-suffix')).toEqual(['tool:bash'])

    ctx.systemPrompt.section({ name: BEHAVIOR_SECTION, order: 100, text: 'Behavior rule.' })
    ctx.systemPrompt.section({ name: 'slop:machine', order: 510, text: 'Machine rule.' })
    ctx.systemPrompt.section({ name: 'tool:goal', order: 2400, text: 'Harness Goal text.' })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({}))
    expect(prompt.indexOf('Machine rule.')).toBeLessThan(prompt.indexOf('Goals (DSH-SLOP replaces the harness default)'))
    expect(prompt.indexOf('Goals (DSH-SLOP replaces the harness default)')).toBeLessThan(prompt.indexOf('Behavior rule.'))
    expect(prompt.indexOf('Behavior rule.')).toBeLessThan(prompt.indexOf('</dsh-slop>'))
    off()
    expect((await names(ctx)).includes('slop:block')).toBe(false)
  })
})
