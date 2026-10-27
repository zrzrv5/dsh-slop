import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

// pnpm runs this in each client-owning package after webui generates its asset.
// The sync:client lifecycle then refreshes that package's injected copies.
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const client = manifest.exports?.['./client']
assert.equal(typeof client, 'string', `${manifest.name} must export a browser client`)
await access(client).catch(() => {
  throw new Error(`${manifest.name} is missing ${client}; build the Web UI first.`)
})
