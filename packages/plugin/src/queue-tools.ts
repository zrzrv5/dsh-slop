import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import {
  queuePurposeSchema,
  queueTrackingSchema,
  deliveryModeSchema,
  monitoringHintsSchema,
  observerKindSchema,
  queueObserverSchema,
  queueStateSchema,
  queueTargetSchema,
  triggerConditionSchema,
  type QueueItemPatch,
  type QueueMonitor,
  type QueueService,
} from '@dsh-slop/queue'
import { z } from 'zod'
import {
  canonicalQueueOutput,
  monitoringHintsValueSchema,
  queueGetOutputSchema,
  queueJsonOutput,
  queueListOutputSchema,
  queueObserverValueSchema,
  queueTargetValueSchema,
  queueTrackOutputSchema,
  queueUpdateOutputSchema,
  triggerConditionsValueSchema,
} from './queue-tool-schema.ts'
import { queueSessionTargetForAgent } from './queue-runtime.ts'
import type { QueueWebhook } from './queue-webhook.ts'
import { DEFAULT_QUEUE_LIST_LIMIT, queueListPage } from './queue-list.ts'

const trackInputSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  label: z.string().trim().min(1).max(1_024),
  notes: z.string().max(32_768).optional(),
  tags: z.array(z.string().min(1).max(128)).max(128).optional(),
  target: queueTargetSchema,
  observer: queueObserverSchema,
  initialState: queueStateSchema.optional(),
  monitoring: monitoringHintsSchema.optional(),
  purpose: queuePurposeSchema,
  continuation: z.string().trim().min(1).max(4_096).optional(),
}).strict()

const listInputSchema = z.object({
  states: z.array(queueStateSchema).max(6).optional(),
  observerKinds: z.array(observerKindSchema).max(3).optional(),
  target: queueTargetSchema.optional(),
  tags: z.array(z.string().min(1).max(128)).max(128).optional(),
  scope: z.enum(['all', 'primary', 'subscribed']).default('all'),
  limit: z.number().int().positive().max(500).default(DEFAULT_QUEUE_LIST_LIMIT),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
}).strict()

const updateInputSchema = z.object({
  queueItemId: z.string().min(1).max(128),
  action: z.enum(['patch', 'check-now', 'subscribe', 'unsubscribe']),
  expectedRevision: z.number().int().positive().optional(),
  patch: z.object({
    purpose: queuePurposeSchema.optional(),
    continuation: z.string().trim().min(1).max(4_096).optional(),
    label: z.string().trim().min(1).max(1_024).optional(),
    notes: z.string().max(32_768).nullable().optional(),
    tags: z.array(z.string().min(1).max(128)).max(128).optional(),
    monitoring: monitoringHintsSchema.optional(),
    nextCheckAt: z.iso.datetime({ offset: true }).nullable().optional(),
    primaryDelivery: deliveryModeSchema.optional(),
    primaryConditions: z.array(triggerConditionSchema).min(1).max(7).optional(),
  }).strict().optional(),
  delivery: deliveryModeSchema.optional(),
  conditions: z.array(triggerConditionSchema).min(1).max(7).optional(),
}).strict()

export interface QueueToolServices {
  readonly service: QueueService
  readonly monitor: QueueMonitor
  readonly webhook?: Pick<QueueWebhook, 'assertRegistration' | 'bind'> | undefined
}

function parameters(value: ParameterSchemaSpec): ParameterSchemaSpec {
  return Object.freeze(value)
}

function requireAgent(execution: { readonly agent?: Agent }): Agent {
  if (execution.agent === undefined) throw new Error('DSH-SLOP Queue tools require the current live Agent')
  return execution.agent
}

function registerTool(
  ctx: Context,
  definition: Parameters<Context['tools']['register']>[0],
): () => void {
  return ctx.tools.register(definition)
}

