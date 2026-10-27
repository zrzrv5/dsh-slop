import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  describeNextCheck,
  isTerminalState,
  queuePurposeSchema,
  type QueueItem,
  type QueueMonitor,
  type QueueService,
  type QueueSettingsPatch,
} from '@dsh-slop/queue'
import { z } from 'zod'
import { admitLocalRequest, HttpAdmissionError, readJsonBody, writeJson } from './admission.ts'

export const QUEUE_SETTINGS_BRIDGE_PATH = '/dsh-slop/queue-settings'

type QueueSettingsService = Pick<QueueService, 'settings' | 'updateSettings' | 'list' | 'update' | 'probeNow' | 'deliveries'>

const chatRefreshSchema = z.object({
  scope: z.literal('chat-refresh'),
  sessionId: z.string().min(1).max(256),
  id: z.string().min(1).max(128),
}).strict()

async function continuationView(service: QueueSettingsService, item: QueueItem) {
  const records = (await service.deliveries(item.id)).filter(record => record.target.sessionId === item.attention.primary.sessionId && record.trigger.event === 'state-change')
  const latest = records.at(-1)
  const deliveryStatus = item.callback?.terminalPending || item.verificationPending ? 'awaiting-verification'
    : latest?.lastError ? 'failed'
    : latest?.receipt ?? (latest?.state === 'delivered' ? 'consumed' : latest ? 'pending' : isTerminalState(item.state) ? 'no-pending-delivery' : 'waiting-for-job')
  return { purpose: item.purpose, continuation: item.continuation, delivery: item.attention.primaryDelivery, deliveryStatus, deliveryError: latest?.lastError }
}

async function chatView(service: QueueSettingsService, sessionId: string) {
  const items = (await service.list()).filter(item => belongsToChat(item, sessionId))
  return { schemaVersion: 1, sessionId, items: await Promise.all(items.map(async item => ({
    ...await continuationView(service, item),
    id: item.id, label: item.label, state: item.state, target: item.target,
    observerId: item.observer.kind === 'process' ? String(item.observer.handle.pid) : item.observer.jobId,
    observerKind: item.observer.kind,
    relation: item.attention.primary.sessionId === sessionId ? 'owned' : 'subscribed',
    observedAt: item.lastObservation?.observedAt,
    elapsedSeconds: item.lastObservation?.elapsedSeconds,
    evidence: item.lastObservation?.evidence,
    nextCheckAt: item.nextCheckAt,
    checkError: item.lastCheckError?.message,
    observationSource: item.lastObservation?.source,
    startedAt: item.startedAt,
    phase: item.phase,
    awaitingVerification: item.callback?.terminalPending === true || item.verificationPending === true,
  }))) }
}

function belongsToChat(item: Awaited<ReturnType<QueueSettingsService['list']>>[number], sessionId: string): boolean {
  return item.attention.primary.sessionId === sessionId
    || item.attention.subscriptions.some(subscription => subscription.target.sessionId === sessionId)
}

function latestCheckAt(observationAt?: string, errorAt?: string): string | undefined {
  if (observationAt === undefined) return errorAt
  if (errorAt === undefined) return observationAt
  return Date.parse(observationAt) >= Date.parse(errorAt) ? observationAt : errorAt
}

const globalUpdateSchema = z.object({
  scope: z.literal('global'),
  expectedRevision: z.number().int().positive(),
  patch: z.object({
    profile: z.enum(['normal', 'economy', 'custom']).optional(),
    initialCheckSeconds: z.number().int().min(60).optional(),
    automaticMinimumSeconds: z.number().int().min(60).optional(),
    stableMinimumSeconds: z.number().int().min(60).optional(),
    startupWindowSeconds: z.number().int().min(60).optional(),
    startupIntervalSeconds: z.number().int().min(60).optional(),
    walltimeDivisor: z.number().int().min(1).max(100).optional(),
    durationMaximumSeconds: z.number().int().min(60).optional(),
    maximumDetectionDelaySeconds: z.number().int().min(60).optional(),
    queuedMaximumSeconds: z.number().int().min(60).optional(),
    fallbackEnabled: z.boolean().optional(),
    defaultDelivery: z.enum(['wake', 'notify']).optional(),
    defaultConditions: z.array(z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'any-state-change'])).min(1).optional(),
  }).strict(),
}).strict()

const itemUpdateSchema = z.object({
  scope: z.literal('item'),
  id: z.string().min(1).max(128),
  expectedRevision: z.number().int().positive(),
  userIntervalSeconds: z.number().int().min(60).nullable(),
  purpose: queuePurposeSchema.optional(),
  continuation: z.string().trim().min(1).max(4_096).optional(),
}).strict()

