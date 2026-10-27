import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationMatch, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

interface QueueNoticeData {
  readonly summary: string
  readonly time: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'slop-queue-notice': QueueNoticeData
  }
}

interface QueueNoticeState extends QueueNoticeData {
  readonly messageId: string
  readonly anchorSeq: number
}

function queueSummary(event: ConversationMatch['event']): string | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return undefined
  const source = event.data.source as { kind?: unknown; plugin?: unknown; form?: unknown; summary?: unknown }
  const owned = source.kind === 'plugin:dsh-slop-queue'
    || ((source.kind === 'dsh-slop-queue' || source.kind === 'plugin') && source.plugin === 'dsh-slop-queue')
  if (!owned || source.form !== 'notice') return undefined
  return typeof source.summary === 'string' && source.summary.trim() !== '' ? source.summary : undefined
}

/** Passive Queue notices must remain visible when upstream folds technical context out of Chat. */
export const queueNoticeDefinition: ConversationNodeDefinition<QueueNoticeState> = {
  kind: 'slop-queue-notice',
  target: 'chat',
  match: event => event.type === 'user/message' && queueSummary(event) !== undefined
    ? { id: String(event.data.id), role: 'start' } : null,
  start: (_context, match) => {
    const summary = queueSummary(match.event)
    if (match.event.type !== 'user/message' || summary === undefined) throw new Error('Queue notice requires an appended Queue message')
    return { summary, time: match.event.time, messageId: String(match.event.data.id), anchorSeq: match.event.seq }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'slop-queue-notice',
    id: context.state.messageId,
    target: 'chat',
    anchorSeq: context.state.anchorSeq + 0.001,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: { summary: context.state.summary, time: context.state.time },
  }),
}

export function QueueNotice({ node }: { readonly node: ChatNode<'slop-queue-notice'> }) {
  return <aside className="slop-queue-notice" aria-label="Queue update">
    <strong>Job update</strong>
    <span>{node.data.summary}</span>
    <time dateTime={new Date(node.data.time).toISOString()}>{new Date(node.data.time).toLocaleString()}</time>
  </aside>
}
