import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  KnowledgeSettingsSourcesView,
  SlopKnowledgeService,
} from './index.js'
import { z } from 'zod'
import { admitLocalRequest, HttpAdmissionError, readJsonBody, writeJson } from '@dsh-slop/runtime-base/admission'

export const KNOWLEDGE_SETTINGS_BRIDGE_PATH = '/dsh-slop/knowledge-settings'

export type KnowledgeSettingsBridgeView = KnowledgeSettingsSourcesView

type KnowledgeSettingsService = Pick<
  SlopKnowledgeService,
  'getSettingsSourcesView' | 'updateHomeRoot' | 'rebuildSettingsSourcesView'
>

const updateSchema = z.object({
  homeRoot: z.string(),
  expectedRevision: z.number().int().nonnegative(),
}).strict()

const rebuildSchema = z.object({ action: z.literal('rebuild') }).strict()

async function currentView(service: KnowledgeSettingsService): Promise<KnowledgeSettingsBridgeView> {
  return service.getSettingsSourcesView()
}

function conflictDetails(error: unknown): { readonly expected: number; readonly actual: number } | undefined {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'SETTINGS_CONFLICT') return undefined
  if (!('expected' in error) || !('actual' in error)) return undefined
  if (typeof error.expected !== 'number' || typeof error.actual !== 'number') return undefined
  return { expected: error.expected, actual: error.actual }
}

function knowledgeRequestFailure(error: unknown): { readonly code: string; readonly message: string } | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined
  if (![
    'KNOWLEDGE_BOUNDS',
    'KNOWLEDGE_INVALID_ARGUMENT',
    'KNOWLEDGE_SECURITY',
  ].includes(error.code)) return undefined
  return { code: error.code.toLowerCase().replaceAll('_', '-'), message: error.message }
}

/** Serve only the Knowledge path setting and index controls after browser admission succeeds. */
export async function serveKnowledgeSettingsBridge(
  request: IncomingMessage,
  response: ServerResponse,
  nonce: string,
  service: KnowledgeSettingsService,
  trustedHosts: readonly string[] = [],
): Promise<void> {
  try {
    admitLocalRequest(request, nonce, true, trustedHosts)
    if (new URL(request.url ?? KNOWLEDGE_SETTINGS_BRIDGE_PATH, 'http://localhost').search !== '') {
      throw new HttpAdmissionError(400, 'query parameters are not allowed')
    }

    if (request.method === 'GET') {
      writeJson(response, 200, await currentView(service))
      return
    }
    if (request.method === 'PUT') {
      const input = updateSchema.safeParse(await readJsonBody(request, 'PUT'))
      if (!input.success) throw new HttpAdmissionError(400, 'invalid Knowledge settings update')
      await service.updateHomeRoot(input.data)
      writeJson(response, 200, await currentView(service))
      return
    }
    if (request.method === 'POST') {
      const input = rebuildSchema.safeParse(await readJsonBody(request))
      if (!input.success) throw new HttpAdmissionError(400, 'invalid Knowledge action')
      writeJson(response, 200, await service.rebuildSettingsSourcesView())
      return
    }
    throw new HttpAdmissionError(405, 'GET, PUT, or POST required')
  } catch (error) {
    const conflict = conflictDetails(error)
    if (conflict !== undefined) {
      writeJson(response, 409, {
        error: 'Knowledge settings changed; reload and try again.',
        code: 'settings-conflict',
        ...conflict,
      })
      return
    }
    const requestFailure = knowledgeRequestFailure(error)
    if (requestFailure !== undefined) {
      writeJson(response, 400, { error: requestFailure.message, code: requestFailure.code })
      return
    }
    if (error instanceof HttpAdmissionError) {
      writeJson(response, error.status, { error: error.message })
      return
    }
    writeJson(response, 500, { error: 'Knowledge settings operation failed.' })
  }
}
