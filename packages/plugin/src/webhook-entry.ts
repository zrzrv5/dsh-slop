import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Config, validateConfig } from '@dsh-slop/runtime-base'
import type {} from './queue-entry.ts'
import { QueueWebhook, saveWebhookSettings } from './queue-webhook.ts'
import { QueueWebhookStore } from './queue-webhook-store.ts'
import { QUEUE_WEBHOOK_SETTINGS_PATH, registerQueueWebhookIntegration, serveQueueWebhookSettings } from './queue-webhook-integration.ts'
export { Config } from '@dsh-slop/runtime-base'
export const name = 'slop-queue-callbacks'
export const inject = ['slopRuntime', 'webServer', 'tools', 'systemPrompt']
class CallbackRegistration extends Service {
  readonly assertRegistration: QueueWebhook['assertRegistration']
  readonly bind: QueueWebhook['bind']
  constructor(ctx: Context, webhook: QueueWebhook) { super(ctx, 'slopQueueCallbacks'); this.assertRegistration = webhook.assertRegistration.bind(webhook); this.bind = webhook.bind.bind(webhook) }
}
export async function apply(ctx: Context, config: Config): Promise<void> {
  validateConfig(config)
  const store = new QueueWebhookStore(resolve(config.dataRoot, 'queue', 'webhook.sqlite'))
  await store.open()
  ctx.effect(() => () => store.close())
  let active: QueueWebhook | undefined
  ctx.inject(['slopQueue'], async scoped => {
    const webhook = new QueueWebhook(store, scoped.slopQueue.service, scoped.slopQueue.monitor, false)
    scoped.effect(() => async () => { active = undefined; await webhook.close() })
    await webhook.start()
    active = webhook
    new CallbackRegistration(scoped, webhook)
    scoped.effect(() => registerQueueWebhookIntegration(scoped, webhook))
  })
  const view = () => {
    if (active !== undefined) return active.view()
    const { tunnelToken, enabled: _legacyEnabled, ...settings } = store.settings()
    return { settings, enabled: true, tokenConfigured: tunnelToken.length > 0, receiving: false, connectorRunning: false, localService: 'http://127.0.0.1:' + String(settings.port), error: 'Paused: enable Queue to resume public callbacks.', lastEventAt: undefined, publicVerifiedAt: undefined }
  }
  const bridge = { view, update: async (raw: unknown) => { if (active !== undefined) await active.update(raw); else saveWebhookSettings(store, raw) }, testPublic: async () => { if (active === undefined) throw new Error('Enable Queue before testing the public connection'); await active.testPublic() } }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: QUEUE_WEBHOOK_SETTINGS_PATH, handler: (req, res) => { void serveQueueWebhookSettings(req, res, ctx.slopRuntime.nonce, bridge, ctx.slopRuntime.trustedHosts) } }))
}
