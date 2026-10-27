import { registerSkillReadPresentation } from '../skill-read-presentation.tsx'
import { registerShellHistory } from '../chat-status-registration.tsx'
import type { ReactNode } from 'react'
import '../style.css'
import { Service, type Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import slopRemote from '@dsh-slop/plugin/remote'
import { MachineConnectionChatCard, MachineTransferProgressChatCard } from '../ChatPresentationCards.tsx'
import { MachineInfoCard } from '../MachineInfoCard.tsx'
import { QueueNotice, queueNoticeDefinition } from '../QueueNotice.tsx'
import {
  SetupMachineCard,
  SetupMachineSubmissionMarker,
} from '../SetupConversationCard.tsx'
import {
  machineConnectionChatDefinition,
  machineInfoChatDefinition,
  machineTransferProgressChatDefinition,
  setupMachineChatDefinition,
  setupMachineSubmissionChatDefinition,
} from '../chat-presentation-definitions.ts'
import { SlopUiProvider, type SlopRoute } from '../context.tsx'
import type { SlopRemoteClient } from '../remote-client.ts'
import { createSlopStore, useSlopState, type SlopStore } from '../store.ts'
import { createDshRemoteClient } from './remote-adapter.ts'
import { BehaviorSettings } from '../BehaviorSettings.tsx'
import { SlopSettings } from '../SlopSettings.tsx'
import { createSettingsTabRegistry, type SlopSettingsTabRegistry } from '../settings-tabs.ts'
import { createBehaviorSettingsSource } from './behavior-source.ts'
import type { SettingsRemote } from './settings-remote.ts'

/** Services consumed by the Machine and Knowledge browser surfaces. */
export const inject = [
  'slots',
  'locale',
  'remote',
  'uiConversation',
  'uiWorkspace',
] as const

type SlotName = keyof import('@deepseek-ai/dsh-client-ui-slots').SlotMap & string

export function register(ctx: ClientContext, name: SlotName, options: Record<string, unknown>, component: unknown): void {
  ctx.slots.inject(name, () => ctx.slots.register({ name, ...options } as never, component as never))
}

function withProvider(
  client: SlopRemoteClient,
  store: SlopStore,
  children: ReactNode,
  route: SlopRoute = { kind: 'machines' },
): ReactNode {
  return <SlopUiProvider client={client} store={store} route={route}><MachineHistory store={store}>{children}</MachineHistory></SlopUiProvider>
}

/** Register Machine setup/access, Machine Info, and the product settings surfaces. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(slopRemote)
  let ownedStore: SlopStore | undefined
  try {
    const client = createDshRemoteClient(ctx, ctx.get('remote.slop'))
    const store = createSlopStore(client)
    ownedStore = store
    store.suspend()
    // The settings Remote is resolved on each call, so a profile without it only loses the settings tabs that use it.
    const settings: SettingsRemote = {
      describe: async () => await (ctx.get('remote.settings') as SettingsRemote).describe(),
      update: async (ns, patch, revision) => await (ctx.get('remote.settings') as SettingsRemote).update(ns, patch, revision),
    }
    const runtime = new SlopUiRuntime(ctx, client, store, settings)

    registerSkillReadPresentation(ctx)
    registerShellHistory(ctx, client, store)
    ctx.uiConversation.events.register(setupMachineChatDefinition)
    ctx.uiConversation.events.register(setupMachineSubmissionChatDefinition)
    ctx.uiConversation.events.register(machineInfoChatDefinition)
    ctx.uiConversation.events.register(machineConnectionChatDefinition)
    ctx.uiConversation.events.register(machineTransferProgressChatDefinition)
    ctx.uiConversation.events.register(queueNoticeDefinition)

    // One settings section; each enabled component adds its own tab to it.
    const behaviorSource = createBehaviorSettingsSource(settings)
    runtime.settingsTabs.register({ id: 'behavior', order: 10, label: 'Behavior', render: () => <BehaviorSettings source={behaviorSource} /> })
    register(ctx, 'settings.section', { id: 'dsh-slop', order: 30, label: 'DSH-SLOP' }, () => <SlopSettings tabs={runtime.settingsTabs} />)
    register(
      ctx,
      'conversation.chat.commandview',
      { key: 'setupmachine' },
      // The command lifecycle stays in history; its business node renders the card.
      () => null,
    )
    register(ctx, 'conversation.chat.node', { key: 'slop-setup-machine' }, (props: Record<string, unknown>) => {
      const runtime = props as unknown as PropsRuntime<'conversation.chat.node', 'slop-setup-machine'>
      return withProvider(client, store, <SetupMachineCard
        cardId={runtime.node.data.toolCallId}
        input={runtime.node.data.input}
        useInput={runtime.useInput}
        inputActions={runtime.inputActions}
      />)
    })
    register(ctx, 'conversation.chat.node', { key: 'slop-queue-notice' }, (props: PropsRuntime<'conversation.chat.node', 'slop-queue-notice'>) => <QueueNotice node={props.node} />)
    register(ctx, 'conversation.chat.node', { key: 'slop-setup-machine-submission' }, (props: Record<string, unknown>) => {
      const runtime = props as unknown as PropsRuntime<'conversation.chat.node', 'slop-setup-machine-submission'>
      return withProvider(client, store, <SetupMachineSubmissionMarker messageId={runtime.node.data.messageId} />)
    })
    register(
      ctx,
      'conversation.chat.node',
      { key: 'slop-machine-info' },
      (props: Record<string, unknown>) => withProvider(
        client,
        store,
        <MachineInfoCard machineInfo={(props as unknown as PropsRuntime<'conversation.chat.node', 'slop-machine-info'>).node.data.machineInfo} />,
      ),
    )
    register(
      ctx,
      'conversation.chat.node',
      { key: 'slop-machine-connection' },
      (props: Record<string, unknown>) => withProvider(
        client,
        store,
        <MachineConnectionChatCard node={(props as unknown as PropsRuntime<'conversation.chat.node', 'slop-machine-connection'>).node} />,
      ),
    )
    register(
      ctx,
      'conversation.chat.node',
      { key: 'slop-machine-transfer-progress' },
      (props: Record<string, unknown>) => withProvider(
        client,
        store,
        <MachineTransferProgressChatCard node={(props as unknown as PropsRuntime<'conversation.chat.node', 'slop-machine-transfer-progress'>).node} />,
      ),
    )

    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      store.destroy()
      await disposeRemote()
    }
  } catch (error) {
    ownedStore?.destroy()
    await disposeRemote()
    throw error
  }
}

function MachineHistory({ store, children }: { store: SlopStore; children: ReactNode }): ReactNode {
  const state = useSlopState(store)
  return <div className="slop-slot-surface">{state.enabled === false ? <small>Machine is disabled · historical record</small> : null}<fieldset disabled={state.enabled === false} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children}</fieldset></div>
}
declare module '@deepseek-ai/cordis' { interface Context { slopUi: SlopUiRuntime } }
class SlopUiRuntime extends Service {
  /** Tabs of the DSH-SLOP settings section; component clients register theirs while enabled. */
  readonly settingsTabs: SlopSettingsTabRegistry = createSettingsTabRegistry()
  constructor(ctx: ClientContext, readonly client: SlopRemoteClient, readonly store: SlopStore, readonly settings: SettingsRemote) { super(ctx, 'slopUi') }
}
