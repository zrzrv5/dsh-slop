#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

/** Generate from published metadata so an index never advertises an unshipped archive. */
export function publishedPluginIndex(metadata, version, registry) {
  const manifest = metadata.versions?.[version]
  const timestamp = Date.parse(metadata.time?.[version]) / 1000
  if (metadata.name !== 'dsh-slop' || manifest?.name !== 'dsh-slop' || manifest.version !== version
    || !manifest.dsh?.bundle?.patch || !manifest.engines?.dsh || !manifest.dist?.integrity
    || !Number.isFinite(timestamp)) throw new Error(`Registry has no complete published dsh-slop@${version}`)
  return parseMarketIndex({
    format: 1,
    title: 'DSH-SLOP',
    plugins: [{
      name: manifest.name, title: 'DSH-SLOP', description: manifest.description,
      repository: { url: 'https://github.com/zrzrv5/dsh-slop' },
      versions: [{ version, publishTimestamp: Math.floor(timestamp), source: { type: 'npm', registry }, engines: { dsh: manifest.engines.dsh } }],
    }],
  }, new URL('index.json', registry).href)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    registry: { type: 'string', default: 'https://registry.npmjs.org/' },
    output: { type: 'string' },
  } })
  if (!values.output) throw new Error('--output is required')
  const registry = new URL(values.registry)
  if (!['https:', 'http:'].includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash) throw new Error('Expected an HTTP(S) registry without credentials')
  if (!registry.pathname.endsWith('/')) registry.pathname += '/'
  const bundle = JSON.parse(await readFile(new URL('../packages/bundle/package.json', import.meta.url), 'utf8'))
  const response = await fetch(new URL('dsh-slop', registry), { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`Registry returned ${response.status}; publish and verify the package before generating its index`)
  const index = publishedPluginIndex(await response.json(), bundle.version, registry.href)
  await writeFile(values.output, `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' })
  console.log(`Plugin index: ${values.output}`)
}
