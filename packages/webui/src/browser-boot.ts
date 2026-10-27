import { displayHostPath } from './host-path.ts'

const BROWSER_BOOTSTRAP_PATH = '/dsh-slop/browser-bootstrap'
const KNOWLEDGE_SETTINGS_BRIDGE_PATH = '/dsh-slop/knowledge-settings'
const QUEUE_SETTINGS_BRIDGE_PATH = '/dsh-slop/queue-settings'

export interface BrowserBootConfig {
  readonly bundledSkillRoot?: string
  readonly csrfNonce: string
  readonly browserBootstrapPath: typeof BROWSER_BOOTSTRAP_PATH
  readonly knowledgeSettingsBridgePath: typeof KNOWLEDGE_SETTINGS_BRIDGE_PATH
  readonly queueSettingsBridgePath: typeof QUEUE_SETTINGS_BRIDGE_PATH
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeBrowserBoot(value: unknown): BrowserBootConfig | undefined {
  if (!isRecord(value) || typeof value.csrfNonce !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/u.test(value.csrfNonce)) return undefined
  if (value.browserBootstrapPath !== BROWSER_BOOTSTRAP_PATH) return undefined
  if (value.knowledgeSettingsBridgePath !== KNOWLEDGE_SETTINGS_BRIDGE_PATH) return undefined
  if (value.queueSettingsBridgePath !== QUEUE_SETTINGS_BRIDGE_PATH) return undefined
  return {
    ...(typeof value.bundledSkillRoot === 'string' && displayHostPath(value.bundledSkillRoot) !== undefined ? { bundledSkillRoot: value.bundledSkillRoot.replace(/[\\/]$/u, '') } : {}),
    csrfNonce: value.csrfNonce,
    browserBootstrapPath: BROWSER_BOOTSTRAP_PATH,
    knowledgeSettingsBridgePath: KNOWLEDGE_SETTINGS_BRIDGE_PATH,
    queueSettingsBridgePath: QUEUE_SETTINGS_BRIDGE_PATH,
  }
}

export function browserBoot(): BrowserBootConfig | undefined {
  return decodeBrowserBoot((globalThis as { __DSH_SLOP_BOOT__?: unknown }).__DSH_SLOP_BOOT__)
}

let refreshing: Promise<BrowserBootConfig | undefined> | undefined

/** Reload the complete same-origin carrier configuration after a Host restart. */
export async function refreshBrowserBoot(): Promise<BrowserBootConfig | undefined> {
  if (refreshing !== undefined) return refreshing
  refreshing = (async () => {
    if (typeof fetch !== 'function') return undefined
    try {
      const response = await fetch(BROWSER_BOOTSTRAP_PATH, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (!response.ok) return undefined
      const boot = decodeBrowserBoot(await response.json())
      if (boot === undefined) return undefined
      ;(globalThis as { __DSH_SLOP_BOOT__?: BrowserBootConfig }).__DSH_SLOP_BOOT__ = boot
      return boot
    } catch {
      return undefined
    }
  })().finally(() => { refreshing = undefined })
  return refreshing
}

export function browserWebSocketUrl(path: `/dsh-slop/${string}`): string {
  const location = globalThis.location
  if (location === undefined) return path
  // RC2 Desktop supplies the Host origin and adds its cookie + same-origin
  // headers to this WebSocket. Never send the nonce to a page-derived host.
  if (location.protocol === 'dsh-app:') {
    const transport: unknown = Reflect.get(globalThis, '__DSH_TRANSPORT__')
    if (!isRecord(transport) || typeof transport.streamBaseUrl !== 'string') {
      throw new Error('DeepSeek Harness Desktop transport is unavailable.')
    }
    const host = new URL(transport.streamBaseUrl)
    if (host.protocol !== 'http:' || host.hostname !== '127.0.0.1' || host.username !== '' || host.password !== '' || host.pathname !== '/' || host.search !== '' || host.hash !== '') {
      throw new Error('DeepSeek Harness Desktop transport must use its loopback Host.')
    }
    return `ws://${host.host}${path}`
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${path}`
}

export function browserWebSocketProtocol(boot: BrowserBootConfig): string {
  return `dsh-slop.v1.${boot.csrfNonce}`
}
