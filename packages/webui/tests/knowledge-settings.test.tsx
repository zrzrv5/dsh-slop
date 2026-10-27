// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DirectoryListing } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeSettings, type KnowledgeSettingsView } from '../src/KnowledgeSettings.tsx'

const KNOWLEDGE_PATH = '/dsh-slop/knowledge-settings'
const INITIAL_NONCE = 'abcdefghijklmnopqrstuvwxyz012345'

const readyView: KnowledgeSettingsView = {
  schemaVersion: 1,
  namespace: 'dsh-slop-knowledge',
  revision: 0,
  homeRoot: '/Users/test/.slop/knowledge',
  defaultHomeRoot: '/Users/test/.slop/knowledge',
  overridden: false,
  sources: [
    {
      kind: 'home',
      root: '/Users/test/.slop/knowledge',
      state: 'ready',
      documentCount: 4,
      indexedAt: '2026-09-02T12:00:00.000Z',
    },
    {
      kind: 'workspace',
      workspaceId: 'workspace-alloy-eos',
      workspaceTitle: 'Alloy EOS',
      workspacePath: '/Users/test/projects/alloy-eos',
      root: '/Users/test/projects/alloy-eos/.dsh/knowledge',
      state: 'ready',
      documentCount: 3,
      indexedAt: '2026-09-02T12:00:00.000Z',
    },
  ],
}

function boot(nonce = INITIAL_NONCE): Record<string, string> {
  return {
    csrfNonce: nonce,
    browserBootstrapPath: '/dsh-slop/browser-bootstrap',
    knowledgeSettingsBridgePath: KNOWLEDGE_PATH,
    queueSettingsBridgePath: '/dsh-slop/queue-settings',
  }
}

function jsonResponse(value: unknown, status = 200): Pick<Response, 'json' | 'ok' | 'status'> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('__DSH_SLOP_BOOT__', boot())
})

describe('Knowledge settings', () => {
  it('loads through the relative same-origin bridge on a local WebUI', async () => {
    const fetch = vi.fn(async () => jsonResponse(readyView))
    vi.stubGlobal('fetch', fetch)

    render(<KnowledgeSettings />)

    expect(await screen.findByRole('heading', { name: 'Home Knowledge' })).toBeDefined()
    expect(screen.getByText('Alloy EOS')).toBeDefined()
    expect(screen.getByText('/Users/test/projects/alloy-eos/.dsh/knowledge')).toBeDefined()
    expect(screen.queryByText('/Users/test/projects/alloy-eos')).toBeNull()
    expect(fetch).toHaveBeenCalledWith(KNOWLEDGE_PATH, expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'x-dsh-slop-csrf': INITIAL_NONCE }),
    }))
  })

  it('refreshes stale authorization once while keeping a trusted remote request same-origin', async () => {
    const freshNonce = 'fresh-knowledge-nonce-123456'
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/dsh-slop/browser-bootstrap') return jsonResponse(boot(freshNonce))
      const nonce = new Headers(init?.headers).get('x-dsh-slop-csrf')
      return nonce === freshNonce ? jsonResponse(readyView) : jsonResponse({ error: 'invalid request nonce' }, 403)
    })
    vi.stubGlobal('fetch', fetch)

    render(<KnowledgeSettings compact />)

    expect(await screen.findByText('Alloy EOS')).toBeDefined()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[0]?.[0]).toBe(KNOWLEDGE_PATH)
    expect(fetch.mock.calls[1]?.[0]).toBe('/dsh-slop/browser-bootstrap')
    expect(fetch.mock.calls[2]?.[0]).toBe(KNOWLEDGE_PATH)
    expect(fetch.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      credentials: 'same-origin',
      headers: expect.objectContaining({ 'x-dsh-slop-csrf': freshNonce }),
    }))
  })

  it('saves the edited home root with compare-and-swap revision', async () => {
    const updated = { ...readyView, revision: 1, homeRoot: '/Volumes/knowledge', overridden: true }
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'PUT' ? jsonResponse(updated) : jsonResponse(readyView))
    vi.stubGlobal('fetch', fetch)

    render(<KnowledgeSettings />)
    const input = await screen.findByRole('textbox', { name: 'Home root' })
    fireEvent.change(input, { target: { value: '  /Volumes/knowledge  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(KNOWLEDGE_PATH, expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-dsh-slop-csrf': INITIAL_NONCE,
        }),
        body: JSON.stringify({ homeRoot: '/Volumes/knowledge', expectedRevision: 0 }),
      }))
    })
    expect(screen.getByDisplayValue('/Volumes/knowledge')).toBeDefined()
  })

  it('requests an index rebuild and renders the returned view', async () => {
    const rebuilt = {
      ...readyView,
      revision: 1,
      sources: readyView.sources.map(source => ({ ...source, documentCount: source.documentCount + 1 })),
    }
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? jsonResponse(rebuilt) : jsonResponse(readyView))
    vi.stubGlobal('fetch', fetch)

    render(<KnowledgeSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rebuild index' }))

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(KNOWLEDGE_PATH, expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'rebuild' }),
      }))
    })
    expect(await screen.findByText('9 documents across 2 sources.')).toBeDefined()
  })

  it('browses host directories and copies the chosen path into the form', async () => {
    const homeListing: DirectoryListing = {
      path: '/Users/test/.slop/knowledge',
      home: '/Users/test',
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'test', path: '/Users/test', hidden: false },
        { name: 'knowledge', path: '/Users/test/.slop/knowledge', hidden: false },
      ],
      entries: [{ name: 'projects', path: '/Users/test/.slop/knowledge/projects', hidden: false }],
      truncated: false,
    }
    const projectsListing: DirectoryListing = {
      ...homeListing,
      path: '/Users/test/.slop/knowledge/projects',
      crumbs: [...homeListing.crumbs, { name: 'projects', path: '/Users/test/.slop/knowledge/projects', hidden: false }],
      entries: [],
    }
    const listDirectory = vi.fn(async (path?: string) => path === projectsListing.path ? projectsListing : homeListing)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(readyView)))

    render(<KnowledgeSettings listDirectory={listDirectory} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }))

    await waitFor(() => { expect(listDirectory).toHaveBeenCalledWith('/Users/test/.slop/knowledge', expect.any(AbortSignal)) })
    fireEvent.click(await screen.findByRole('button', { name: 'projects' }))
    await waitFor(() => { expect(listDirectory).toHaveBeenCalledWith('/Users/test/.slop/knowledge/projects', expect.any(AbortSignal)) })
    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))

    expect(screen.getByDisplayValue('/Users/test/.slop/knowledge/projects')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it('can recover the browser at Host home when the configured root is missing', async () => {
    const homeListing: DirectoryListing = {
      path: '/Users/test',
      home: '/Users/test',
      crumbs: [
        { name: '/', path: '/', hidden: false },
        { name: 'test', path: '/Users/test', hidden: false },
      ],
      entries: [],
      truncated: false,
    }
    const listDirectory = vi.fn(async (path?: string) => {
      if (path !== undefined) throw new Error('directory-unreadable')
      return homeListing
    })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...readyView,
      sources: [{ kind: 'home', root: readyView.homeRoot, state: 'missing', documentCount: 0 }],
    })))

    render(<KnowledgeSettings listDirectory={listDirectory} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Browse host home' }))

    expect(await screen.findByText('/Users/test')).toBeDefined()
    expect(listDirectory).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal))
  })
})
