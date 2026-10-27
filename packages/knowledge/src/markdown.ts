import { basename, extname } from 'node:path'
import { parse } from 'yaml'
import type { KnowledgeHeading, ParsedKnowledgeDocument } from './types.js'

export const MAX_KNOWLEDGE_NAME_BYTES = 128
export const MAX_KNOWLEDGE_DESCRIPTION_BYTES = 1_024
export const MAX_KNOWLEDGE_TAGS = 16
export const MAX_KNOWLEDGE_TAG_BYTES = 64
export const MAX_KNOWLEDGE_HEADINGS = 512
export const MAX_KNOWLEDGE_HEADING_BYTES = 256
export const MAX_KNOWLEDGE_SNIPPET_BYTES = 512

interface FrontmatterBlock {
  readonly present: boolean
  readonly bodyOffset: number
  readonly value?: unknown
  readonly error?: string
}

interface RawHeading {
  readonly level: number
  readonly title: string
  readonly start: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  let end = maximumBytes
  while (end > 0) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))
    } catch {
      end -= 1
    }
  }
  return ''
}

function readStringField(
  value: Record<string, unknown>,
  key: string,
  maximumBytes: number,
  errors: string[],
): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.trim().length === 0) {
    errors.push(`Frontmatter field "${key}" must be a non-empty string.`)
    return undefined
  }
  const trimmed = field.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > maximumBytes) {
    errors.push(`Frontmatter field "${key}" exceeds ${maximumBytes} UTF-8 bytes and was truncated.`)
  }
  return truncateUtf8(trimmed, maximumBytes)
}

function readTags(value: Record<string, unknown>, errors: string[]): readonly string[] {
  const field = value.tags
  if (field === undefined) return []
  if (!Array.isArray(field)) {
    errors.push('Frontmatter field "tags" must be an array of non-empty strings.')
    return []
  }

  const tags: string[] = []
  if (field.length > MAX_KNOWLEDGE_TAGS) {
    errors.push(`Frontmatter field "tags" exceeds ${MAX_KNOWLEDGE_TAGS} entries and was truncated.`)
  }
  for (const item of field.slice(0, MAX_KNOWLEDGE_TAGS)) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push('Frontmatter field "tags" must be an array of non-empty strings.')
      return []
    }
    const trimmed = item.trim()
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_KNOWLEDGE_TAG_BYTES) {
      errors.push(
        `A frontmatter tag exceeds ${MAX_KNOWLEDGE_TAG_BYTES} UTF-8 bytes and was truncated.`,
      )
    }
    tags.push(truncateUtf8(trimmed, MAX_KNOWLEDGE_TAG_BYTES))
  }
  return tags
}

function extractFrontmatter(content: string): FrontmatterBlock {
  const opener = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/u.exec(content)
  if (opener === null) return { present: false, bodyOffset: 0 }

  const remainder = content.slice(opener[0].length)
  const closer = /^---[ \t]*(?:\r\n|\n|\r|$)/mu.exec(remainder)
  if (closer === null) {
    return {
      present: true,
      bodyOffset: 0,
      error: 'Frontmatter opening delimiter has no closing delimiter.',
    }
  }

  const yamlSource = remainder.slice(0, closer.index)
  const bodyOffset = opener[0].length + closer.index + closer[0].length
  try {
    const value: unknown = parse(yamlSource)
    return { present: true, bodyOffset, value }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      present: true,
      bodyOffset,
      error: `Frontmatter is not valid YAML: ${detail}`,
    }
  }
}

function rawHeadings(content: string, bodyOffset: number): readonly RawHeading[] {
  const headings: RawHeading[] = []
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/gu
  linePattern.lastIndex = bodyOffset
  let fenceCharacter: '`' | '~' | undefined
  let fenceLength = 0

  while (true) {
    const match = linePattern.exec(content)
    if (match === null || match[0].length === 0) break
    const line = match[0].replace(/(?:\r\n|\n|\r)$/u, '')
    const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    const marker = fence?.[1]
    if (marker !== undefined) {
      const character = marker[0]
      if (fenceCharacter === undefined && (character === '`' || character === '~')) {
        fenceCharacter = character
        fenceLength = marker.length
        continue
      }
      if (
        fenceCharacter !== undefined &&
        character === fenceCharacter &&
        marker.length >= fenceLength &&
        /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/u.test(line)
      ) {
        fenceCharacter = undefined
        fenceLength = 0
      }
      continue
    }
    if (fenceCharacter !== undefined) continue
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line)
    if (heading !== null) {
      const marks = heading[1]
      const title = heading[2]
      if (marks !== undefined && title !== undefined && title.trim().length > 0) {
        if (headings.length >= MAX_KNOWLEDGE_HEADINGS) continue
        headings.push({
          level: marks.length,
          title: truncateUtf8(title.trim(), MAX_KNOWLEDGE_HEADING_BYTES),
          start: match.index,
        })
      }
    }
  }
  return headings
}

