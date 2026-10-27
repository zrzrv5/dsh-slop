#!/usr/bin/env node
import { access, mkdir, readlink, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runPackageManager } from './package-manager.mjs'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const launcherManifest = JSON.parse(await readFile(join(root, 'packages', 'launcher', 'package.json'), 'utf8'))
const productVersion = launcherManifest.version
const dshVersion = launcherManifest.dependencies?.['@deepseek-ai/dsh']
if (typeof productVersion !== 'string' || typeof dshVersion !== 'string') throw new Error('launcher manifest must declare product and DSH versions')
const releaseDirectory = resolve(root, process.env.DSH_SLOP_RELEASE_DIR ?? 'artifacts')
const artifactName = `dsh-slop-${productVersion}-${process.platform}-${process.arch}.tar.gz`
const stageDirectory = join(releaseDirectory, `dsh-slop-${productVersion}`)
const artifactPath = join(releaseDirectory, artifactName)

function run(command, args, options = {}) {
  const execute = command === 'pnpm' ? runPackageManager : execFileSync
  execute(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })
}

async function assertPortableSymlinks(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(path)
      const resolved = resolve(dirname(path), target)
      const outside = relative(stageDirectory, resolved)
      if (outside === '..' || outside.startsWith(`..${resolve('/') === '/' ? '/' : '\\'}`) || resolve(target) === target) {
        throw new Error(`release contains an external or absolute symlink: ${path} -> ${target}`)
      }
      continue
    }
    if (entry.isDirectory()) await assertPortableSymlinks(path)
  }
}

async function requireFile(path, label) {
  try {
    await access(path)
  } catch {
    throw new Error(`release is missing ${label}: ${path}`)
  }
}

function resolveDeployedPackage(fromFile, specifier) {
  const entry = createRequire(fromFile).resolve(specifier)
  const canonicalEntry = realpathSync(entry)
  const outside = relative(realpathSync(stageDirectory), canonicalEntry)
  if (outside === '..' || outside.startsWith(`..${resolve('/') === '/' ? '/' : '\\'}`)) {
    throw new Error(`release dependency resolves outside the archive: ${specifier} -> ${canonicalEntry}`)
  }
  return canonicalEntry
}

async function sha256(path) {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

await mkdir(releaseDirectory, { recursive: true })
await rm(stageDirectory, { recursive: true, force: true })
await rm(artifactPath, { force: true })

try {
  // Build only the core dependency closure. Launcher's build also packs the
  // shipped Skills into dist/assets for the portable deployment.
  run('pnpm', ['--filter', '@dsh-slop/launcher...', 'build'])
  // pnpm deploy materializes the complete production dependency closure.
  // injectWorkspacePackages in pnpm-workspace.yaml ensures private workspace
  // packages are copied into that closure rather than linked to this checkout.
  run('pnpm', ['--filter', '@dsh-slop/launcher', 'deploy', stageDirectory, '--prod'])

  await requireFile(join(stageDirectory, 'package.json'), 'launcher manifest')
  await requireFile(join(stageDirectory, 'dist', 'bin.js'), 'launcher executable')
  const rootManifest = join(stageDirectory, 'package.json')
  const bundleEntry = resolveDeployedPackage(rootManifest, '@dsh-slop/bundle/cordis.patch.yml')
  for (const component of ['runtime', 'machine', 'knowledge', 'queue-plugin', 'queue-webhook']) {
    resolveDeployedPackage(bundleEntry, `@dsh-slop/${component}`)
    resolveDeployedPackage(bundleEntry, `@dsh-slop/${component}/client`)
    resolveDeployedPackage(bundleEntry, `@dsh-slop/${component}/locale/en.json`)
  }
  const webRuntime = resolveDeployedPackage(rootManifest, '@dsh-slop/web-runtime/cordis.patch.yml')
  for (const name of ['experimental-worktree', 'experimental-tool-worktree', 'plugin-market', 'client-ui-plugin-market']) {
    resolveDeployedPackage(webRuntime, `@deepseek-ai/dsh-${name}`)
  }
  resolveDeployedPackage(rootManifest, '@dsh-slop/web-runtime/ptc-memory.patch.yml')
  const pluginEntry = resolveDeployedPackage(bundleEntry, '@dsh-slop/plugin')
  resolveDeployedPackage(bundleEntry, '@dsh-slop/ui')
  resolveDeployedPackage(pluginEntry, '@dsh-slop/core')
  const executionEntry = resolveDeployedPackage(pluginEntry, '@dsh-slop/execution')
  resolveDeployedPackage(executionEntry, '@dsh-slop/operations')
  await assertPortableSymlinks(stageDirectory)

  const manifest = {
    artifact: artifactName,
    package: '@dsh-slop/launcher',
    productVersion,
    dshVersion,
    generatedBy: 'scripts/pack-release.mjs',
    portable: true,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  }
  await writeFile(join(stageDirectory, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  run('tar', ['-czf', artifactPath, '-C', stageDirectory, '.'])
  const digest = await sha256(artifactPath)
  await writeFile(`${artifactPath}.sha256`, `${digest}  ${artifactName}\n`, { mode: 0o600 })
  process.stdout.write(`Release artifact: ${artifactPath}\n`)
  process.stdout.write(`SHA-256: ${digest}\n`)
} catch (error) {
  await rm(stageDirectory, { recursive: true, force: true })
  await rm(artifactPath, { force: true })
  throw error
}
