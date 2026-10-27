import styles from './ChatStatus.module.css'
import { clsx } from 'clsx'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ChatMachineChips } from './ChatMachineChips.tsx'
import { ChatJobs } from './ChatJobs.tsx'
import { RemoteShellView } from './RemoteShellView.tsx'
import { SlopUiProvider } from './context.tsx'
import type { SlopRemoteClient } from './remote-client.ts'
import type { SlopStore } from './store.ts'

/** The public header action seat owns lifecycle; its chips occupy the header's last row. */
export function HeaderStatus(props: PropsRuntime<'conversation.session.header.actions'> & { client: SlopRemoteClient; store: SlopStore }) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [header, setHeader] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setHeader(anchor.current?.closest('header') ?? null) }, [])
  return <><span ref={anchor} hidden />{header === null ? null : createPortal(
    <SlopUiProvider client={props.client} store={props.store}><div className={clsx(styles.surface, styles['slop-chat-header-status'])}><ChatMachineChips {...props} /></div></SlopUiProvider>, header,
  )}</>
}

/** Additive slots preserve upstream header, composer, and PTC Tool ownership. */
export function registerMachineStatus(ctx: Context, client: SlopRemoteClient, store: SlopStore): void {
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'slop-machine-chips', order: 30 }, props => <HeaderStatus {...props} client={client} store={store} />))
}

export function registerQueueStatus(ctx: Context, client: SlopRemoteClient, store: SlopStore): void {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'slop-chat-jobs', order: 30 }, props =>
    <SlopUiProvider client={client} store={store}><div className={styles.surface}><ChatJobs key={props.sessionId} sessionId={props.sessionId} /></div></SlopUiProvider>))
}

export function registerShellHistory(ctx: Context, client: SlopRemoteClient, store: SlopStore): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'slop_machine_shell' }, props =>
    <SlopUiProvider client={client} store={store}><div className={styles.surface}><RemoteShellView {...props} /></div></SlopUiProvider>))
}

export function registerChatStatus(ctx: Context, client: SlopRemoteClient, store: SlopStore): void { registerMachineStatus(ctx, client, store); registerQueueStatus(ctx, client, store); registerShellHistory(ctx, client, store) }