function materializeHeadings(content: string, bodyOffset: number): readonly KnowledgeHeading[] {
  const raw = rawHeadings(content, bodyOffset)
  return raw.map((heading, index) => {
    let end = content.length
    for (let nextIndex = index + 1; nextIndex < raw.length; nextIndex += 1) {
      const next = raw[nextIndex]
      if (next !== undefined && next.level <= heading.level) {
        end = next.start
        break
      }
    }
    return { ...heading, end }
  })
}

function firstParagraph(body: string): string | undefined {
  const blocks = body.split(/(?:\r?\n|\r)[ \t]*(?:\r?\n|\r)/u)
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n|\r/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^#{1,6}(?:[ \t]+|$)/u.test(line))
    if (lines.length > 0) {
      return truncateUtf8(lines.join(' '), MAX_KNOWLEDGE_DESCRIPTION_BYTES)
    }
  }
  return undefined
}

function fallbackName(relativePath: string, headings: readonly KnowledgeHeading[]): string {
  const h1 = headings.find((heading) => heading.level === 1)
  if (h1 !== undefined) return truncateUtf8(h1.title, MAX_KNOWLEDGE_NAME_BYTES)
  const file = basename(relativePath)
  const extension = extname(file)
  return truncateUtf8(
    extension.length > 0 ? file.slice(0, -extension.length) : file,
    MAX_KNOWLEDGE_NAME_BYTES,
  )
}

export function parseMarkdownDocument(
  content: string,
  relativePath: string,
): ParsedKnowledgeDocument {
  const frontmatter = extractFrontmatter(content)
  const errors: string[] = []
  if (frontmatter.error !== undefined) errors.push(frontmatter.error)

  let frontmatterName: string | undefined
  let frontmatterDescription: string | undefined
  let tags: readonly string[] = []
  let frontmatterKeys: readonly string[] = []
  let frontmatterValues: Readonly<Record<string, unknown>> | undefined
  let knownFieldsValid = frontmatter.error === undefined

  if (frontmatter.value !== undefined) {
    if (!isPlainObject(frontmatter.value)) {
      errors.push('Frontmatter must be a YAML mapping.')
      knownFieldsValid = false
    } else {
      frontmatterValues = frontmatter.value
      frontmatterKeys = Object.keys(frontmatter.value)
      const errorCount = errors.length
      frontmatterName = readStringField(
        frontmatter.value,
        'name',
        MAX_KNOWLEDGE_NAME_BYTES,
        errors,
      )
      frontmatterDescription = readStringField(
        frontmatter.value,
        'description',
        MAX_KNOWLEDGE_DESCRIPTION_BYTES,
        errors,
      )
      tags = readTags(frontmatter.value, errors)
      if (errors.length !== errorCount) knownFieldsValid = false
    }
  } else if (frontmatter.present && frontmatter.error === undefined) {
    errors.push('Frontmatter must be a YAML mapping.')
    knownFieldsValid = false
  }

  const headings = materializeHeadings(content, frontmatter.bodyOffset)
  const body = content.slice(frontmatter.bodyOffset)
  const name = frontmatterName ?? fallbackName(relativePath, headings)
  const description = frontmatterDescription ?? firstParagraph(body) ?? ''
  const agentMetadataComplete =
    frontmatter.present &&
    knownFieldsValid &&
    frontmatterKeys.every((key) => key === 'name' || key === 'description' || key === 'tags') &&
    frontmatterName !== undefined &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(frontmatterName) &&
    frontmatterDescription !== undefined

  return {
    name,
    description,
    tags,
    headings,
    searchBody: body,
    frontmatterPresent: frontmatter.present,
    frontmatterKeys,
    ...(frontmatterValues === undefined ? {} : { frontmatterValues }),
    agentMetadataComplete,
    errors,
  }
}

export function selectMarkdownHeading(
  content: string,
  headings: readonly KnowledgeHeading[],
  requestedHeading: string,
): { readonly title: string; readonly content: string } | undefined {
  const normalized = requestedHeading.trim().toLocaleLowerCase()
  const heading = headings.find(
    (candidate) => candidate.title.trim().toLocaleLowerCase() === normalized,
  )
  if (heading === undefined) return undefined
  return {
    title: heading.title,
    content: content.slice(heading.start, heading.end).trimEnd(),
  }
}
