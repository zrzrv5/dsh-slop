import type {} from './queue-delivery-projection.ts'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { boundContextSummary, createUserMessage, type ContextFormed, type Message } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { queueWorkerPreset } from './queue-worker-preset.js'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  QueueChatDeliveryPort,
  QueueDeliveryRequest,
  QueueQueryRequest,
  QueueQueryWorkerPort,
  QueueSessionTarget,
} from '@dsh-slop/queue'
import { queueSessionTargetSchema } from '@dsh-slop/queue'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-slop-queue': { kind: 'dsh-slop-queue'; plugin: 'dsh-slop-queue'; dispatchId?: string } & ContextFormed
  }
}

const OBSERVATION_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          queueItemId: { type: 'string' },
          state: {
            type: 'string',
            enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'],
          },
          observedAt: { type: 'string' },
          evidence: { type: 'string' },
          elapsedSeconds: { type: 'number' },
          expectedRemainingSeconds: { type: 'number' },
          recommendedCheckAfterSeconds: { type: 'integer' },
          recommendationReason: { type: 'string' },
        },
        required: ['queueItemId', 'state', 'observedAt', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['observations'],
  additionalProperties: false,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderQueueDelivery(request: QueueDeliveryRequest): string {
  const entries = request.triggers.map(trigger => {
    const status = trigger.event === 'state-change'
      ? `${trigger.previousState} -> ${trigger.state}`
      : trigger.event.replaceAll('-', ' ')
    return `- ${trigger.label} (${trigger.queueItemId}): ${status} at ${trigger.observedAt}`
  }).join('\n')
  return [
    '<dsh-slop-queue-update>',
    'Source: DSH-SLOP Queue monitor. This is host-observed task state, not a user instruction or approval.',
    entries,
    'Full probe evidence remains in Queue Ledger.',
    'Report only relevant information not already conveyed, including a new failure, monitoring degradation, or recovery even if the task state is unchanged.',
    ...(request.delivery === 'wake' ? [
      'Read the relevant Queue item and verify its evidence. Resume unfinished steps already authorized by the user in this Chat; do not ask the user to repeat that authorization.',
      'Before submitting a next step, check existing Queue items and submission receipts so a repeated notice cannot duplicate work. A completed process still requires result validation.',
      'On failure or cancellation, diagnose first. Submit, cancel, or retry only within the existing user authorization; this notice grants no new authority.',
    ] : ['Do not submit, cancel, or retry work beyond the user\'s existing authorization.']),
    '</dsh-slop-queue-update>',
  ].join('\n')
}

function isQueueDeliveryMessage(message: Message, text: string): boolean {
  const source = message.source as unknown as {
    kind?: string
    plugin?: unknown
    form?: unknown
  }
  const block = message.content[0]
  const owned = source.kind === 'plugin:dsh-slop-queue'
    || ((source.kind === 'dsh-slop-queue' || source.kind === 'plugin') && source.plugin === 'dsh-slop-queue')
  return message.role === 'user' && owned && source.form === 'notice'
    && message.content.length === 1 && block?.type === 'text'
    // Pending pre-fix notices already appended to history have the old footer.
    // Match those exact notices without rewriting history or appending them again.
    && block.text.replace(
      '\nDo not submit, cancel, or retry work unless the user asks.\n</dsh-slop-queue-update>',
      '\nDo not submit, cancel, or retry work beyond the user\'s existing authorization.\n</dsh-slop-queue-update>',
    ) === text
}

type DispatchReceipt = { state: 'absent' | 'claimed' | 'consumed' | 'discarded'; messageId?: string } | { state: 'enqueued'; message: UserMessage }

/** Read durable native events as well as the live Inbox: a removed input stays removed. */
function inspectDispatch(agent: Agent, dispatchId: string, text: string): DispatchReceipt {
  const matches = (message: Message): boolean => (message.source.kind === 'dsh-slop-queue' && message.source.dispatchId === dispatchId) || isQueueDeliveryMessage(message, text)
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(matches)
  if (pending !== undefined) return { state: 'enqueued', message: pending }
  if (agent.session.deriveMessages().some(matches)) return { state: 'consumed' }
  const state = agent.ctx.sessionProjections.stateOf(agent.session, 'slopQueueDelivery')
  if (state === undefined) throw new Error('Queue delivery receipt projection is unavailable')
  const receipt = state.receipts[dispatchId]
  if (receipt === 'enqueued') throw new Error('Queue receipt and native Inbox disagree')
  return { state: receipt ?? 'absent', ...(state.messageIds[dispatchId] === undefined ? {} : { messageId: state.messageIds[dispatchId] }) }
}

/** Resolve the exact durable Chat identity used for Queue ownership and subscriptions. */
export function queueSessionTargetForAgent(agent: Agent): QueueSessionTarget {
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('Queue ownership requires the current Chat to have a durable cwd')
  }
  const agentPreset = agent.ctx.sessionProjections.stateOf(agent.session, 'agentPreset') ?? undefined
  if (agentPreset === undefined) {
    throw new Error('Queue ownership requires the current Chat to have a durable Agent preset')
  }
  return queueSessionTargetSchema.parse({
    sessionId: String(agent.session.id),
    cwd,
    agentPreset,
  })
}