/** Register the complete model-facing surface of dsh-slop-queue. */
export function registerQueueTools(ctx: Context, services: QueueToolServices): () => void {
  const disposers = [
    registerTool(ctx, defineTool({
      name: 'slop_queue_track',
      description: 'Track an already-submitted local process or scheduler job in the durable Queue ledger. This Tool never submits work. For local work, launch with native bash or slop_machine_shell using nohup, then provide the PID identity, exit marker, stdout, and stderr paths. The current Chat becomes the primary owner automatically.',
      parameters: parameters({
        id: { type: 'string', description: 'Optional stable Queue item id' },
        label: { type: 'string', description: 'Human-readable task label', required: true },
        notes: { type: 'string', description: 'Optional bounded task context, result paths and remaining authorized steps. Use purpose continue and continuation for authorized next steps.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional string tags' },
        target: { ...queueTargetValueSchema, description: "Execution target: {kind:'local'} or {kind:'machine',machineId}", required: true },
        observer: { ...queueObserverValueSchema, description: "Observer: Slurm/PBS job id or process handle with pid, startToken, launchedAt, exitCodePath, stdoutPath, stderrPath", required: true },
        initialState: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'], description: 'Known initial state' },
        monitoring: { ...monitoringHintsValueSchema, description: 'Adaptive timing hints: expectedDurationSeconds, earliestCheckAfterSeconds, preferredIntervalSeconds, maximumIntervalSeconds, userIntervalSeconds' },
        purpose: { type: 'string', enum: ['monitor', 'continue'], required: true, description: 'monitor sends passive notices; continue wakes this Chat at confirmed terminal states for already authorized next steps.' },
        continuation: { type: 'string', description: 'Required for continue: authorized next step and exact result location to verify. Grants no new authorization.' },
      }),
      output: queueJsonOutput(queueTrackOutputSchema),
      async execute(args, execution) {
        const parsed = trackInputSchema.safeParse(args)
        if (!parsed.success) throw new Error('Registration requires purpose monitor or continue. Correct only Queue registration parameters; do not submit the external job again.')
        const input = parsed.data
        const tracking = queueTrackingSchema.safeParse({ purpose: input.purpose, ...(input.continuation === undefined ? {} : { continuation: input.continuation }) })
        if (!tracking.success) throw new Error('continue requires a short continuation describing the authorized next step and result location. Correct only registration; do not submit the job again.')
        const primary = queueSessionTargetForAgent(requireAgent(execution))
        services.webhook?.assertRegistration(input.id, input.target, primary, input.observer.kind)
        const item = await services.service.track({
          ...(input.id === undefined ? {} : { id: input.id }),
          label: input.label,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          target: input.target,
          observer: input.observer,
          ...(input.initialState === undefined ? {} : { initialState: input.initialState }),
          ...(input.monitoring === undefined ? {} : { monitoring: input.monitoring }),
          ...tracking.data,
        }, {
          primary,
        })
        await services.webhook?.bind(item)
        await services.monitor.refresh()
        const value = services.webhook === undefined ? item : await services.service.get(item.id) ?? item
        return canonicalQueueOutput(queueTrackOutputSchema, { schemaVersion: 1, ok: true, value })
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_queue_list',
      description: 'Read compact Queue summaries, newest submissions first, without subscribing this Chat. For current status, filter by target and relevant states. page.stateCounts and page.total cover all matching tracked items, not just this page. Continue only if needed with page.nextOffset and the same filters; use slop_queue_get for full notes, continuation, observer identity and raw evidence. Labels and diagnostic text may be shortened with textTruncated. These are stored observations, not a live scheduler query: inspect lastObservation.observedAt, lastCheckError and verificationPending. Check Queue before scanning scheduler history; this does not require delaying Machine connection. Queue contains only tracked work, so an empty result cannot establish that no external job exists.',
      parameters: parameters({
        states: { type: 'array', items: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'] }, description: 'Optional Queue states' },
        observerKinds: { type: 'array', items: { type: 'string', enum: ['slurm', 'pbs', 'process'] }, description: 'Optional slurm, pbs, or process observer kinds' },
        target: { ...queueTargetValueSchema, description: 'Optional exact local or Machine target' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags; all must match' },
        scope: { type: 'string', enum: ['all', 'primary', 'subscribed'], description: 'Optional current-Chat relationship filter; default all' },
        limit: { type: 'integer', description: `Maximum summaries, 1-500; default ${DEFAULT_QUEUE_LIST_LIMIT}. The 12 KiB page budget may return fewer; use page.nextOffset.` },
        offset: { type: 'integer', description: 'Zero-based page offset; default 0. Use page.nextOffset with the same filters to read older matching submissions.' },
      }),
      output: queueJsonOutput(queueListOutputSchema),
      async execute(args, execution) {
        const input = listInputSchema.parse(args)
        const current = input.scope === 'all' ? undefined : queueSessionTargetForAgent(requireAgent(execution))
        const items = await services.service.list({
          ...(input.states === undefined ? {} : { states: input.states }),
          ...(input.observerKinds === undefined ? {} : { observerKinds: input.observerKinds }),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          ...(input.scope === 'primary' && current !== undefined ? { primarySessionId: current.sessionId } : {}),
          ...(input.scope === 'subscribed' && current !== undefined ? { subscribedSessionId: current.sessionId } : {}),
        })
        return canonicalQueueOutput(queueListOutputSchema, queueListPage(items, input))
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_queue_get',
      description: 'Read one Queue item and its latest raw observation evidence. This does not subscribe the current Chat.',
      parameters: parameters({
        queueItemId: { type: 'string', description: 'Exact Queue item id', required: true },
        observationLimit: { type: 'integer', description: 'Most recent observations to return, 1-200; default 20' },
      }),
      output: queueJsonOutput(queueGetOutputSchema),
      async execute(args) {
        const input = z.object({
          queueItemId: z.string().min(1).max(128),
          observationLimit: z.number().int().positive().max(200).default(20),
        }).strict().parse(args)
        const item = await services.service.get(input.queueItemId)
        if (item === undefined) throw new Error(`Queue item '${input.queueItemId}' does not exist`)
        const observations = await services.service.observations(input.queueItemId)
        return canonicalQueueOutput(queueGetOutputSchema, {
          schemaVersion: 1,
          ok: true,
          value: { item, observations: observations.slice(-input.observationLimit) },
        })
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_queue_update',
      description: 'Update Queue metadata or adaptive timing, request an immediate packed status check, or subscribe/unsubscribe the current Chat. It never submits, cancels, retries, or mutates the external task.',
      parameters: parameters({
        queueItemId: { type: 'string', description: 'Exact Queue item id', required: true },
        action: { type: 'string', enum: ['patch', 'check-now', 'subscribe', 'unsubscribe'], description: 'Exact Queue ledger action', required: true },
        expectedRevision: { type: 'integer', description: 'Optional optimistic revision for patch' },
        patch: { type: 'json', description: 'Metadata, timing, or purpose/continuation patch. Only the owning Chat may change purpose.' },
        delivery: { type: 'string', enum: ['wake', 'notify'], description: 'Subscription delivery mode' },
        conditions: { ...triggerConditionsValueSchema, description: 'Subscription trigger states or any-state-change' },
      }),
      output: queueJsonOutput(queueUpdateOutputSchema),
      async execute(args, execution) {
        const input = updateInputSchema.parse(args)
        let item
        let run
        switch (input.action) {
          case 'patch':
            if (input.patch === undefined) throw new Error('Queue patch action requires patch')
            {
              if (input.patch.purpose !== undefined || input.patch.continuation !== undefined || input.patch.primaryDelivery !== undefined || input.patch.primaryConditions !== undefined) {
                const owner = queueSessionTargetForAgent(requireAgent(execution))
                const current = await services.service.get(input.queueItemId)
                if (current === undefined) throw new Error(`Queue item '${input.queueItemId}' does not exist`)
                if (
                  current.attention.primary.sessionId !== owner.sessionId
                  || current.attention.primary.cwd !== owner.cwd
                  || current.attention.primary.agentPreset !== owner.agentPreset
                ) {
                  throw new Error('Only the primary owner Chat may change primary Queue delivery settings')
                }
              }
              const patch: QueueItemPatch = {
                ...(input.patch.purpose === undefined ? {} : { purpose: input.patch.purpose }),
                ...(input.patch.continuation === undefined ? {} : { continuation: input.patch.continuation }),
                ...(input.patch.label === undefined ? {} : { label: input.patch.label }),
                ...(input.patch.notes === undefined ? {} : { notes: input.patch.notes }),
                ...(input.patch.tags === undefined ? {} : { tags: input.patch.tags }),
                ...(input.patch.monitoring === undefined ? {} : { monitoring: input.patch.monitoring }),
                ...(input.patch.nextCheckAt === undefined ? {} : { nextCheckAt: input.patch.nextCheckAt }),
                ...(input.patch.primaryDelivery === undefined ? {} : { primaryDelivery: input.patch.primaryDelivery }),
                ...(input.patch.primaryConditions === undefined ? {} : { primaryConditions: input.patch.primaryConditions }),
              }
              item = await services.service.update(
                input.queueItemId,
                patch,
                input.expectedRevision,
              )
            }
            break
          case 'check-now': {
            const current = await services.service.get(input.queueItemId)
            if (current === undefined) throw new Error(`Queue item '${input.queueItemId}' does not exist`)
            item = await services.service.update(
              input.queueItemId,
              { nextCheckAt: new Date().toISOString() },
              input.expectedRevision ?? current.revision,
            )
            run = await services.service.runDue(new Date())
            item = await services.service.get(input.queueItemId)
            break
          }
          case 'subscribe':
            if (input.delivery === undefined || input.conditions === undefined) {
              throw new Error('Queue subscribe action requires delivery and conditions')
            }
            item = await services.service.subscribe(
              input.queueItemId,
              { delivery: input.delivery, conditions: input.conditions },
              { current: queueSessionTargetForAgent(requireAgent(execution)) },
            )
            break
          case 'unsubscribe':
            item = await services.service.unsubscribe(
              input.queueItemId,
              { current: queueSessionTargetForAgent(requireAgent(execution)) },
            )
            break
        }
        await services.monitor.refresh()
        const observations = await services.service.observations(input.queueItemId)
        return canonicalQueueOutput(queueUpdateOutputSchema, {
          schemaVersion: 1,
          ok: true,
          value: { item, ...(run === undefined ? {} : { run }), observations: observations.slice(-20) },
        })
      },
    })),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
