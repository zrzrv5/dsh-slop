import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeError } from '../src/errors.js'
import { MAX_AGENT_WRITE_BYTES, MAX_DOCUMENT_BYTES } from '../src/fs-safety.js'
import { KnowledgeRepository } from '../src/repository.js'
import {
  createHomeSource,
  createWorkspaceSource,
  documentDigest,
  scanKnowledgeSource,
} from '../src/source.js'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-slop-knowledge-'))
  const canonical = await realpath(created)
  temporaryRoots.push(canonical)
  return canonical
}

function agentMarkdown(name: string, description: string, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'tags: [test, workflow]',
    '---',
    body,
  ].join('\n')
}

async function expectKnowledgeError(
  promise: Promise<unknown>,
  code: KnowledgeError['code'],
): Promise<void> {
  try {
    await promise
    throw new Error(`Expected ${code}.`)
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeError)
    if (error instanceof KnowledgeError) expect(error.code).toBe(code)
  }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('KnowledgeRepository', () => {
  it('synchronizes external Markdown edits on every search', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const path = join(root, 'vasp.md')
    await writeFile(path, '# VASP setup\n\nLoad alphamoduletoken before running.', 'utf8')
    const repository = new KnowledgeRepository()

    const initial = await repository.search({ query: 'alphamoduletoken' }, [source])
    expect(initial.hits).toHaveLength(1)
    expect(initial.hits[0]?.name).toBe('VASP setup')

    await writeFile(path, '# VASP setup\n\nLoad betamoduletoken before running.', 'utf8')
    expect((await repository.search({ query: 'betamoduletoken' }, [source])).hits).toHaveLength(1)
    expect((await repository.search({ query: 'alphamoduletoken' }, [source])).hits).toHaveLength(0)
    await repository.close()
  })

  it('finds a Chinese body phrase from a longer natural-language request', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    await writeFile(
      join(root, 'diffusion.md'),
      '# 扩散分析\n\n这个脚本用于计算最近轨迹的扩散系数。',
      'utf8',
    )
    const repository = new KnowledgeRepository()

    const result = await repository.search(
      { query: '算下最近跑的几个的扩散系数' },
      [source],
    )

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({ name: '扩散分析', relativePath: 'diffusion.md' })
    await repository.close()
  })

  it('retrieves one logical project through each constituent alias', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    await writeFile(
      join(root, 'shared-campaign.md'),
      [
        '---',
        'name: shared-campaign',
        'description: Treat CampaignAlpha and CampaignBeta as one logical project when comparing or reusing their workflows.',
        'tags: [SharedCampaign, CampaignAlpha, CampaignBeta]',
        '---',
        '# Shared campaign',
        '',
        'This user-defined logical project spans two physical roots without moving either directory.',
      ].join('\n'),
      'utf8',
    )
    const repository = new KnowledgeRepository()

    for (const query of ['SharedCampaign', 'CampaignAlpha', 'CampaignBeta']) {
      const result = await repository.search({ query }, [source])
      expect(result.hits[0]).toMatchObject({ name: 'shared-campaign', relativePath: 'shared-campaign.md' })
    }
    await repository.close()
  })

  it('retrieves from Home and current Workspace fairly before merging', async () => {
    const homeRoot = await temporaryRoot()
    const workspacePath = await temporaryRoot()
    const home = createHomeSource(homeRoot)
    const workspace = createWorkspaceSource({
      workspaceId: 'workspace-one',
      workspaceTitle: 'One',
      workspacePath,
    })
    await mkdir(workspace.root, { recursive: true })
    await writeFile(join(home.root, 'home.md'), '# Home\n\nshared-token home', 'utf8')
    await writeFile(join(workspace.root, 'workspace.md'), '# Workspace\n\nshared-token local', 'utf8')
    const repository = new KnowledgeRepository()

    const result = await repository.search({ query: 'shared-token', limit: 2 }, [home, workspace])
    expect(new Set(result.hits.map((hit) => hit.scope))).toEqual(new Set(['home', 'workspace']))
    await repository.close()
  })

  it('ranks an exact Workspace name above a weak Home body match at limit one', async () => {
    const homeRoot = await temporaryRoot()
    const workspacePath = await temporaryRoot()
    const home = createHomeSource(homeRoot)
    const workspace = createWorkspaceSource({
      workspaceId: 'workspace-rank',
      workspaceTitle: 'Rank',
      workspacePath,
    })
    await mkdir(workspace.root, { recursive: true })
    await writeFile(join(home.root, 'weak.md'), '# Notes\n\nUse exact-target eventually.', 'utf8')
    await writeFile(
      join(workspace.root, 'exact.md'),
      '---\nname: exact-target\ndescription: Exact local procedure\n---\nBody',
      'utf8',
    )
    const repository = new KnowledgeRepository()

    const result = await repository.search({ query: 'exact-target', limit: 1 }, [home, workspace])
    expect(result.hits[0]).toMatchObject({ scope: 'workspace', name: 'exact-target' })
    await repository.close()
  })

  it('does not index YAML frontmatter values as searchable body text', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    await writeFile(
      join(root, 'frontmatter.md'),
      [
        '---',
        'name: ordinary-doc',
        'description: Ordinary description',
        'legacySecret: frontmattersecretxyz',
        '---',
        'Nothing relevant in the body.',
      ].join('\n'),
      'utf8',
    )
    const repository = new KnowledgeRepository()

    expect((await repository.search({ query: 'frontmattersecretxyz' }, [source])).hits)
      .toHaveLength(0)
    await repository.close()
  })

  it('paginates reads by bounded UTF-8 byte offsets without stalling', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    await writeFile(join(root, 'emoji.md'), '😀xyz', 'utf8')
    const repository = new KnowledgeRepository()
    const hit = (await repository.search({ query: 'xyz' }, [source])).hits[0]
    expect(hit).toBeDefined()
    if (hit === undefined) throw new Error('Expected search hit.')

    const first = await repository.read(
      { docRef: hit.docRef, byteOffset: 0, byteLimit: 4 },
      [source],
    )
    expect(first.content).toBe('😀')
    expect(first.availableHeadingPaths).toEqual([])
    expect(first.headingPathsTruncated).toBe(false)
    expect(first.page.nextByteOffset).toBe(4)
    const nextByteOffset = first.page.nextByteOffset
    if (nextByteOffset === undefined) throw new Error('Expected another UTF-8 page.')
    const second = await repository.read(
      { docRef: hit.docRef, byteOffset: nextByteOffset, byteLimit: 4 },
      [source],
    )
    expect(second.content).toBe('xyz')
    expect(second.page.nextByteOffset).toBeUndefined()
    await repository.close()
  })

  it('defaults long documents to an 8 KiB page with an exact continuation', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const body = `# Long method\n${'x'.repeat(10_000)}`
    await writeFile(join(root, 'long-method.md'), body, 'utf8')
    const repository = new KnowledgeRepository()
    const hit = (await repository.search({ query: 'Long method' }, [source])).hits[0]
    if (hit === undefined) throw new Error('Expected method document.')
    const first = await repository.read({ docRef: hit.docRef }, [source])
    expect(Buffer.byteLength(first.content, 'utf8')).toBe(8192)
    expect(first.page.nextByteOffset).toBe(8192)
    const second = await repository.read({ docRef: hit.docRef, byteOffset: first.page.nextByteOffset }, [source])
    expect(first.content + second.content).toBe(body)
    expect(second.digest).toBe(first.digest)
    await repository.close()
  })

  it('returns exact bounded heading paths for section updates', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    await writeFile(
      join(root, 'headings.md'),
      [
        '# Project `A`',
        'intro',
        '## Evidence',
        'evidence',
        '### Silicon EOS family',
        'details',
        '## Unknowns',
        'unknown',
      ].join('\n'),
      'utf8',
    )
    const repository = new KnowledgeRepository()
    const hit = (await repository.search({ query: 'Silicon EOS family' }, [source])).hits[0]
    expect(hit).toBeDefined()
    if (hit === undefined) throw new Error('Expected search hit.')

    const result = await repository.read({ docRef: hit.docRef }, [source])
    expect(result.availableHeadingPaths).toEqual([
      ['Project `A`'],
      ['Project `A`', 'Evidence'],
      ['Project `A`', 'Evidence', 'Silicon EOS family'],
      ['Project `A`', 'Unknowns'],
    ])
    expect(result.headingPathsTruncated).toBe(false)
    await repository.close()
  })

  it('implements create-only and digest-guarded update receipts while preserving file mode', async () => {
    const parent = await temporaryRoot()
    const root = join(parent, 'knowledge')
    const source = createHomeSource(root)
    const repository = new KnowledgeRepository()
    const firstContent = agentMarkdown('vasp-eos', 'EOS procedure', '# Steps\nFirst')

    const created = await repository.write(
      { mode: 'create', scope: 'home', path: 'software/vasp.md', content: firstContent },
      source,
    )
    expect(created).toMatchObject({ mode: 'create', created: true, name: 'vasp-eos' })
    await expectKnowledgeError(
      repository.write(
        { mode: 'create', scope: 'home', path: 'software/vasp.md', content: firstContent },
        source,
      ),
      'KNOWLEDGE_CONFLICT',
    )

    const target = join(root, 'software', 'vasp.md')
    await chmod(target, 0o640)
    const secondContent = agentMarkdown('vasp-eos', 'Updated EOS procedure', '# Steps\nSecond')
    const updated = await repository.write(
      {
        mode: 'update',
        scope: 'home',
        path: 'software/vasp.md',
        content: secondContent,
        expectedDigest: documentDigest(firstContent),
      },
      source,
    )
    expect(updated).toMatchObject({
      mode: 'update',
      created: false,
      previousDigest: documentDigest(firstContent),
      digest: documentDigest(secondContent),
    })
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o640)
    expect(await readFile(target, 'utf8')).toBe(secondContent)

    try {
      await repository.write(
        {
          mode: 'update',
          scope: 'home',
          path: 'software/vasp.md',
          content: firstContent,
          expectedDigest: documentDigest(firstContent),
        },
        source,
      )
      throw new Error('Expected stale update conflict.')
    } catch (error) {
      expect(error).toBeInstanceOf(KnowledgeError)
      if (error instanceof KnowledgeError) {
        expect(error.code).toBe('KNOWLEDGE_CONFLICT')
        expect(error.details).toEqual({ currentDigest: documentDigest(secondContent) })
      }
    }
    await repository.close()
  })

  it('atomically replaces unique Markdown section bodies without changing other bytes', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const initial = [
      '---',
      'name: shared-campaign',
      'description: Logical project evidence',
      'userField:',
      '  keep: exact',
      '---',
      '# Shared campaign',
      '',
      'Shared introduction.',
      '',
      '## Project evidence',
      '',
      '### CampaignAlpha',
      '',
      'Old alpha evidence.',
      '',
      '### CampaignBeta',
      '',
      'Old beta evidence.',
      '',
      '## Submission recipes',
      '',
      '### CampaignAlpha',
      '',
      'Keep this repeated leaf title unchanged.',
      '',
      '## Unrelated',
      '',
      'Preserve this final section byte-for-byte.',
      '',
    ].join('\r\n')
    await writeFile(join(root, 'shared-campaign.md'), initial, 'utf8')
    const repository = new KnowledgeRepository()

    const result = await repository.write(
      {
        mode: 'update',
        operation: 'replace-sections',
        scope: 'home',
        path: 'shared-campaign.md',
        expectedDigest: documentDigest(initial),
        sectionReplacements: [
          {
            headingPath: ['Shared campaign', 'Project evidence', 'CampaignAlpha'],
            body: '\r\nNew alpha evidence with `inline code`.\r\n',
          },
          {
            headingPath: ['Shared campaign', 'Project evidence', 'CampaignBeta'],
            body: '\r\nNew beta evidence with ${MODEL} as literal Markdown.\r\n',
          },
        ],
      },
      source,
    )

    const updated = await readFile(join(root, 'shared-campaign.md'), 'utf8')
    expect(result).toMatchObject({
      mode: 'update',
      created: false,
      previousDigest: documentDigest(initial),
      digest: documentDigest(updated),
    })
    expect(updated).toContain('userField:\r\n  keep: exact')
    expect(updated).toContain('### CampaignAlpha\r\n\r\nNew alpha evidence with `inline code`.')
    expect(updated).toContain('New beta evidence with ${MODEL} as literal Markdown.')
    expect(updated).toContain('Keep this repeated leaf title unchanged.')
    expect(updated).toContain('## Unrelated\r\n\r\nPreserve this final section byte-for-byte.')
    const originalTail = initial.slice(initial.indexOf('## Submission recipes'))
    const updatedTail = updated.slice(updated.indexOf('## Submission recipes'))
    expect(updatedTail).toBe(originalTail)
    expect(updated).not.toContain('Old alpha evidence.')
    expect(updated).not.toContain('Old beta evidence.')
    await repository.close()
  })

  it('rejects invalid, ambiguous, duplicate, overlapping, and oversized section replacements', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const initial = [
      '# Root',
      'intro',
      '## Parent',
      'parent body',
      '### Child',
      'first child',
      '## Parent',
      'second parent',
      '### Child',
      'second child',
      '## Unique Parent',
      'unique parent',
      '### Unique Child',
      'unique child',
    ].join('\n')
    await writeFile(join(root, 'sections.md'), initial, 'utf8')
    const repository = new KnowledgeRepository()
    const update = (
      sectionReplacements: readonly {
        readonly headingPath: readonly string[]
        readonly body: string
      }[],
    ) => repository.write(
      {
        mode: 'update',
        operation: 'replace-sections',
        scope: 'home',
        path: 'sections.md',
        expectedDigest: documentDigest(initial),
        sectionReplacements,
      },
      source,
    )

    await expectKnowledgeError(
      update([{ headingPath: [], body: 'no target' }]),
      'KNOWLEDGE_INVALID_ARGUMENT',
    )
    await expectKnowledgeError(
      update([{ headingPath: ['Root', 'Missing'], body: 'no target' }]),
      'KNOWLEDGE_NOT_FOUND',
    )
    await expectKnowledgeError(
      update([{ headingPath: ['Root', 'Parent'], body: 'ambiguous' }]),
      'KNOWLEDGE_INVALID_ARGUMENT',
    )

    const unique = ['Root', 'Unique Parent', 'Unique Child']
    await expectKnowledgeError(
      update([
        { headingPath: unique, body: 'one' },
        { headingPath: unique, body: 'two' },
      ]),
      'KNOWLEDGE_INVALID_ARGUMENT',
    )
    await expectKnowledgeError(
      update([
        { headingPath: ['Root', 'Unique Parent'], body: 'parent' },
        { headingPath: unique, body: 'child' },
      ]),
      'KNOWLEDGE_INVALID_ARGUMENT',
    )
    await expectKnowledgeError(
      update([{ headingPath: ['Root'], body: 'x'.repeat(MAX_AGENT_WRITE_BYTES + 1) }]),
      'KNOWLEDGE_BOUNDS',
    )
    expect(await readFile(join(root, 'sections.md'), 'utf8')).toBe(initial)
    await repository.close()
  })

  it('limits the final document size for section replacements', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const initial = '# Root\n' + 'x'.repeat(MAX_DOCUMENT_BYTES - 80) + '\n## Target\nold\n'
    await writeFile(join(root, 'large.md'), initial, 'utf8')
    const repository = new KnowledgeRepository()

    await expectKnowledgeError(
      repository.write(
        {
          mode: 'update',
          operation: 'replace-sections',
          scope: 'home',
          path: 'large.md',
          expectedDigest: documentDigest(initial),
          sectionReplacements: [
            { headingPath: ['Root', 'Target'], body: 'y'.repeat(128) },
          ],
        },
        source,
      ),
      'KNOWLEDGE_BOUNDS',
    )
    expect(await readFile(join(root, 'large.md'), 'utf8')).toBe(initial)
    await repository.close()
  })

  it('preserves deep unknown frontmatter values on updates and rejects changes', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const path = join(root, 'legacy.md')
    const initial = [
      '---',
      'name: legacy-doc',
      'description: User-authored document',
      'schedulerHints:',
      '  partition: cpu',
      '  modules: [vasp, mpi]',
      '__proto__:',
      '  guard: one',
      '---',
      'Old body',
    ].join('\n')
    await writeFile(path, initial, 'utf8')
    const repository = new KnowledgeRepository()
    const preserved = initial.replace('Old body', 'New body')
    await repository.write(
      {
        mode: 'update',
        scope: 'home',
        path: 'legacy.md',
        content: preserved,
        expectedDigest: documentDigest(initial),
      },
      source,
    )

    const changedUnknown = preserved.replace('partition: cpu', 'partition: gpu')
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'update',
          scope: 'home',
          path: 'legacy.md',
          content: changedUnknown,
          expectedDigest: documentDigest(preserved),
        },
        source,
      ),
      'KNOWLEDGE_INVALID_MARKDOWN',
    )
    const changedPrototypeKey = preserved.replace('guard: one', 'guard: two')
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'update',
          scope: 'home',
          path: 'legacy.md',
          content: changedPrototypeKey,
          expectedDigest: documentDigest(preserved),
        },
        source,
      ),
      'KNOWLEDGE_INVALID_MARKDOWN',
    )
    const addedUnknown = preserved.replace('---\nNew body', 'newKey: no\n---\nNew body')
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'update',
          scope: 'home',
          path: 'legacy.md',
          content: addedUnknown,
          expectedDigest: documentDigest(preserved),
        },
        source,
      ),
      'KNOWLEDGE_INVALID_MARKDOWN',
    )
    expect(await readFile(path, 'utf8')).toBe(preserved)
    await repository.close()
  })

  it('does not create parent directories for a missing update', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const repository = new KnowledgeRepository()
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'update',
          scope: 'home',
          path: 'absent/deep.md',
          content: '# legacy update',
          expectedDigest: 'a'.repeat(64),
        },
        source,
      ),
      'KNOWLEDGE_CONFLICT',
    )
    await expect(access(join(root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    await repository.close()
  })

  it('rejects invalid create metadata, traversal, filesystem roots, and closed access', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const repository = new KnowledgeRepository()
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'create',
          scope: 'home',
          path: 'bad.md',
          content: '---\nname: Bad Name\ndescription: test\n---\nBody',
        },
        source,
      ),
      'KNOWLEDGE_INVALID_MARKDOWN',
    )
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'create',
          scope: 'home',
          path: 'too-large.md',
          content: agentMarkdown(
            'too-large',
            'Agent write cap',
            'x'.repeat(MAX_AGENT_WRITE_BYTES),
          ),
        },
        source,
      ),
      'KNOWLEDGE_BOUNDS',
    )
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'create',
          scope: 'home',
          path: 'unknown.md',
          content: '---\nname: valid-name\ndescription: test\nunknown: no\n---\nBody',
        },
        source,
      ),
      'KNOWLEDGE_INVALID_MARKDOWN',
    )
    await expectKnowledgeError(
      repository.write(
        {
          mode: 'create',
          scope: 'home',
          path: '../escape.md',
          content: agentMarkdown('escape', 'No escape', 'Body'),
        },
        source,
      ),
      'KNOWLEDGE_SECURITY',
    )
    expect(() => createHomeSource('/')).toThrowError(KnowledgeError)
    await repository.close()
    await expectKnowledgeError(repository.search({ query: 'test' }, [source]), 'KNOWLEDGE_INVALID_ARGUMENT')
  })

  it('skips symlinks, invalid UTF-8, and oversized Markdown while indexing safe peers', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    await writeFile(join(root, 'safe.md'), '# Safe\n\nfind-safe-peer', 'utf8')
    await writeFile(join(root, 'invalid.md'), Buffer.from([0xff, 0xfe]))
    await writeFile(join(root, 'oversized.md'), Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61))
    if (process.platform === 'win32') {
      const outside = await temporaryRoot()
      await writeFile(join(outside, 'hidden.md'), '# Must not be indexed')
      await symlink(outside, join(root, 'linked-directory'), 'junction')
    } else {
      await symlink(join(root, 'safe.md'), join(root, 'link.md'))
    }

    const scanned = await scanKnowledgeSource(source)
    expect(scanned.documents.map((document) => document.relativePath)).toEqual(['safe.md'])
    expect(scanned.status.state).toBe('error')
    expect(scanned.status.documentCount).toBe(1)
    if (scanned.status.state === 'error') {
      expect(scanned.status.error).toContain('Skipped')
    }
  })

  it('keeps maximum search output under a fixed serialized budget', async () => {
    const root = await temporaryRoot()
    const source = createHomeSource(root)
    const long = 'x'.repeat(8_000)
    for (let index = 0; index < 20; index += 1) {
      await writeFile(
        join(root, `doc-${index}.md`),
        `---\nname: ${long}\ndescription: ${long}\ntags: [${long}]\n---\ncommon-budget-token`,
        'utf8',
      )
    }
    const repository = new KnowledgeRepository()
    const result = await repository.search({ query: 'common-budget-token', limit: 20 }, [source])

    expect(result.hits).toHaveLength(20)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(160_000)
    await repository.close()
  })
})
