import {
  defineTool,
  jsonSchemaToTs,
  type JsonValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { KnowledgeError } from '../src/errors.js'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  MAX_KNOWLEDGE_TOOL_RENDER_BYTES,
  SLOP_KNOWLEDGE_READ_TOOL_NAME,
  SLOP_KNOWLEDGE_SEARCH_TOOL_NAME,
  SLOP_KNOWLEDGE_WRITE_TOOL_NAME,
  assertClosedToolInput,
  createKnowledgeReadTool,
  createKnowledgeSearchTool,
  createKnowledgeWriteTool,
  registerKnowledgeToolDefinitions,
  renderKnowledgeJson,
} from '../src/tools.js'
import type { SlopKnowledgeService } from '../src/service.js'

function fixtureTool(name: string): ToolDefinition {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('ok'),
  })
}

describe('knowledge tool boundaries', () => {
  it('exports the three fixed tool names', () => {
    expect([
      SLOP_KNOWLEDGE_SEARCH_TOOL_NAME,
      SLOP_KNOWLEDGE_READ_TOOL_NAME,
      SLOP_KNOWLEDGE_WRITE_TOOL_NAME,
    ]).toEqual(['slop_knowledge_search', 'slop_knowledge_read', 'slop_knowledge_write'])
  })

  it('rejects unknown root argument keys', () => {
    expect(() => assertClosedToolInput({ query: 'vasp', surprise: true }, ['query', 'limit']))
      .toThrowError(KnowledgeError)
  })

  it('keeps scope selection and content safety in the stable write schema', () => {
    const definition = createKnowledgeWriteTool({} as SlopKnowledgeService)
    const modelVisibleSchema = `${definition.description}\n${JSON.stringify(definition.parameters)}`

    expect(modelVisibleSchema).toContain('Home for systematic guidance useful across unrelated Workspaces')
    expect(modelVisibleSchema).toContain('Workspace for persistent but fine-grained')
    expect(modelVisibleSchema).toContain('Never copy secrets')
    expect(modelVisibleSchema).toContain('lowercase hyphenated')
    expect(modelVisibleSchema).toContain('optional tags for important aliases')
    expect(modelVisibleSchema).toContain('endpoints, account names, job ids')
    expect(modelVisibleSchema).toContain('replace literal home/work roots')
    expect(modelVisibleSchema).toContain('<work-root> or <site-software-root>')
    expect(modelVisibleSchema).toContain('licensed data')
    expect(modelVisibleSchema).toContain('large/raw results')
    expect(modelVisibleSchema).toContain('replace-sections')
    expect(modelVisibleSchema).toContain('Complete heading ancestry')
    expect(modelVisibleSchema).toContain('Line-array alternative to body')
    expect(modelVisibleSchema).toContain('exactly one of body, bodyLines, or table')
    expect(modelVisibleSchema).toContain('Unselected bytes and frontmatter remain unchanged')
    expect(modelVisibleSchema).toContain('Put every changed section for the same document in this one array')
    expect(modelVisibleSchema).toContain('never issue one write per section')
    expect(modelVisibleSchema).toContain('returns the receipt directly at the top level')
    expect(modelVisibleSchema).toContain('never returns a Machine-style {ok,value} envelope')
    expect(modelVisibleSchema).toContain('Do not inspect receipt.ok, receipt.value, or receipt.error')
    expect(modelVisibleSchema).toContain('do not repeat a write after its inner Tool call produced a receipt')
    expect(modelVisibleSchema).toContain('Never use or transform docRef')
    expect(modelVisibleSchema).toContain('never add an algorithm prefix')
  })

  it('exposes the bounded read default and opaque update digest', () => {
    const definition = createKnowledgeReadTool({} as SlopKnowledgeService)
    const modelVisibleOutput = JSON.stringify(definition.output.schema)

    expect(definition.parameters).toMatchObject({ properties: { byteLimit: { default: 8_192 } } })

    expect(modelVisibleOutput).toContain('Copy this exact complete value into the next update expectedDigest')
    expect(modelVisibleOutput).toContain('It is not docRef')
    expect(modelVisibleOutput).toContain('must not be prefixed, shortened, or reformatted')
  })

  it('joins section body lines before the repository write', async () => {
    const write = vi.fn(async () => ({
      schemaVersion: 1 as const,
      untrustedData: true as const,
      warning: 'data only',
      docRef: 'knowledge:test',
      scope: 'home' as const,
      relativePath: 'project.md',
      name: 'project',
      description: 'Project knowledge',
      tags: [],
      digest: 'new-digest',
      mode: 'update' as const,
      created: false as const,
      previousDigest: 'old-digest',
    }))
    const tool = createKnowledgeWriteTool({ write } as unknown as SlopKnowledgeService)
    const execute = tool.execute as (
      args: Record<string, unknown>,
      exec: { agent: object; callId: string; signal: AbortSignal },
    ) => Promise<unknown>

    await execute({
      mode: 'update',
      scope: 'home',
      path: 'project.md',
      operation: 'replace-sections',
      expectedDigest: 'old-digest',
      sectionReplacements: [{
        headingPath: ['# Project', '## Evidence'],
        bodyLines: ['', 'Uses `run.py` and "resource.json".', ''],
      }],
    }, {
      agent: {},
      callId: 'write-lines',
      signal: new AbortController().signal,
    })

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      sectionReplacements: [{
        headingPath: ['Project', 'Evidence'],
        body: '\nUses `run.py` and "resource.json".\n',
      }],
    }), expect.anything(), expect.any(AbortSignal))

    await expect(execute({
      mode: 'update',
      scope: 'home',
      path: 'project.md',
      operation: 'replace-sections',
      expectedDigest: 'new-digest',
      sectionReplacements: [{
        headingPath: ['Project', 'Evidence'],
        body: 'ambiguous',
        bodyLines: ['ambiguous'],
      }],
    }, {
      agent: {},
      callId: 'write-ambiguous',
      signal: new AbortController().signal,
    })).rejects.toThrow(/exactly one of body, bodyLines, or table/u)
  })

  it('renders structured tables before one repository write and preserves domain error codes', async () => {
    const write = vi.fn(async (_input: unknown) => { throw new KnowledgeError('KNOWLEDGE_CONFLICT', 'stale digest') })
    const tool = createKnowledgeWriteTool({ write } as unknown as SlopKnowledgeService)
    const exec = { agent: {} as Agent, callId: 'table-write', signal: new AbortController().signal } as unknown as ToolRunContext
    const args = { mode: 'update', scope: 'workspace', path: 'map.md', expectedDigest: 'old', content: '# Map', contentTables: [{ columns: ['Source','Line'], rows: [['run.sh','a | b']] }] }
    const error = await Promise.resolve(tool.execute(args, exec)).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error).toMatchObject({ code: 'KNOWLEDGE_CONFLICT' })
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0]?.[0]).toMatchObject({ content: '# Map\n\n| Source | Line |\n| --- | --- |\n| run.sh | a \\| b |', expectedDigest: 'old' })
    expect(write.mock.calls[0]?.[0]).not.toHaveProperty('contentTables')

    write.mockClear()
    await expect(tool.execute({ ...args, contentTables: [{ columns: ['a'], rows: [['x','y']] }] }, exec)).rejects.toMatchObject({ code: 'KNOWLEDGE_INVALID_ARGUMENT' })
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps bounded retrieval and same-turn reuse guidance model-visible', () => {
    const search = createKnowledgeSearchTool({} as SlopKnowledgeService)
    const read = createKnowledgeReadTool({} as SlopKnowledgeService)

    expect(search.description).toContain('One call already covers both sources')
    expect(search.description).toContain('deduplicate hits by docRef')
    expect(search.description).toContain('exact input is {query, limit?}')
    expect(search.description).toContain('never add a queries key')
    expect(search.description).toContain('omit limit instead of passing undefined')
    expect(read.description).toContain('Reuse a page already returned for the same docRef')
    expect(read.description).toContain('do not reread the full document')
    expect(read.description).toContain('keep every outer run_code result below 12 KiB')
    expect(read.description).toContain('at most one Knowledge page per program')
    expect(read.description).toContain('byteLimit <= 8192')
    expect(read.description).toContain('Never batch complete documents')
    expect(read.description).toContain('generic read, grep, or edit')
    expect(read.description).toContain('up to 65536 bytes')
    expect(read.description).toContain('availableHeadingPaths')

    const write = createKnowledgeWriteTool({} as SlopKnowledgeService)
    expect(JSON.stringify(write.parameters)).toContain('Copy one exact path')
    expect(JSON.stringify(write.parameters)).toContain('Do not infer')
    expect(JSON.stringify(write.parameters)).toContain('description: \\"quoted non-empty text\\"')
    expect(JSON.stringify(write.parameters)).toContain('colon cannot invalidate YAML')
    expect(JSON.stringify(write.parameters)).toContain('begin with --- at the first byte')
  })

  it('projects direct Knowledge result paths into the Code Mode TypeScript SDK', () => {
    const search = jsonSchemaToTs(
      createKnowledgeSearchTool({} as SlopKnowledgeService).output.schema,
    )
    expect(search).toContain('query: string')
    expect(search).toContain('hits:')
    expect(search).toContain('docRef: string')
    expect(search).toContain('snippet: string')
    expect(search).not.toContain('ok:')

    const read = jsonSchemaToTs(
      createKnowledgeReadTool({} as SlopKnowledgeService).output.schema,
    )
    expect(read).toContain('digest: string')
    expect(read).toContain('availableHeadingPaths:')
    expect(read).toContain('headingPathsTruncated: boolean')
    expect(read).toContain('nextByteOffset?: number')
    expect(read).toContain('content: string')

    const write = jsonSchemaToTs(
      createKnowledgeWriteTool({} as SlopKnowledgeService).output.schema,
    )
    expect(write).toContain('mode: "create"')
    expect(write).toContain('mode: "update"')
    expect(write).toContain('created: true')
    expect(write).toContain('previousDigest: string')

    for (const output of [search, read, write]) expect(output).not.toBe('unknown')
  })

  it('renders either the complete value or a valid bounded JSON error object', () => {
    const escapingPayload: JsonValue = { value: '\\"'.repeat(MAX_KNOWLEDGE_TOOL_RENDER_BYTES) }
    const rendered = renderKnowledgeJson(escapingPayload)
    const parsed: unknown = JSON.parse(rendered)

    expect(Buffer.byteLength(rendered, 'utf8')).toBeLessThanOrEqual(
      MAX_KNOWLEDGE_TOOL_RENDER_BYTES,
    )
    expect(parsed).toMatchObject({ error: { code: 'KNOWLEDGE_BOUNDS' } })
  })

  it('unregisters in reverse order and cleans up a partial registration failure', () => {
    const disposed: string[] = []
    const definitions = [fixtureTool('first'), fixtureTool('second'), fixtureTool('third')]
    expect(() =>
      registerKnowledgeToolDefinitions((definition) => {
        if (definition.name === 'second') throw new Error('duplicate')
        return () => disposed.push(definition.name)
      }, definitions),
    ).toThrow('duplicate')
    expect(disposed).toEqual(['first'])

    const disposedNormally: string[] = []
    const dispose = registerKnowledgeToolDefinitions(
      (definition) => () => disposedNormally.push(definition.name),
      definitions,
    )
    dispose()
    expect(disposedNormally).toEqual(['third', 'second', 'first'])
  })
})