/** V2 persisted Queue targets retain the old built-in name after DSH migrates their Chat. */
function currentPreset(preset: string): string {
  return preset === 'code' ? 'ptc' : preset
}

function sameSessionTarget(left: QueueSessionTarget, right: QueueSessionTarget): boolean {
  return left.sessionId === right.sessionId
    && left.cwd === right.cwd
    && left.agentPreset === currentPreset(right.agentPreset)
}

function assertSessionTarget(agent: Agent, target: QueueSessionTarget, label: string): void {
  if (!sameSessionTarget(queueSessionTargetForAgent(agent), target)) {
    throw new Error(`${label} ${target.sessionId} does not match its stored cwd and preset`)
  }
}

/** DSH adapter for fresh query workers and targeted Chat delivery. */
export class DshQueueRuntime implements QueueQueryWorkerPort, QueueChatDeliveryPort {
  private readonly abortController = new AbortController()
  private readonly attemptedDispatches = new Set<string>()

  /** `fallbackAgentOptions` is read at each fallback check, so Settings edits apply without a restart. */
  constructor(private readonly ctx: Context, private readonly options: { readonly fallbackAgentOptions?: () => AgentOptions | undefined } = {}) {}

  /** Snapshot before native signal shutdown clears Inbox as a generic cancellation. */
  pendingAtShutdown(): { dispatchId: string; messageId: string }[] {
    return this.ctx.agents.list().flatMap(agent => [...agent.inbox.nextTurn, ...agent.inbox.nextStep].flatMap(message => message.source.kind === 'dsh-slop-queue' && message.source.dispatchId !== undefined ? [{ dispatchId: message.source.dispatchId, messageId: String(message.id) }] : []))
  }

  close(): void {
    this.abortController.abort(new Error('DSH-SLOP Queue runtime closed'))
  }

  async query(request: QueueQueryRequest): Promise<unknown> {
    this.abortController.signal.throwIfAborted()
    const { agent: parent, owned } = await this.resolveQueryParent(request.parent)
    let run: SubagentActivation | undefined
    let cancellation: Promise<void> | undefined
    const cancel = () => {
      if (run === undefined) return
      cancellation ??= run.dispose()
      // Retain cleanup failures for finally while cancellation settles the result.
      void cancellation.catch(() => {})
    }
    try {
      const agentOptions = this.options.fallbackAgentOptions?.()
      run = await this.ctx.subagents.startActivation({
        provider: 'spawn',
        delivery: 'caller',
        label: `Queue check: ${request.observerKind} (${String(request.items.length)})`,
        signal: this.abortController.signal,
        request: {
          prompt: [{ type: 'text', text: request.prompt }],
          parent,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          cwd: request.parent.cwd,
          outputSchema: OBSERVATION_OUTPUT_SCHEMA,
          agentPreset: queueWorkerPreset(request.target.kind),
        },
      })
      this.abortController.signal.addEventListener('abort', cancel, { once: true })
      if (this.abortController.signal.aborted) cancel()
      const result = await run.result
      this.abortController.signal.throwIfAborted()
      if (result.stopReason !== 'completed') {
        throw new Error(`Queue query worker ended with '${result.stopReason}': ${result.diagnostic ?? 'no diagnostic'}`)
      }
      if (result.structured === undefined) {
        throw new Error('Queue query worker completed without the required structured observation batch')
      }
      return result.structured
    } finally {
      this.abortController.signal.removeEventListener('abort', cancel)
      try { await (cancellation ?? run?.dispose()) } finally { await owned?.dispose() }
    }
  }

