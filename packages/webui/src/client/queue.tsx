import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SlopUiProvider } from '../context.tsx'
import '../style.css'
export const inject = ['slots', 'slopUi', 'uiWorkspace']
import { QueueSettings } from '../QueueSettings.tsx'
import { QueueFallbackModel } from '../QueueFallbackModel.tsx'
import { createQueueFallbackSource, type LlmRemote } from './queue-fallback-source.ts'
import { registerQueueStatus } from '../chat-status-registration.tsx'
export function apply(ctx: Context): void {
  const { client, store } = ctx.slopUi
  registerQueueStatus(ctx, client, store)
  // Provider suggestions are optional; a profile without the LLM Remote keeps free text entry.
  const fallbackSource = createQueueFallbackSource(ctx.slopUi.settings, () => ctx.get('remote.llm') as LlmRemote | undefined)
  ctx.effect(() => ctx.slopUi.settingsTabs.register({ id: 'queue', order: 40, label: 'Queue', render: () => <SlopUiProvider client={client} store={store}><QueueSettings compact /><QueueFallbackModel source={fallbackSource} /></SlopUiProvider> }), 'slopUi.settingsTabs.queue')
}
