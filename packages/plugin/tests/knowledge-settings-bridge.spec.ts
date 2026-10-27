import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  KNOWLEDGE_SETTINGS_BRIDGE_PATH,
  serveKnowledgeSettingsBridge,
} from '../src/knowledge-settings-bridge.ts'

const authority = 'host.example.net:3080'
const nonce = 'abcdefghijklmnopqrstuvwxyz012345'

function request(method: 'GET' | 'PUT' | 'POST', body?: unknown, suppliedNonce = nonce): IncomingMessage {
  const input = new Readable({ read() {} }) as IncomingMessage
  input.method = method
  input.url = KNOWLEDGE_SETTINGS_BRIDGE_PATH
  input.headers = {
    host: authority,
    origin: `https://${authority}`,
    'sec-fetch-site': 'same-origin',
    'x-dsh-slop-csrf': suppliedNonce,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }
  input.socket = { remoteAddress: '127.0.0.1', localPort: 3080 } as Socket
  if (body !== undefined) {
    queueMicrotask(() => {
      input.push(Buffer.from(JSON.stringify(body)))
      input.push(null)
    })
  }
  return input
}

function response(): { readonly value: ServerResponse; readonly read: () => { readonly status?: number; readonly body: unknown } } {
  let status: number | undefined
  let body: unknown
  return {
    value: {
      writeHead(next: number) { status = next },
      end(value: string) { body = JSON.parse(value) as unknown },
    } as unknown as ServerResponse,
    read: () => ({ ...(status === undefined ? {} : { status }), body }),
  }
}

function service() {
  let revision = 3
  let homeRoot = '/Users/test/.slop/knowledge'
  const sources = [{
    kind: 'home' as const,
    root: homeRoot,
    state: 'ready' as const,
    documentCount: 2,
    indexedAt: '2026-09-02T12:00:00.000Z',
  }]
  return {
    getSettingsSourcesView: vi.fn(async () => ({
      schemaVersion: 1 as const,
      namespace: 'dsh-slop-knowledge' as const,
      revision,
      homeRoot,
      defaultHomeRoot: '/Users/test/.slop/knowledge',
      overridden: false,
      sources: sources.map(source => ({ ...source, root: homeRoot })),
    })),
    updateHomeRoot: vi.fn(async (input: { readonly homeRoot: string; readonly expectedRevision: number }) => {
      homeRoot = input.homeRoot
      revision += 1
    }),
    rebuildSettingsSourcesView: vi.fn(async () => ({
      schemaVersion: 1 as const,
      namespace: 'dsh-slop-knowledge' as const,
      revision,
      homeRoot,
      defaultHomeRoot: '/Users/test/.slop/knowledge',
      overridden: false,
      sources: sources.map(source => ({ ...source, root: homeRoot })),
    })),
  }
}

describe('Knowledge settings bridge', () => {
  it('returns the setting and source status through an admitted GET', async () => {
    const backend = service()
    const output = response()

    await serveKnowledgeSettingsBridge(request('GET'), output.value, nonce, backend, [authority])

    expect(output.read()).toMatchObject({
      status: 200,
      body: {
        schemaVersion: 1,
        namespace: 'dsh-slop-knowledge',
        revision: 3,
        homeRoot: '/Users/test/.slop/knowledge',
        sources: [{ kind: 'home', state: 'ready', documentCount: 2 }],
      },
    })
  })

  it('updates the Home root with optimistic concurrency and returns a fresh view', async () => {
    const backend = service()
    const output = response()

    await serveKnowledgeSettingsBridge(
      request('PUT', { homeRoot: '/shared/slop-knowledge', expectedRevision: 3 }),
      output.value,
      nonce,
      backend,
      [authority],
    )

    expect(backend.updateHomeRoot).toHaveBeenCalledWith({
      homeRoot: '/shared/slop-knowledge',
      expectedRevision: 3,
    })
    expect(output.read()).toMatchObject({ status: 200, body: { revision: 4, homeRoot: '/shared/slop-knowledge' } })
  })

  it('rebuilds through one closed action payload', async () => {
    const backend = service()
    const output = response()

    await serveKnowledgeSettingsBridge(request('POST', { action: 'rebuild' }), output.value, nonce, backend, [authority])

    expect(backend.rebuildSettingsSourcesView).toHaveBeenCalledOnce()
    expect(output.read().status).toBe(200)

    const invalid = response()
    await serveKnowledgeSettingsBridge(request('POST', { action: 'delete' }), invalid.value, nonce, backend, [authority])
    expect(invalid.read().status).toBe(400)
  })

  it('maps stale settings revisions without exposing an implementation stack', async () => {
    const backend = service()
    backend.updateHomeRoot.mockRejectedValueOnce(Object.assign(new Error('internal details'), {
      code: 'SETTINGS_CONFLICT',
      expected: 2,
      actual: 3,
    }))
    const output = response()

    await serveKnowledgeSettingsBridge(
      request('PUT', { homeRoot: '/shared/slop-knowledge', expectedRevision: 2 }),
      output.value,
      nonce,
      backend,
      [authority],
    )

    expect(output.read()).toEqual({
      status: 409,
      body: {
        error: 'Knowledge settings changed; reload and try again.',
        code: 'settings-conflict',
        expected: 2,
        actual: 3,
      },
    })
  })

  it('returns a bounded validation error for an invalid Home root', async () => {
    const backend = service()
    backend.updateHomeRoot.mockRejectedValueOnce(Object.assign(new Error('Knowledge root must be absolute.'), {
      code: 'KNOWLEDGE_INVALID_ARGUMENT',
    }))
    const output = response()

    await serveKnowledgeSettingsBridge(
      request('PUT', { homeRoot: 'relative/knowledge', expectedRevision: 3 }),
      output.value,
      nonce,
      backend,
      [authority],
    )

    expect(output.read()).toEqual({
      status: 400,
      body: {
        error: 'Knowledge root must be absolute.',
        code: 'knowledge-invalid-argument',
      },
    })
  })

  it('rejects missing admission and extra payload fields before mutation', async () => {
    const backend = service()
    const denied = response()
    await serveKnowledgeSettingsBridge(request('GET', undefined, 'wrong-nonce'), denied.value, nonce, backend, [authority])
    expect(denied.read().status).toBe(403)

    const invalid = response()
    await serveKnowledgeSettingsBridge(
      request('PUT', { homeRoot: '/shared/slop-knowledge', expectedRevision: 3, extra: true }),
      invalid.value,
      nonce,
      backend,
      [authority],
    )
    expect(invalid.read().status).toBe(400)
    expect(backend.updateHomeRoot).not.toHaveBeenCalled()
  })
})
