#!/usr/bin/env node
import { runPackageManager } from './package-manager.mjs'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parse } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, process.env.DSH_SLOP_PLUGIN_DIR ?? 'artifacts')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-slop-plugin-pack-'))
const stage = join(temporary, 'package')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const run = (command, args, cwd = root) => runPackageManager(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

async function verifyExports(directory, value) {
  if (typeof value === 'string') {
    if (!value.startsWith('./') || value.includes('*')) throw new Error(`Unexpected packaged export: ${value}`)
    await access(join(directory, value)).catch(() => { throw new Error(`Missing built export ${directory}/${value}. Run pnpm build first.`) })
  } else if (value !== null && typeof value === 'object') {
    for (const target of Object.values(value)) await verifyExports(directory, target)
  }
}

try {
  if (!process.argv.includes('--no-build')) {
    runPackageManager('pnpm', ['--filter', '@dsh-slop/bundle...', 'build'], { cwd: root, stdio: 'inherit' })
  }
  const catalog = parse(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')).catalog
  const packages = new Map()
  for (const directory of await readdir(join(root, 'packages'))) {
    const path = join(root, 'packages', directory)
    const manifest = await readJson(join(path, 'package.json'))
    packages.set(manifest.name, { path, manifest })
  }
  const bundle = packages.get('@dsh-slop/bundle')
  const bundled = new Map()
  const dependencies = {}
  const peers = {}
  function collect(name) {
    if (bundled.has(name)) return
    const entry = packages.get(name)
    if (entry === undefined) throw new Error(`Missing workspace package: ${name}`)
    bundled.set(name, entry)
    for (const [dependency, requested] of Object.entries({ ...entry.manifest.dependencies, ...entry.manifest.peerDependencies })) {
      // These belong to the standalone launcher, not an installed plugin.
      if (dependency === '@deepseek-ai/dsh-web-app' || dependency === '@dsh-slop/web-runtime') continue
      if (dependency.startsWith('@dsh-slop/')) { collect(dependency); continue }
      const version = requested === 'catalog:' ? catalog[dependency] : requested
      if (typeof version !== 'string' || /^(workspace|catalog|file|link):/.test(version)) throw new Error(`Unresolved dependency: ${dependency}`)
      const target = dependency.startsWith('@deepseek-ai/') && dependency !== '@deepseek-ai/schemastery' || dependency === 'react' || dependency === 'react-dom' ? peers : dependencies
      if (target[dependency] !== undefined && target[dependency] !== version) throw new Error(`Conflicting versions for ${dependency}`)
      target[dependency] = version
    }
  }
  collect('@dsh-slop/bundle')
  bundled.delete('@dsh-slop/bundle')
  // ssh2's JavaScript implementation does not need its optional C++ addons.
  // Bundle the pinned installed runtime graph with licenses and no lifecycle
  // scripts, so Harness's strict pnpm build policy needs no user exceptions.
  const nativeSshPackages = new Map()
  async function collectNativeSsh(name, parentPath) {
    if (nativeSshPackages.has(name)) return
    const manifestPath = createRequire(join(parentPath, 'package.json')).resolve(`${name}/package.json`)
    const path = dirname(manifestPath), manifest = await readJson(manifestPath)
    nativeSshPackages.set(name, { path, manifest })
    if (dependencies[name] !== undefined && dependencies[name] !== manifest.version) throw new Error(`Conflicting native SSH dependency: ${name}`)
    dependencies[name] = manifest.version
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await collectNativeSsh(dependency, path)
  }
  await collectNativeSsh('ssh2', packages.get('@dsh-slop/execution').path)
  await mkdir(stage, { recursive: true })
  const bundledEntries = new Map()
  for (const [name, entry] of bundled) {
    const target = join(stage, 'node_modules', name)
    await mkdir(target, { recursive: true })
    // npm's own file selection honors each package's files allowlist.
    const [packed] = JSON.parse(run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], entry.path))
    for (const file of packed.files) {
      if (file.path === 'package.json') continue
      await mkdir(dirname(join(target, file.path)), { recursive: true })
      await cp(join(entry.path, file.path), join(target, file.path))
    }
    const manifest = { ...entry.manifest }
    for (const field of ['scripts', 'devDependencies', 'dependencies', 'peerDependencies', 'peerDependenciesMeta']) delete manifest[field]
    manifest.exports = Object.fromEntries(Object.entries(manifest.exports).filter(([key]) => !key.startsWith('./src/')))
    // Runtime imports resolve through this package's parent. Nothing inside
    // the archive asks a registry for unpublished workspace packages.
    await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await verifyExports(target, manifest.exports)
    const main = manifest.exports?.['.']
    const entryFile = typeof main === 'string' ? main : main?.default ?? manifest.main
    if (typeof entryFile === 'string') bundledEntries.set(name, entryFile.replace(/^\.\//u, ''))
  }
  for (const [name, entry] of nativeSshPackages) {
    const target = join(stage, 'node_modules', name)
    await mkdir(target, { recursive: true })
    const [packed] = JSON.parse(run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], entry.path))
    for (const file of packed.files) {
      if (file.path === 'package.json' || file.path.endsWith('.node') || file.path.split('/').includes('build')) continue
      await mkdir(dirname(join(target, file.path)), { recursive: true })
      await cp(join(entry.path, file.path), join(target, file.path))
    }
    const manifest = { ...entry.manifest }
    for (const field of ['scripts', 'devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']) delete manifest[field]
    await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  for (const file of ['cordis.patch.yml', 'locale']) await cp(join(bundle.path, file), join(stage, file), { recursive: true })
  await anchorBundledEntries(join(stage, 'cordis.patch.yml'), bundledEntries)
  for (const file of ['README.md', 'README.zh-CN.md', 'INSTALL.md', 'LICENSE']) await cp(join(root, file), join(stage, file))
  const manifest = {
    name: 'dsh-slop', version: bundle.manifest.version, description: 'Machine, Knowledge and Queue for DeepSeek Harness.',
    license: 'MIT', type: 'module', engines: { ...(await readJson(join(root, 'package.json'))).engines, ...bundle.manifest.engines },
    repository: { type: 'git', url: 'git+https://github.com/zrzrv5/dsh-slop.git' },
    exports: bundle.manifest.exports, files: ['cordis.patch.yml', 'locale', 'INSTALL.md', 'README.zh-CN.md'], dsh: bundle.manifest.dsh,
    dependencies: { ...dependencies, ...Object.fromEntries([...bundled].map(([name, entry]) => [name, entry.manifest.version])) },
    peerDependencies: peers, bundledDependencies: [...bundled.keys(), ...nativeSshPackages.keys()],
  }
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await mkdir(destination, { recursive: true })
  // Build away from the output directory so an existing shared version is
  // never overwritten before its contents have been compared.
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], stage))
  const artifact = join(destination, packed.filename)
  const bytes = await readFile(join(temporary, packed.filename))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const existing = await readFile(artifact).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing !== undefined && !existing.equals(bytes)) {
    throw new Error(`${artifact} already contains a different build. Increase the version in packages/bundle/package.json; do not overwrite a shared plugin archive.`)
  }
  if (existing === undefined) await writeFile(artifact, bytes, { flag: 'wx' })
  await writeFile(`${artifact}.sha256`, `${digest}  ${packed.filename}\n`)
  process.stdout.write(`Plugin: ${artifact}\nSHA-256: ${digest}\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

/**
 * Name each component by a path anchored beside the bundle patch. A bare name
 * is resolved to Node's native real path, which on Windows can differ from the
 * configured profile spelling (8.3 short names, drive-letter case). The Host
 * then misses the profile layer and the component's own peer imports, such as
 * `@deepseek-ai/cordis`, fail. An anchored path keeps the configured spelling.
 */
async function anchorBundledEntries(patchPath, entries) {
  const text = await readFile(patchPath, 'utf8')
  const anchored = text.replace(/^(\s*name:\s*)'(@dsh-slop\/[a-z-]+)'[ \t]*$/gmu, (_line, prefix, name) => {
    const entry = entries.get(name)
    if (entry === undefined) throw new Error(`Bundle patch names ${name}, which the plugin archive does not bundle with an entry file.`)
    return `${prefix}./node_modules/${name}/${entry}`
  })
  if (/name:\s*'@dsh-slop\//u.test(anchored)) throw new Error('A bundle patch entry still uses a bare @dsh-slop name.')
  await writeFile(patchPath, anchored)
}
