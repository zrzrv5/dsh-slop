import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginDataHome } from '../src/data-home.ts'

describe('plugin data home', () => {
  it('starts without shell configuration and follows a custom Harness home', () => {
    expect(pluginDataHome({})).toBe(join(homedir(), '.dsh', 'slop-plugin'))
    expect(pluginDataHome({ DSH_HOME: resolve('/tmp/harness-test') })).toBe(join(resolve('/tmp/harness-test'), 'slop-plugin'))
  })

  it('preserves explicit standalone and existing plugin data locations', () => {
    expect(pluginDataHome({ DSH_HOME: resolve('/tmp/harness-test'), DSH_SLOP_HOME: resolve('/tmp/slop-test') })).toBe(resolve('/tmp/slop-test'))
    expect(() => pluginDataHome({ DSH_SLOP_HOME: 'relative' })).toThrow('absolute')
    expect(() => pluginDataHome({ DSH_SLOP_HOME: '' })).toThrow('absolute')
  })
})
