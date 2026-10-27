import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = join(scriptsDirectory, '..')
const root = join(packageDirectory, '..', '..')
const assets = join(packageDirectory, 'dist', 'assets')
await rm(assets, { recursive: true, force: true })
await mkdir(assets, { recursive: true, mode: 0o755 })
for (const name of ['skills']) {
  await cp(join(root, name), join(assets, name), { recursive: true, force: true })
}
