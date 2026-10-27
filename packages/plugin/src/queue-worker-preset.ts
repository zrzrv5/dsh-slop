import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const inject = ['tools']
export const Config = z.object({ target: z.union(['local', 'machine']).required() })
export interface Config { target: 'local' | 'machine' }

/** Preset-owned restrictions also apply when a completed worker is resumed. */
export function apply(ctx: Context, config: Config): void {
  // Creation listeners finish before the first turn. Apply at the Agent layer,
  // where preset tools are inherited and can be restricted by their names.
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: config.target === 'machine' ? ['slop_machine_shell'] : ['bash'] })
  })
}

export function queueWorkerPreset(target: 'local' | 'machine'): string {
  return `slop-queue-query-${target}`
}

export async function registerQueueWorkerPresets(ctx: Context): Promise<void> {
  for (const target of ['local', 'machine'] as const) {
    await ctx.effect(() => ctx.agentPresets.register({
      id: queueWorkerPreset(target),
      name: `Queue query (${target})`,
      description: 'Restricted scheduler/status query worker.',
      plugins: [
        { name: '@dsh-slop/plugin/queue-worker-preset', config: { target } },
        ...(target === 'local' ? [{ name: '@deepseek-ai/dsh-tool-bash' }] : []),
      ],
    }))
  }
}
