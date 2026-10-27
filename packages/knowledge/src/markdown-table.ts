import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { KnowledgeError } from './errors.js'

export interface KnowledgeTable {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

export const knowledgeTableSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    columns: { type: 'array', items: { type: 'string' }, required: true },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true },
  },
} satisfies ValueSchemaSpec

export function readKnowledgeTable(value: unknown): KnowledgeTable | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const columns: unknown = Reflect.get(value, 'columns')
  const rows: unknown = Reflect.get(value, 'rows')
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string')
  if (!strings(columns) || !Array.isArray(rows) || !rows.every(strings)) return undefined
  return { columns, rows }
}

/** Render structured rows once, without model-authored escaping or table code. */
export function renderKnowledgeTable(table: KnowledgeTable): string {
  const validCell = (cell: string): boolean => !/[\r\n\0]/u.test(cell) && Buffer.byteLength(cell, 'utf8') <= 2_048
  if (table.columns.length < 1 || table.columns.length > 16 || table.rows.length > 128
    || !table.columns.every(validCell)
    || table.rows.some(row => row.length !== table.columns.length || !row.every(validCell))) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ARGUMENT', 'Tables require 1-16 columns, at most 128 matching rows, and bounded single-line cells.')
  }
  const row = (cells: readonly string[]): string => `| ${cells.map(cell => cell.replaceAll('|', '\\|')).join(' | ')} |`
  return [row(table.columns), row(table.columns.map(() => '---')), ...table.rows.map(row)].join('\n')
}
