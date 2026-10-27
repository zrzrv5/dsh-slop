import type { IncomingMessage, ServerResponse } from 'node:http'
import { admitLocalRequest, HttpAdmissionError, writeJson } from './admission.ts'
import { KNOWLEDGE_SETTINGS_BRIDGE_PATH } from './knowledge-settings-bridge.ts'
import { QUEUE_SETTINGS_BRIDGE_PATH } from './queue-settings-bridge.ts'

export const BROWSER_BOOTSTRAP_PATH = '/dsh-slop/browser-bootstrap'

export interface BrowserBootstrap {
  readonly bundledSkillRoot?: string
  readonly csrfNonce: string
  readonly browserBootstrapPath: typeof BROWSER_BOOTSTRAP_PATH
  readonly knowledgeSettingsBridgePath: typeof KNOWLEDGE_SETTINGS_BRIDGE_PATH
  readonly queueSettingsBridgePath: typeof QUEUE_SETTINGS_BRIDGE_PATH
}

export function browserBootstrap(nonce: string): BrowserBootstrap {
  return {
    ...(process.env.DSH_BUNDLED_SKILL_DIR === undefined ? {} : { bundledSkillRoot: process.env.DSH_BUNDLED_SKILL_DIR.replace(/\/$/u, '') }),
    csrfNonce: nonce,
    browserBootstrapPath: BROWSER_BOOTSTRAP_PATH,
    knowledgeSettingsBridgePath: KNOWLEDGE_SETTINGS_BRIDGE_PATH,
    queueSettingsBridgePath: QUEUE_SETTINGS_BRIDGE_PATH,
  }
}

/** Return the current public browser carrier configuration through the same loopback trust fence. */
export function serveBrowserBootstrap(request: IncomingMessage, response: ServerResponse, nonce: string, trustedHosts: readonly string[] = []): void {
  try {
    admitLocalRequest(request, nonce, false, trustedHosts)
    if (request.method !== 'GET') throw new HttpAdmissionError(405, 'GET required')
    if (new URL(request.url ?? BROWSER_BOOTSTRAP_PATH, 'http://localhost').search !== '') {
      throw new HttpAdmissionError(400, 'query parameters are not allowed')
    }
    writeJson(response, 200, browserBootstrap(nonce))
  } catch (error) {
    if (!(error instanceof HttpAdmissionError)) throw error
    writeJson(response, error.status, { error: error.message })
  }
}
