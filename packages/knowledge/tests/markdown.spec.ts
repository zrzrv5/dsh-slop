import { describe, expect, it } from 'vitest'
import {
  MAX_KNOWLEDGE_DESCRIPTION_BYTES,
  MAX_KNOWLEDGE_HEADING_BYTES,
  MAX_KNOWLEDGE_NAME_BYTES,
  parseMarkdownDocument,
  selectMarkdownHeading,
} from '../src/markdown.js'

describe('Markdown knowledge parsing', () => {
  it('indexes headerless user Markdown with H1 and first-paragraph fallbacks', () => {
    const parsed = parseMarkdownDocument(
      '# VASP workflow\n\nUse the cluster module and the shared PAW directory.\n\n## Submit\nText.',
      'software/vasp.md',
    )

    expect(parsed.name).toBe('VASP workflow')
    expect(parsed.description).toBe('Use the cluster module and the shared PAW directory.')
    expect(parsed.tags).toEqual([])
    expect(parsed.agentMetadataComplete).toBe(false)
  })

  it('reads known frontmatter while leaving unknown keys out of derived metadata', () => {
    const content = [
      '---',
      'name: vasp-eos',
      'description: Production EOS procedure',
      'tags: [vasp, eos]',
      'schedulerHints:',
      '  partition: cpu',
      '---',
      '# Procedure',
      'Keep the unknown key in the source bytes.',
    ].join('\n')
    const parsed = parseMarkdownDocument(content, 'vasp.md')

    expect(parsed).toMatchObject({
      name: 'vasp-eos',
      description: 'Production EOS procedure',
      tags: ['vasp', 'eos'],
      agentMetadataComplete: false,
    })
    expect(content).toContain('schedulerHints:')
  })

  it('rejects non-slug agent names without preventing legacy indexing', () => {
    const parsed = parseMarkdownDocument(
      '---\nname: VASP EOS\ndescription: Legacy title\n---\nBody',
      'legacy.md',
    )

    expect(parsed.name).toBe('VASP EOS')
    expect(parsed.agentMetadataComplete).toBe(false)
  })

  it('ignores heading-like lines inside fenced code blocks', () => {
    const content = [
      '# Real heading',
      'before',
      '```bash',
      '# shell comment',
      '```',
      '## Real child',
      'after',
    ].join('\n')
    const parsed = parseMarkdownDocument(content, 'fences.md')

    expect(parsed.headings.map((heading) => heading.title)).toEqual([
      'Real heading',
      'Real child',
    ])
    expect(selectMarkdownHeading(content, parsed.headings, 'shell comment')).toBeUndefined()
  })

  it('bounds all derived text fields by UTF-8 bytes', () => {
    const long = '界'.repeat(2_000)
    const parsed = parseMarkdownDocument(
      `---\nname: ${long}\ndescription: ${long}\n---\n# ${long}\nBody`,
      'bounded.md',
    )

    expect(Buffer.byteLength(parsed.name, 'utf8')).toBeLessThanOrEqual(MAX_KNOWLEDGE_NAME_BYTES)
    expect(Buffer.byteLength(parsed.description, 'utf8')).toBeLessThanOrEqual(
      MAX_KNOWLEDGE_DESCRIPTION_BYTES,
    )
    expect(Buffer.byteLength(parsed.headings[0]?.title ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_KNOWLEDGE_HEADING_BYTES,
    )
    expect(parsed.agentMetadataComplete).toBe(false)
  })
})
