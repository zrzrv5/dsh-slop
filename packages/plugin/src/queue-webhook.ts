import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { queueCallbackEventSchema, targetKey, type QueueItem, type QueueMonitor, type QueueService, type QueueSessionTarget, type QueueTarget } from '@dsh-slop/queue'
import { z } from 'zod'
import { callbackScript } from './queue-webhook-script.ts'
import { QueueWebhookStore, webhookSettingsSchema, type CallbackLease, type WebhookSettings } from './queue-webhook-store.ts'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const sameOwner = (a: QueueSessionTarget, b: QueueSessionTarget): boolean => a.sessionId === b.sessionId && a.cwd === b.cwd && a.agentPreset === b.agentPreset
export const webhookUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  provider: z.enum(['cloudflare', 'external']),
  publicOrigin: z.string().max(2_048),
  port: z.number().int().min(1024).max(65535),
  disabledMachineIds: z.array(z.string().min(1).max(128)).max(1_000),
  tunnelToken: z.string().trim().max(16_384).optional(),
  clearToken: z.boolean().optional(),
}).strict()

/** One optional listener and connector per Host, isolated from the DSH browser server. */
export class QueueWebhook {
  private server: Server | undefined
  private child: ChildProcess | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private reconnects = 0
  private accepting = false
  private closed = false
  private error: string | undefined
  private lastEventAt: string | undefined
  private publicVerifiedAt: string | undefined
  private readonly instance = randomBytes(16).toString('hex')
  private chain: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(readonly store: QueueWebhookStore, private readonly service: QueueService, private readonly monitor: Pick<QueueMonitor, 'refresh'>, private readonly ownsStore = true) {}

