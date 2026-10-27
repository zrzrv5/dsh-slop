import { describe, expect, it } from 'vitest'
import { marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index'
import { publishedPluginIndex } from '../scripts/plugin-market.mjs'

const manifest = {
  name: 'dsh-slop', version: '0.0.13', description: 'Machine, Knowledge and Queue.',
  dsh: { bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '0.2.1-rc.3' },
  dist: { integrity: 'sha512-fixture' },
}
const metadata = { name: 'dsh-slop', versions: { '0.0.13': manifest }, time: { '0.0.13': '2026-10-17T00:00:00Z' } }

describe('published plugin market index', () => {
  it('uses the published version, timestamp, exact Host requirement and native npm install target', () => {
    const index = publishedPluginIndex(metadata, '0.0.13', 'https://registry.npmjs.org/')
    const plugin = index.plugins[0]!
    expect(plugin.versions[0]).toMatchObject({ version: '0.0.13', engines: { dsh: '0.2.1-rc.3' }, publishTimestamp: 1792195200 })
    expect(marketInstallTarget(plugin.name, plugin.versions[0]!)).toEqual({ spec: 'dsh-slop@0.0.13', registry: 'https://registry.npmjs.org/' })
  })
  it('refuses unpublished, incomplete or incompatible metadata instead of inventing an installable release', () => {
    expect(() => publishedPluginIndex(metadata, '0.0.14', 'https://registry.npmjs.org/')).toThrow(/no complete published/)
    expect(() => publishedPluginIndex({ ...metadata, time: {} }, '0.0.13', 'https://registry.npmjs.org/')).toThrow(/no complete published/)
    expect(() => publishedPluginIndex({ ...metadata, versions: { '0.0.13': { ...manifest, engines: { dsh: 'invalid' } } } }, '0.0.13', 'https://registry.npmjs.org/')).toThrow()
  })
})
