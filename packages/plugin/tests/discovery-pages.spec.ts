import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { DISCOVERY_CENSUS_COMMAND, compileDiscoveryProjectPage, discoveryFocus, parseDiscoveryCensus } from '../src/discovery-pages.ts'

describe('Host discovery pages', () => {
  it('accepts an empty census and does not infer completeness at the row cap', () => {
    expect(parseDiscoveryCensus('CENSUS|emitted=0|cap=64\n')).toEqual({ entries: [], complete: true })
    const stdout = Array.from({ length: 64 }, (_, index) => `entry${String(index)}|d`).join('\n') + '\nCENSUS|emitted=64|cap=64\n'
    const page = parseDiscoveryCensus(stdout)
    expect(page?.complete).toBe(false)
    expect(page?.entries).toHaveLength(64)
    expect(page?.entries[0]).toEqual({ entry: 'entry0', category: 'unclassified', evidenceTier: 'census' })
  })

  it('rejects incomplete, duplicate, or malformed census output', () => {
    for (const output of ['a|d\n', 'a|d\nCENSUS|emitted=2|cap=64', 'a|d\na|d\nCENSUS|emitted=2|cap=64', 'CENSUS|emitted=NaN|cap=64']) {
      expect(parseDiscoveryCensus(output)).toBeUndefined()
    }
  })

  it.skipIf(process.platform === 'win32')('compiles shell syntax safely for observed workstream names with quotes', () => {
    for (const command of [DISCOVERY_CENSUS_COMMAND, compileDiscoveryProjectPage(), compileDiscoveryProjectPage("./it's a [stage]; $x")]) {
      expect(() => execFileSync('/bin/bash', ['-n', '-c', command])).not.toThrow()
    }
    for (const focus of ['/outside', './a/../../b', './a\nb', './a\0b']) expect(discoveryFocus(focus)).toBeUndefined()
  })
})
