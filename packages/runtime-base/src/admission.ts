import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const JSON_MEDIA_TYPE = 'application/json'
const MAX_DECISION_BYTES = 8 * 1024

/** Error returned only to the local browser carrier, never to a model. */
export class HttpAdmissionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpAdmissionError'
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') return true
  const octets = normalized.split('.').map(value => Number(value))
  return octets.length === 4
    && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && octets[0] === 127
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

function parseCanonicalHttpAuthority(authority: string): URL {
  if (
    authority.length === 0
    || authority.trim() !== authority
    || /[/\\@?#]/u.test(authority)
  ) {
    throw new HttpAdmissionError(403, 'invalid host header')
  }
  try {
    const parsed = new URL(`http://${authority}`)
    if (
      parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.host.toLowerCase() !== authority.toLowerCase()
    ) {
      throw new HttpAdmissionError(403, 'invalid host header')
    }
    return parsed
  } catch (error) {
    if (error instanceof HttpAdmissionError) throw error
    throw new HttpAdmissionError(403, 'invalid host header')
  }
}

function trustedHostMatches(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some(authority => {
    if (authority.trim() !== authority || /[/@?#]/.test(authority)) return false
    try {
      const configured = new URL(`https://${authority}`)
      if (configured.username !== '' || configured.password !== '' || configured.pathname !== '/' || configured.search !== '' || configured.hash !== '') return false
      if (configured.host.toLowerCase() !== authority.toLowerCase()) return false
      return configured.port === ''
        ? configured.hostname === hostUrl.hostname
        : configured.host === hostUrl.host
    } catch {
      return false
    }
  })
}

function equalToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

function normalizedPort(port: string, protocol: 'http:' | 'https:'): string {
  if ((protocol === 'http:' && port === '80') || (protocol === 'https:' && port === '443')) return ''
  return port
}

/**
 * Enforce the loopback-proxy, exact-authority, same-origin, and per-boot nonce fence.
 * @param request - raw request accepted by DSH's WebServer.
 * @param nonce - unguessable boot nonce injected into the same-origin page.
 * @param requireNonce - whether the exact nonce header is mandatory.
 * @param trustedHosts - exact HTTPS authorities already admitted by DSH's browser trust fence.
 */
export function admitLocalRequest(
  request: IncomingMessage,
  nonce: string,
  requireNonce = true,
  trustedHosts: readonly string[] = [],
): void {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new HttpAdmissionError(403, 'loopback client required')
  }
  const host = request.headers.host
  if (host === undefined) throw new HttpAdmissionError(403, 'host header required')
  const hostUrl = parseCanonicalHttpAuthority(host)
  const loopbackHost = isLoopbackHostname(hostUrl.hostname)
  if (!loopbackHost && !trustedHostMatches(hostUrl, trustedHosts)) throw new HttpAdmissionError(403, 'trusted host required')
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpAdmissionError(403, 'cross-site request refused')
  }
  const origin = request.headers.origin
  if (origin !== undefined) {
    let originUrl: URL
    try {
      originUrl = new URL(origin)
    } catch {
      throw new HttpAdmissionError(403, 'invalid origin')
    }
    const expectedProtocol = loopbackHost ? 'http:' : 'https:'
    if (
      originUrl.protocol !== expectedProtocol
      || originUrl.hostname !== hostUrl.hostname
      || originUrl.port !== normalizedPort(hostUrl.port, expectedProtocol)
    ) {
      throw new HttpAdmissionError(403, 'same origin required')
    }
  }
  const suppliedNonce = request.headers['x-dsh-slop-csrf']
  if (requireNonce && !equalToken(typeof suppliedNonce === 'string' ? suppliedNonce : undefined, nonce)) {
    throw new HttpAdmissionError(403, 'invalid request nonce')
  }
}

/** Read and parse one bounded JSON request body for one exact mutation method. */
export async function readJsonBody(
  request: IncomingMessage,
  requiredMethod: 'POST' | 'PUT' = 'POST',
): Promise<unknown> {
  if (request.method !== requiredMethod) throw new HttpAdmissionError(405, `${requiredMethod} required`)
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== JSON_MEDIA_TYPE) {
    throw new HttpAdmissionError(415, 'application/json required')
  }
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_DECISION_BYTES)) {
    throw new HttpAdmissionError(413, 'request body too large')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > MAX_DECISION_BYTES) throw new HttpAdmissionError(413, 'request body too large')
    chunks.push(bytes)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpAdmissionError(400, 'invalid JSON body')
  }
}

/** Write one no-store JSON response with defensive browser headers. */
export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}
