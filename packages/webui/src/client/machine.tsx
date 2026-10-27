import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SlopUiProvider } from '../context.tsx'
import '../style.css'
export const inject = ['slots', 'slopUi', 'uiWorkspace']
import { MachineSettings } from '../MachineSettings.tsx'
import { registerMachineStatus } from '../chat-status-registration.tsx'
export async function apply(ctx: Context): Promise<() => void> {
  const { client, store } = ctx.slopUi
  await store.activate()
  registerMachineStatus(ctx, client, store)
  ctx.effect(() => ctx.slopUi.settingsTabs.register({ id: 'machines', order: 20, label: 'Machines', render: () => <SlopUiProvider client={client} store={store}><MachineSettings compact /></SlopUiProvider> }), 'slopUi.settingsTabs.machines')
  return () => store.suspend()
}
