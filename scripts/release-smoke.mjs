#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smokeRoot = await mkdtemp(join(tmpdir(), 'dsh-slop-release-smoke-'))
const releaseDirectory = join(smokeRoot, 'release')
const extractedDirectory = join(smokeRoot, 'installed')

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  })
}

try {
  run(process.execPath, [join(root, 'scripts', 'pack-release.mjs')], {
    env: { ...process.env, DSH_SLOP_RELEASE_DIR: releaseDirectory },
  })
  const sourceManifest = JSON.parse(await readFile(join(root, 'packages', 'launcher', 'package.json'), 'utf8'))
  const artifact = join(releaseDirectory, `dsh-slop-${sourceManifest.version}-${process.platform}-${process.arch}.tar.gz`)
  await mkdir(extractedDirectory, { recursive: true })
  run('tar', ['-xzf', artifact, '-C', extractedDirectory])

  const launcher = join(extractedDirectory, 'dist', 'bin.js')
  const launcherManifest = JSON.parse(await readFile(join(extractedDirectory, 'package.json'), 'utf8'))
  const version = run(process.execPath, [launcher, '--version']).trim()
  if (version !== `dsh-slop ${launcherManifest.version}`) throw new Error(`unexpected packed launcher version: ${version}`)

  // Diagnostics initializes only the isolated profile and package links. It
  // must not spawn DSH or contact a model endpoint.
  const productHome = join(smokeRoot, 'product-home')
  const diagnostics = JSON.parse(run(process.execPath, [launcher, '--diagnostics', '--home', productHome]))
  if (diagnostics.productVersion !== launcherManifest.version || diagnostics.productHome !== productHome) {
    throw new Error('packed launcher diagnostics did not report the isolated product home')
  }

  // Walk the same nested package graph that DSH uses, then import execution.
  // This does not assume workspace packages are hoisted to the archive root.
  const closureSmoke = [
    "import { createRequire } from 'node:module'",
    "import { pathToFileURL } from 'node:url'",
    "const root = createRequire(new URL('./package.json', import.meta.url))",
    "const bundle = root.resolve('@dsh-slop/bundle/cordis.patch.yml')",
    "for (const name of ['runtime', 'machine', 'knowledge', 'queue-plugin', 'queue-webhook']) { await import(pathToFileURL(createRequire(bundle).resolve('@dsh-slop/' + name))); createRequire(bundle).resolve('@dsh-slop/' + name + '/client') }",
    "const plugin = createRequire(bundle).resolve('@dsh-slop/plugin')",
    "const execution = createRequire(plugin).resolve('@dsh-slop/execution')",
    "await import(pathToFileURL(execution))",
  ].join(';')
  run(process.execPath, ['--input-type=module', '-e', closureSmoke], { cwd: extractedDirectory })
  const manifest = JSON.parse(await readFile(join(extractedDirectory, 'RELEASE-MANIFEST.json'), 'utf8'))
  if (manifest.portable !== true) throw new Error('release manifest is not marked portable')
  process.stdout.write('Packed release smoke passed (version, diagnostics, imports; no model launch).\n')
} finally {
  await rm(smokeRoot, { recursive: true, force: true })
}