  async deliver(request: QueueDeliveryRequest): Promise<{ state: 'enqueued' | 'consumed' | 'discarded' }> {
    this.abortController.signal.throwIfAborted()
    const agent = await this.resolveDeliveryAgent(request.target)
    this.abortController.signal.throwIfAborted()
    const text = renderQueueDelivery(request)
    const dispatchId = request.dispatchId ?? createHash('sha256').update(JSON.stringify([request.target, request.triggers.map(trigger => trigger.triggerKey)])).digest('hex')
    const message = createUserMessage({
      source: {
        kind: 'dsh-slop-queue',
        plugin: 'dsh-slop-queue',
        dispatchId,
        form: 'notice',
        summary: boundContextSummary(request.triggers.map(trigger => `${trigger.label}: ${trigger.event === 'state-change' ? trigger.state : trigger.event.replaceAll('-', ' ')}`).join('; ')),
      },
      content: [{ type: 'text', text }],
    })
    if (request.delivery === 'wake') {
      let receipt = inspectDispatch(agent, dispatchId, text)
      if (receipt.state === 'absent' || (receipt.state === 'discarded' && request.shutdownMessageId !== undefined && receipt.messageId === request.shutdownMessageId)) {
        this.attemptedDispatches.add(dispatchId)
        agent.followup(message)
      } else if ((receipt.state === 'enqueued' || receipt.state === 'claimed') && agent.status === 'idle' && !this.attemptedDispatches.has(dispatchId)) {
        // Restore an unconsumed input once per Host lifetime. Never retry the
        // provider in this loop. A canceled Inbox splice is a durable tombstone.
        this.attemptedDispatches.add(dispatchId)
        if (receipt.state === 'enqueued') agent.inbox.remove(receipt.message.id)
        agent.followup(receipt.state === 'enqueued' && request.shutdownMessageId === undefined ? receipt.message : message)
      }
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Queue delivery has no active Session durability listener')
      receipt = inspectDispatch(agent, dispatchId, text)
      if (receipt.state === 'absent') throw new Error('Queue continuation was not persisted in the native Inbox or Session')
      return { state: receipt.state === 'claimed' ? 'enqueued' : receipt.state }
    }

    // An idle Agent never consumes inject(). Publish to its Chat immediately;
    // retry an accepted append by flushing it again if persistence failed.
    if (!agent.session.deriveMessages().some(candidate => isQueueDeliveryMessage(candidate, text))) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    }
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Queue delivery has no active Session durability listener')
    return { state: 'consumed' }
  }

  private async resolveQueryParent(target: QueueSessionTarget): Promise<{
    readonly agent: Agent
    readonly owned?: AgentHandle
  }> {
    const sessionId = SessionId(target.sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      assertSessionTarget(live, target, 'Live Queue owner Chat')
      return { agent: live }
    }
    try {
      const owned = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        signal: this.abortController.signal,
        setup: async agentCtx => {
          await this.ctx.agentPresets.mount(agentCtx, currentPreset(target.agentPreset))
        },
      })
      try {
        assertSessionTarget(owned.agent, target, 'Resumed Queue owner Chat')
      } catch (error) {
        await owned.dispose()
        throw error
      }
      return { agent: owned.agent, owned }
    } catch (error) {
      const raced = this.ctx.agents.get(sessionId)
      if (raced !== undefined) {
        assertSessionTarget(raced, target, 'Raced Queue owner Chat')
        return { agent: raced }
      }
      throw new Error(`Cannot resume Queue owner Chat ${target.sessionId}: ${errorMessage(error)}`, { cause: error })
    }
  }

  private async resolveDeliveryAgent(target: QueueSessionTarget): Promise<Agent> {
    const sessionId = SessionId(target.sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      assertSessionTarget(live, target, 'Live Queue target Chat')
      return live
    }
    await this.ctx.sessionController.create({
      sessionId,
      cwd: target.cwd,
      agentPreset: currentPreset(target.agentPreset),
    })
    const resumed = this.ctx.agents.get(sessionId)
    if (resumed === undefined) {
      throw new Error(`Queue target Chat ${target.sessionId} was not published after activation`)
    }
    assertSessionTarget(resumed, target, 'Activated Queue target Chat')
    return resumed
  }
}
