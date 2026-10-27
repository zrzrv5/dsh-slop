import { describe, expect, it } from 'vitest'
import { compileFtsQuery, KnowledgeCache } from '../src/cache.js'
import { createHomeSource } from '../src/source.js'
import type { IndexedKnowledgeDocument, ScannedKnowledgeSource } from '../src/types.js'

function indexedDocument(
  root: string,
  relativePath: string,
  name: string,
  tags: readonly string[],
  description: string,
  body: string,
): IndexedKnowledgeDocument {
  const source = createHomeSource(root)
  return {
    docRef: `knowledge:${name.padEnd(40, '0').slice(0, 40)}`,
    source,
    relativePath,
    digest: 'a'.repeat(64),
    name,
    description,
    tags,
    searchBody: body,
    headings: [{ level: 1, title: 'Scheduler details', start: 0, end: body.length }],
    sizeBytes: Buffer.byteLength(body, 'utf8'),
    mtimeMs: 1,
  }
}

describe('SQLite FTS knowledge cache', () => {
  it('builds a quoted bounded OR query for multi-term and quoted input', () => {
    expect(compileFtsQuery('diffusion "coefficient" recent')).toBe(
      '"diffusion coefficient recent" OR "diffusion" OR "coefficient" OR "recent"',
    )
    expect(compileFtsQuery('--- ""')).toBe('')
  })

  it('boosts an exact name above body-only matches and searches headings', () => {
    const cache = new KnowledgeCache()
    const source = createHomeSource('/tmp/knowledge-cache-test')
    const documents = [
      indexedDocument(source.root, 'body.md', 'other', [], 'Notes', 'Use vasp-eos here.'),
      indexedDocument(source.root, 'exact.md', 'vasp-eos', ['simulation'], 'Procedure', 'Body.'),
      indexedDocument(source.root, 'heading.md', 'queue', [], 'Notes', 'No matching body token.'),
    ]
    const scanned: ScannedKnowledgeSource = {
      source,
      documents,
      scannedBytes: documents.reduce((total, document) => total + document.sizeBytes, 0),
      scannedEntries: documents.length,
      scannedDirectories: 1,
      status: {
        kind: 'home',
        root: source.root,
        state: 'ready',
        documentCount: documents.length,
      },
    }
    cache.replaceAll([scanned])

    expect(cache.search('vasp-eos', [source.key], 10)[0]?.name).toBe('vasp-eos')
    expect(cache.search('Scheduler', [source.key], 10).map((hit) => hit.name)).toContain('queue')
    cache.close()
  })
})
