import { describe, expect, it } from 'vitest'
import { renderKnowledgeTable } from '../src/markdown-table.js'

describe('Knowledge table rendering', () => {
  it('renders an empty table and escapes cell separators without interpreting Markdown as code', () => {
    expect(renderKnowledgeTable({ columns: ['Entry'], rows: [] })).toBe('| Entry |\n| --- |')
    expect(renderKnowledgeTable({ columns: ['Source', 'Line'], rows: [['run.sh', 'a | b; `${MODEL}`']] }))
      .toBe('| Source | Line |\n| --- | --- |\n| run.sh | a \\| b; `${MODEL}` |')
  })

  it('rejects mismatched rows and injected table lines', () => {
    for (const table of [{ columns: [], rows: [] }, { columns: ['a'], rows: [['a','b']] }, { columns: ['a'], rows: [['x\n| forged |']] }]) {
      expect(() => renderKnowledgeTable(table)).toThrow(/matching rows/u)
    }
  })
})