async function currentView(service: QueueSettingsService): Promise<unknown> {
  const [settings, items] = await Promise.all([service.settings(), service.list()])
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1_000
  const recent = items.filter(item => Date.parse(item.updatedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))
  return {
    schemaVersion: 1,
    settings,
    items: await Promise.all(recent.map(async item => ({
      ...await continuationView(service, item),
      id: item.id,
      label: item.label,
      state: item.state,
      observerKind: item.observer.kind,
      observerId: item.observer.kind === 'process' ? String(item.observer.handle.pid) : item.observer.jobId,
      updatedAt: item.updatedAt,
      target: item.target,
      revision: item.revision,
      intervalSource: item.monitoring.userIntervalSeconds === undefined ? 'global' : 'item',
      observationSource: item.lastObservation?.source,
      userIntervalSeconds: item.monitoring.userIntervalSeconds,
      delivery: item.attention.primaryDelivery,
      lastCheckAt: latestCheckAt(item.lastObservation?.observedAt, item.lastCheckError?.at),
      lastCheckError: item.lastCheckError?.message,
      nextCheckAt: item.nextCheckAt,
      nextCheckReason: describeNextCheck(item, settings),
      consecutiveFailures: item.consecutiveFailures,
      timing: {
        expectedDurationSeconds: item.monitoring.expectedDurationSeconds,
        walltimeSeconds: item.lastObservation?.walltimeSeconds,
        walltimeRemainingSeconds: item.lastObservation?.walltimeRemainingSeconds,
        startedAt: item.startedAt,
        elapsedSeconds: item.lastObservation?.elapsedSeconds,
        expectedRemainingSeconds: item.lastObservation?.expectedRemainingSeconds,
      },
      phase: item.phase,
      awaitingVerification: item.callback?.terminalPending === true,
    }))),
  }
}

/** Same-origin Queue policy and per-item override bridge. */
export async function serveQueueSettingsBridge(
  request: IncomingMessage,
  response: ServerResponse,
  nonce: string,
  service: QueueSettingsService,
  monitor: Pick<QueueMonitor, 'refresh'>,
  trustedHosts: readonly string[] = [],
): Promise<void> {
  try {
    admitLocalRequest(request, nonce, true, trustedHosts)
    const url = new URL(request.url ?? QUEUE_SETTINGS_BRIDGE_PATH, 'http://localhost')
    if (request.method === 'GET' && url.searchParams.get('view') === 'chat') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 256 || [...url.searchParams.keys()].length !== 2) {
        throw new HttpAdmissionError(400, 'one Chat sessionId is required')
      }
      writeJson(response, 200, await chatView(service, sessionId))
      return
    }
    if (url.search !== '') {
      throw new HttpAdmissionError(400, 'query parameters are not allowed')
    }
    if (request.method === 'GET') {
      writeJson(response, 200, await currentView(service))
      return
    }
    if (request.method !== 'PUT') throw new HttpAdmissionError(405, 'GET or PUT required')
    const raw = await readJsonBody(request, 'PUT')
    const refresh = chatRefreshSchema.safeParse(raw)
    if (refresh.success) {
      const current = (await service.list()).find(item => item.id === refresh.data.id && belongsToChat(item, refresh.data.sessionId))
      if (current === undefined) throw new HttpAdmissionError(404, 'Queue item not found in this Chat')
      await service.probeNow(current.id)
      await monitor.refresh()
      writeJson(response, 200, await chatView(service, refresh.data.sessionId))
      return
    }
    const global = globalUpdateSchema.safeParse(raw)
    if (global.success) {
      await service.updateSettings(global.data.patch as QueueSettingsPatch, global.data.expectedRevision)
      await monitor.refresh()
      writeJson(response, 200, await currentView(service))
      return
    }
    const item = itemUpdateSchema.safeParse(raw)
    if (!item.success) throw new HttpAdmissionError(400, 'invalid Queue settings update')
    const current = (await service.list()).find((entry) => entry.id === item.data.id)
    if (current === undefined) throw new HttpAdmissionError(404, 'Queue item not found')
    await service.update(item.data.id, {
      monitoring: {
        ...current.monitoring,
        ...(item.data.userIntervalSeconds === null
          ? { userIntervalSeconds: undefined }
          : { userIntervalSeconds: item.data.userIntervalSeconds }),
      },
      ...(item.data.purpose === undefined ? {} : { purpose: item.data.purpose }),
      ...(item.data.continuation === undefined ? {} : { continuation: item.data.continuation }),
    }, item.data.expectedRevision)
    await monitor.refresh()
    writeJson(response, 200, await currentView(service))
  } catch (error) {
    if (error instanceof HttpAdmissionError) {
      writeJson(response, error.status, { error: error.message })
      return
    }
    writeJson(response, 400, { error: error instanceof Error ? error.message : 'Queue settings operation failed.' })
  }
}
