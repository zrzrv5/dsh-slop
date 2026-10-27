// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { ConversationStartMatch } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { afterEach, expect, it } from 'vitest'
import { QueueNotice, queueNoticeDefinition } from '../src/QueueNotice.tsx'

afterEach(cleanup)

function notice(kind: string, plugin = 'dsh-slop-queue'): ConversationStartMatch {
  return { event: {
    type: 'user/message', seq: 41, time: 1_700_000_000_000, surfaceOp: 'append',
    data: { id: 'failure-notice', role: 'user', source: { kind, ...(kind === 'plugin:dsh-slop-queue' ? {} : { plugin }), form: 'notice', summary: 'KPAR comparison: failed' },
      content: [{ type: 'text', text: 'Internal context guidance must stay out of the compact notice.' }] },
  }, role: 'start', location: { kind: 'unresolved' } } as unknown as ConversationStartMatch
}

it.each(['plugin', 'plugin:dsh-slop-queue', 'dsh-slop-queue'])('renders a durable %s Queue failure even without a new Agent turn', kind => {
  const start = notice(kind)
  expect(queueNoticeDefinition.match(start.event)).toEqual({ id: 'failure-notice', role: 'start' })
  const base: Parameters<NonNullable<typeof queueNoticeDefinition.start>>[0] = {
    key: 'slop-queue-notice:failure-notice', id: 'failure-notice', kind: 'slop-queue-notice',
    matches: [start], start, current: new Map(), state: undefined,
  }
  const state = queueNoticeDefinition.start!(base, start, undefined as never)
  const node = queueNoticeDefinition.buildViewNode!({ ...base, state }) as ChatNode<'slop-queue-notice'>
  expect(node.visibility).toBe('visible')
  render(<QueueNotice node={node} />)
  expect(screen.getByLabelText('Queue update').textContent).toContain('KPAR comparison: failed')
  expect(screen.queryByText(/Internal context guidance/)).toBeNull()
})

it('does not turn user text, unrelated plugin context, or replacements into Queue notices', () => {
  expect(queueNoticeDefinition.match(notice('user').event)).toBeNull()
  expect(queueNoticeDefinition.match(notice('plugin', 'another-plugin').event)).toBeNull()
  const replacement = { ...notice('dsh-slop-queue').event, surfaceOp: 'replace' }
  expect(queueNoticeDefinition.match(replacement as never)).toBeNull()
})
