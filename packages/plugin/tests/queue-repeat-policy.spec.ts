import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { parse } from 'yaml'

it('exempts callback allocation while retaining upstream reminders for repeated reads', async () => {
  const require = createRequire(import.meta.url)
  const fromDsh = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
  // Exercise the public guard installed by the pinned base composition.
  const guard = await import(fromDsh.resolve('@deepseek-ai/dsh-repeat-tool-reminder'))
  const patch = parse(await readFile(new URL('../../bundle/cordis.patch.yml', import.meta.url), 'utf8')) as Array<{
    id?: string; config?: { exclude?: string[] }
  }>
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(guard, patch.find(row => row.id === 'repeat-tool-reminder')?.config)
  const agent = {}
  for (const name of ['slop_queue_prepare', 'slop_queue_get']) {
    const counts: number[] = []
    for (let index = 0; index < 3; index += 1) {
      const execution = { name, arguments: { target: 'same' }, agent } as ToolExecution
      const decision = await ctx.waterfall('tools/post-execute', execution,
        { content: [{ type: 'text', text: String(index) }], isError: false },
        async () => ({ kind: 'allow' as const }))
      counts.push(decision.additionalContexts?.length ?? 0)
    }
    expect(counts).toEqual(name === 'slop_queue_prepare' ? [0, 0, 0] : [0, 0, 1])
  }
})
