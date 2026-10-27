import { registerQueueDeliveryProjection } from './queue-delivery-projection.ts'
import { registerCapabilitySkills } from './capability-skills.ts'
import { resolve } from 'node:path'
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { Config as SharedConfig, validateConfig } from '@dsh-slop/runtime-base'
import { QueueMonitor, QueueService, SqliteQueueStore } from '@dsh-slop/queue'
import { DshQueueRuntime } from './queue-runtime.ts'
import { registerQueueWorkerPresets } from './queue-worker-preset.js'
import { DshQueueCommandRunner, DshQueueProbe } from './queue-probe.ts'
import { registerQueueTools, type QueueToolServices } from './queue-tools.ts'
import { QUEUE_SETTINGS_BRIDGE_PATH, serveQueueSettingsBridge } from './queue-settings-bridge.ts'
export interface QueueConfig extends SharedConfig {
  readonly fallbackProvider: Volatile<string>
  readonly fallbackModel: Volatile<string>
  readonly fallbackReasoningEffort: Volatile<string>
}
/** The Queue entry owns the fallback worker route; the shared fields stay defined in runtime-base. */
export const Config = z.object({
  ...SharedConfig.dict,
  fallbackProvider: z.string().default('').volatile().description('Provider route for the Queue fallback check worker; empty inherits the Chat\'s provider.'),
  fallbackModel: z.string().default('').volatile().description('Model id for the Queue fallback check worker; empty inherits the Chat\'s model. Used only when the provider is also set.'),
  fallbackReasoningEffort: z.string().default('').volatile().description('Optional reasoning effort for the Queue fallback check worker; empty inherits or omits it.'),
}) as unknown as z<QueueConfig>
declare module '@deepseek-ai/cordis' { interface Context { slopQueue: QueueAdapter; slopQueueCallbacks: NonNullable<QueueToolServices['webhook']> } }
export class QueueAdapter extends Service {
  constructor(ctx: Context, readonly service: QueueService, readonly monitor: QueueMonitor) { super(ctx, 'slopQueue') }
}
export const name = 'slop-queue'
export const inject = ['slopRuntime', 'webServer', 'subprocess', 'agents', 'agentPresets', 'subagents', 'sessions', 'sessionController', 'sessionProjections', 'tools', 'systemPrompt', 'skills']
/** The route applies only when provider and model are both set; a partial route leaves the parent's route in place. */
export function fallbackAgentOptions(config: Pick<QueueConfig, 'fallbackProvider' | 'fallbackModel' | 'fallbackReasoningEffort'>, onPartial?: () => void): AgentOptions | undefined {
  const provider = config.fallbackProvider.get().trim()
  const model = config.fallbackModel.get().trim()
  const reasoningEffort = config.fallbackReasoningEffort.get().trim()
  if (provider === '' || model === '') {
    if (provider !== '' || model !== '') onPartial?.()
    return undefined
  }
  return { provider, model, ...(reasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) }
}
export async function apply(ctx: Context, config: QueueConfig): Promise<void> {
  const home = validateConfig(config)
  // The Queue ships its own Settings page, so the host must not generate one.
  ctx.inject(['settings'], scoped => { scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber)) })
  registerCapabilitySkills(ctx, 'queue')
  ctx.systemPrompt.section({ name: 'slop:queue', order: 515, text: [
    'Queue records work you have already submitted and never submits, cancels or retries it. After a submission is accepted, track it with slop_queue_track and end the turn instead of polling or adding work to fill the wait.',
    'Use purpose "continue" only when the user already asked for the step that follows the job; use "monitor" otherwise. Queue holds only tracked work, so an empty result does not show that no other jobs exist. For questions about submitted jobs or their status, load queue-tracking.',
  ].join('\n') })
  ctx.effect(() => registerQueueDeliveryProjection(ctx))
  await registerQueueWorkerPresets(ctx)
  let warnedPartial = false
  const runtime = new DshQueueRuntime(ctx, { fallbackAgentOptions: () => fallbackAgentOptions(config, () => {
    if (!warnedPartial) { warnedPartial = true; ctx.logger.warn('Queue fallback model needs both a provider and a model; using the Chat\'s route.') }
  }) })
  const service = new QueueService({ store: new SqliteQueueStore(resolve(config.dataRoot, 'queue', 'queue.sqlite')), probe: new DshQueueProbe(new DshQueueCommandRunner(ctx, () => ctx.get('slopMachineExecution'), home)), queryWorker: runtime, chatDelivery: runtime })
  // Upstream 0.2.0-rc.2 clears Inbox on normal Agent disposal without a cause
  // on the splice. Snapshot exact still-pending identities before signal teardown.
  // A replacement wake gets a new native message id, so later user removal wins.
  const checkpoint = () => { try { service.checkpointShutdown(runtime.pendingAtShutdown()) } catch (error) { ctx.logger.error(error) } }
  ctx.effect(() => {
    process.prependListener('SIGTERM', checkpoint)
    process.prependListener('SIGINT', checkpoint)
    return () => { process.off('SIGTERM', checkpoint); process.off('SIGINT', checkpoint) }
  })
  const monitor = new QueueMonitor({ service, onError: error => ctx.logger.warn(error) })
  const close = async () => { monitor.stop(); runtime.close(); await service.close() }
  ctx.effect(() => close)
  try { await service.initialize() } catch (error) { await close(); throw error }
  new QueueAdapter(ctx, service, monitor)
  ctx.effect(() => registerQueueTools(ctx, { service, monitor, get webhook() { return ctx.get('slopQueueCallbacks') } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: QUEUE_SETTINGS_BRIDGE_PATH, handler: (req, res) => { void serveQueueSettingsBridge(req, res, ctx.slopRuntime.nonce, service, monitor, ctx.slopRuntime.trustedHosts) } }))
  // A recovered wake must see the Queue tools in its first assembled prompt.
  try { await monitor.start() } catch (error) { await close(); throw error }
}
