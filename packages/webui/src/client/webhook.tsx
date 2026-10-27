import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SlopUiProvider } from '../context.tsx'
import '../style.css'
export const inject = ['slots', 'slopUi', 'uiWorkspace']
import { QueueWebhookSettings } from '../QueueWebhookSettings.tsx'
export function apply(ctx: Context): void {
  const { client, store } = ctx.slopUi
  ctx.effect(() => ctx.slopUi.settingsTabs.register({ id: 'callbacks', order: 50, label: 'Callbacks', render: () => <SlopUiProvider client={client} store={store}><QueueWebhookSettings /></SlopUiProvider> }), 'slopUi.settingsTabs.callbacks')
}
