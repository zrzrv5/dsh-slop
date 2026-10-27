import { describe, expect, it } from 'vitest'
import { BEHAVIOR_PREAMBLE, BEHAVIOR_PRESETS, BEHAVIOR_TRAITS, DEFAULT_BEHAVIOR_LEVELS, matchingBehaviorPreset, renderBehaviorPrompt } from '../src/behavior-catalog.ts'

describe('Agent behavior catalog', () => {
  it('gives every trait a default level among its own levels', () => {
    for (const trait of BEHAVIOR_TRAITS) expect(trait.levels.map(level => level.id)).toContain(trait.defaultLevel)
  })

  it('builds every preset from existing levels and matches Balanced to the defaults', () => {
    for (const preset of BEHAVIOR_PRESETS) {
      for (const trait of BEHAVIOR_TRAITS) expect(trait.levels.map(level => level.id)).toContain(preset.levels[trait.id])
    }
    expect(matchingBehaviorPreset(DEFAULT_BEHAVIOR_LEVELS)?.id).toBe('balanced')
    expect(matchingBehaviorPreset({ ...DEFAULT_BEHAVIOR_LEVELS, reporting: 'detailed' })).toBeUndefined()
  })

  it('renders the preamble and then one paragraph per trait in catalog order', () => {
    const paragraphs = renderBehaviorPrompt(DEFAULT_BEHAVIOR_LEVELS).split('\n')
    expect(paragraphs).toEqual([
      BEHAVIOR_PREAMBLE,
      ...BEHAVIOR_TRAITS.map(trait => trait.levels.find(level => level.id === trait.defaultLevel)?.text),
    ])
  })
})