  async start(): Promise<void> {
    if (this.ownsStore) await this.store.open()
    this.store.prune(new Date())
    await this.reconcile()
    if (this.accepting) {
      try { await this.drain() } catch { this.error = 'Stored callback reconciliation needs retry; Queue polling continues.' }
    }
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  enabledFor(target: QueueTarget): boolean {
    const settings = this.store.settings()
    return !this.closed && (target.kind === 'local' || !settings.disabledMachineIds.includes(target.machineId))
  }
  view() {
    const { tunnelToken, enabled: _legacyEnabled, ...settings } = this.store.settings()
    return { settings, enabled: !this.closed, tokenConfigured: tunnelToken.length > 0, receiving: this.accepting, connectorRunning: this.child !== undefined,
      error: this.error, lastEventAt: this.lastEventAt, publicVerifiedAt: this.publicVerifiedAt,
      localService: `http://127.0.0.1:${String(settings.port)}` }
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn,fn)
    this.chain = next.catch(() => {})
    return await next
  }
  async update(raw: unknown): Promise<void> {
    await this.exclusive(async () => {
      saveWebhookSettings(this.store, raw)
      this.accepting = false
      await this.stopTransport()
      await this.reconcile()
      this.emit()
    })
  }
  prepare(target: QueueTarget, owner: QueueSessionTarget, observerKind: CallbackLease['observerKind']) {
    if (!this.enabledFor(target) || !this.accepting) throw new Error('Queue callbacks are not enabled and receiving for this target')
    this.store.prune(new Date())
    const token = randomBytes(32).toString('base64url')
    const runId = randomUUID()
    this.store.insertLease({ runId, tokenHash: digest(token), owner, target, observerKind, bound: false,
      expiresAt: new Date(Date.now()+180*24*60*60_000).toISOString() })
    return { queueItemId: runId, script: callbackScript(this.store.settings().publicOrigin,runId,token),
      instructions: 'Reuse this helper for this intended execution. Insert or source it only in a compatible Bash script already being created or edited; preserve scheduler directives, traps, submission method and log paths. For an unchanged wrapper or incompatible traps, skip this helper and track the normal submission with polling. Call slop_queue_track with this queueItemId only when using this helper, and the exact submitted observer. Do not discover/register child jobs. Registration expires in 180 days.' }
  }
  assertRegistration(id: string | undefined, target: QueueTarget, owner: QueueSessionTarget, observerKind: CallbackLease['observerKind']): void {
    if (id === undefined) return
    const lease = this.store.lease(id)
    if (lease === undefined) return
    if (lease.bound || !sameOwner(lease.owner, owner) || targetKey(lease.target) !== targetKey(target) || lease.observerKind !== observerKind) throw new Error('Callback registration belongs to a different Chat, target, or execution')
  }
  async bind(item: QueueItem): Promise<void> {
    const lease = this.store.lease(item.id)
    if (lease === undefined) return
    if (!sameOwner(lease.owner, item.attention.primary) || targetKey(lease.target) !== targetKey(item.target) || lease.observerKind !== item.observer.kind) throw new Error('Callback binding does not match Queue ownership')
    this.store.bind(lease)
    if (this.accepting) await this.exclusive(async () => { await this.drain(item.id) })
  }
  private async drain(runId?: string): Promise<void> {
    for (const event of this.store.pending(runId)) {
      const lease = this.store.lease(event.runId)
      if (lease === undefined || !this.enabledFor(lease.target)) continue
      const item = await this.service.get(event.runId)
      if (item === undefined) continue
      if (!lease.bound) {
        if (!sameOwner(item.attention.primary, lease.owner) || targetKey(item.target) !== targetKey(lease.target) || item.observer.kind !== lease.observerKind) continue
        this.store.bind(lease)
      }
      const jobId = item.observer.kind === 'process' ? String(item.observer.handle.pid) : item.observer.jobId
      if (jobId === event.jobId) await this.service.receiveCallback(item.id,event)
      this.store.acknowledge(event)
    }
    await this.monitor.refresh()
  }
  async testPublic(): Promise<void> {
    if (!this.accepting) throw new Error('Enable the receiver before testing the public route')
    const origin = this.store.settings().publicOrigin
    const response = await fetch(`${origin}/queue/health`, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
    if (response.body === null) throw new Error('The public route returned an empty response')
    const reader = response.body.getReader()
    let text = ''
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 1_024) throw new Error('The public route returned an unexpected response')
        text += Buffer.from(chunk.value).toString('utf8')
      }
    } finally { await reader.cancel() }
    const body: unknown = JSON.parse(text)
    if (!response.ok || !z.object({ instance: z.literal(this.instance) }).safeParse(body).success) throw new Error('The public route did not reach this Host callback receiver')
    this.publicVerifiedAt = new Date().toISOString()
    this.error = undefined
  }
  private async reconcile(): Promise<void> {
    const settings = this.store.settings()
    if (this.closed) return
    if (!settings.publicOrigin || (settings.provider === 'cloudflare' && !settings.tunnelToken)) {
      this.error = 'Configure an HTTPS origin and credentials for the selected connection before the receiver can start.'
      return
    }
    this.error = undefined
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8_192 }, (req,res) => {
      void this.receive(req,res).catch(() => { if (!res.headersSent) res.writeHead(503); res.end() })
    })
    server.maxConnections = 32
    try {
      await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(settings.port,'127.0.0.1',resolve) })
      this.server = server
      this.accepting = true
      if (settings.provider === 'cloudflare') this.startConnector(settings)
    } catch {
      server.close()
      this.error = 'Callback port is unavailable. Choose a free port; Queue polling continues.'
    }
  }
  private startConnector(settings: WebhookSettings): void {
    if (this.closed || !this.accepting) return
    const child = spawn('cloudflared',['tunnel','--no-autoupdate','run'],{
      env: { ...process.env, TUNNEL_TOKEN: settings.tunnelToken }, stdio: 'ignore',
    })
    this.child = child
    const retry = () => {
      if (this.child !== child) return
      this.child = undefined
      this.error = 'Cloudflare connector stopped. Check cloudflared installation and Tunnel token. Reconnecting; Queue polling continues.'
      if (!this.closed && this.accepting) {
        this.retry = setTimeout(() => { this.retry = undefined; this.startConnector(this.store.settings()) }, Math.min(60_000,1_000*2**Math.min(this.reconnects++,6)))
        this.retry.unref()
      }
    }
    child.once('error',retry)
    child.once('exit',retry)
  }
  private async receive(req: IncomingMessage,res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control','no-store')
    if (!this.accepting || this.closed) { res.writeHead(503).end(); return }
    if (req.method === 'GET' && req.url === '/queue/health') {
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ instance: this.instance })); return
    }
    if (req.method !== 'POST' || req.url !== '/queue/events' || req.headers.origin !== undefined) { res.writeHead(404).end(); return }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415).end(); return }
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(req.headers.authorization ?? '')?.[1]
    if (bearer === undefined) { res.writeHead(401).end(); return }
    let text = ''
    let bytes = 0
    for await (const chunk of req) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 8_192) { res.writeHead(413).end(); req.destroy(); return }
      text += buffer.toString('utf8')
    }
    let event
    try { event = queueCallbackEventSchema.parse(JSON.parse(text)) } catch { res.writeHead(400).end(); return }
    const lease = this.store.lease(event.runId)
    if (lease === undefined || Date.parse(lease.expiresAt) < Date.now() || !timingSafeEqual(Buffer.from(lease.tokenHash,'hex'),Buffer.from(digest(bearer),'hex'))) { res.writeHead(401).end(); return }
    if (!this.enabledFor(lease.target)) { res.writeHead(403).end(); return }
    if (Date.parse(event.occurredAt)>Date.now()+300_000 || Date.parse(event.startedAt)>Date.parse(event.occurredAt)) { res.writeHead(400).end(); return }
    await this.exclusive(async () => {
      if (!this.accepting || !this.enabledFor(lease.target)) { res.writeHead(503).end(); return }
      const item = await this.service.get(event.runId)
      if (item !== undefined && (item.observer.kind === 'process' ? String(item.observer.handle.pid) : item.observer.jobId) !== event.jobId) { res.writeHead(409).end(); return }
      this.store.append(event)
      await this.drain(event.runId)
      this.lastEventAt = new Date().toISOString()
      res.writeHead(204).end()
    })
  }
  private async stopTransport(): Promise<void> {
    this.accepting = false
    this.publicVerifiedAt = undefined
    if (this.retry !== undefined) clearTimeout(this.retry)
    this.retry = undefined
    const child = this.child
    this.child = undefined
    if (child !== undefined) {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() },2_000)
        child.once('exit',() => { clearTimeout(timer); resolve() })
      })
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }
  async close(): Promise<void> {
    this.closed = true
    this.accepting = false
    await this.exclusive(async () => { await this.stopTransport(); if (this.ownsStore) this.store.close() })
  }
}

export function saveWebhookSettings(store: QueueWebhookStore, raw: unknown): void {
  const { expectedRevision, clearToken, tunnelToken, ...patch } = webhookUpdateSchema.parse(raw)
  const { enabled: _legacyEnabled, ...current } = store.settings()
  const next = webhookSettingsSchema.parse({ ...current, ...patch, publicOrigin: patch.publicOrigin.replace(/\/$/u, ''), tunnelToken: clearToken ? '' : tunnelToken || current.tunnelToken, revision: current.revision + 1 })
  store.saveSettings(next, expectedRevision)
}
