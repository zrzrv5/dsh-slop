import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as KnowledgePlugin from '../src/index.js'
import {
  SLOP_KNOWLEDGE_READ_TOOL_NAME,
  SLOP_KNOWLEDGE_SEARCH_TOOL_NAME,
  SLOP_KNOWLEDGE_WRITE_TOOL_NAME,
} from '../src/tools.js'

class EmptyWorkspaceRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  list(): readonly [] {
    return []
  }

  resolveByPath(_path: string): Promise<undefined> {
    return Promise.resolve(undefined)
  }
}

class MemorySettings extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  configure(): () => void { return () => {} }
  describe(): readonly [{ ns: string; autoGenerate: boolean; schema: object; value: { homeRoot: string }; revision: number; user: object; applies: 'live' }] {
    return [{ ns: 'dsh-slop-knowledge', autoGenerate: false, schema: {}, value: { homeRoot: '/tmp/dsh-slop-knowledge' }, revision: 0, user: {}, applies: 'live' }]
  }
  update(): Promise<void> { return Promise.resolve() }
  mutate(): Promise<void> { return Promise.resolve() }
}

class RecordingTools extends Service {
  readonly definitions = new Map<string, ToolDefinition>()
  readonly disposed: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: ToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      this.definitions.delete(definition.name)
      this.disposed.push(definition.name)
    }
  }
}

describe('Knowledge Cordis plugin', () => {
  it('registers tools from the service-owning child fiber and cleans them up', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(EmptyWorkspaceRegistry)
    await ctx.plugin(RecordingTools)

    const fiber = await ctx.plugin(KnowledgePlugin, { homeRoot: '/tmp/dsh-slop-knowledge' })
    const tools = ctx.tools as unknown as RecordingTools

    expect([...tools.definitions.keys()].sort()).toEqual([
      SLOP_KNOWLEDGE_READ_TOOL_NAME,
      SLOP_KNOWLEDGE_SEARCH_TOOL_NAME,
      SLOP_KNOWLEDGE_WRITE_TOOL_NAME,
    ])

    await fiber.dispose()
    expect(tools.definitions.size).toBe(0)
    expect(tools.disposed).toEqual([
      SLOP_KNOWLEDGE_WRITE_TOOL_NAME,
      SLOP_KNOWLEDGE_READ_TOOL_NAME,
      SLOP_KNOWLEDGE_SEARCH_TOOL_NAME,
    ])
    await ctx.fiber.dispose()
  })
})
