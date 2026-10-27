import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SlopUiProvider } from '../context.tsx'
import '../style.css'
export const inject = ['slots', 'slopUi', 'uiWorkspace']
import { KnowledgeSettings } from '../KnowledgeSettings.tsx'
export function apply(ctx: Context): void {
  const { client, store } = ctx.slopUi
  ctx.effect(() => ctx.slopUi.settingsTabs.register({ id: 'knowledge', order: 30, label: 'Knowledge', render: () => <SlopUiProvider client={client} store={store}><KnowledgeSettings compact listDirectory={(path, signal) => ctx.uiWorkspace.listDirectory(path, signal)} /></SlopUiProvider> }), 'slopUi.settingsTabs.knowledge')
}
