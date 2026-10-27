import { migrateComponentConfiguration } from './component-migration.js'
import { linkRuntimeBundle, type RuntimeBundle } from './runtime-bundle.js'
export { resolveRuntimeBundle } from './runtime-bundle.js'
import { constants, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateLegacyAgentPresets } from './legacy-preset-migration.js'
import { composeProfileManifest } from './profile-manifest.js'
import { prepareLegacyKnowledgeSettings } from './legacy-settings.js'

/** Exact upstream release this launcher accepts. */
export const DSH_VERSION = '0.2.1-rc.3'

/** Exact upstream source revision used to produce the supported DSH release. */
export const DSH_UPSTREAM_COMMIT = '1f81c047fc48fa190a683e469daa699857e9afe8'

/** Product version included in diagnostics and backup metadata. */
export const PRODUCT_VERSION = '0.0.1'

/** Internal compatibility marker that prevents reinterpretation of an older product home. */
export const PRODUCT_HOME_SCHEMA_GENERATION = 'redesign-v1'

const PRODUCT_HOME_MARKER = '.dsh-slop-redesign-v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Resolved owner-only product directories. */
export interface ProductPaths {
  productHome: string
  dshHome: string
  dataHome: string
  profileDir: string
}

/** Return the platform application-data default without consulting DSH_HOME. */
export function defaultProductHome(env: NodeJS.ProcessEnv = process.env): string {
  const current = platform()
  if (current === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DSH-SLOP')
  if (current === 'linux') return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'dsh-slop')
  if (current === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-slop')
  throw new Error(`dsh-slop does not support ${current}; use macOS 14+ or a mainstream systemd Linux distribution`)
}

/** Resolve and validate product paths before creating any directory. */
export function resolveProductPaths(requested?: string, env: NodeJS.ProcessEnv = process.env): ProductPaths {
  const value = requested ?? env.DSH_SLOP_HOME ?? defaultProductHome(env)
  if (!isAbsolute(value)) throw new Error('DSH_SLOP_HOME must be an absolute path')
  const productHome = resolve(value)
  const ordinaryDshHome = resolve(env.DSH_HOME ?? join(homedir(), '.dsh'))
  const dshHome = join(productHome, 'dsh')
  if (productHome === ordinaryDshHome || dshHome === ordinaryDshHome) {
    throw new Error('DSH-SLOP refuses to alias its isolated home to an ordinary DSH_HOME')
  }
  return { productHome, dshHome, dataHome: join(productHome, 'slop'), profileDir: join(dshHome, 'profiles', 'slop') }
}

async function existingCanonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

async function assertDisjoint(paths: ProductPaths, env: NodeJS.ProcessEnv): Promise<void> {
  const ordinary = await existingCanonical(env.DSH_HOME ?? join(homedir(), '.dsh'))
  const product = await existingCanonical(paths.productHome)
  const dsh = await existingCanonical(paths.dshHome)
  if (ordinary === product || ordinary === dsh) throw new Error('DSH-SLOP product and ordinary DSH homes resolve to the same directory')
}

function isProductHomeMarker(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return 'schemaGeneration' in value && value.schemaGeneration === PRODUCT_HOME_SCHEMA_GENERATION
}

async function initializeGreenfieldProductHome(productHome: string): Promise<void> {
  await mkdir(productHome, { recursive: true, mode: 0o700 })
  await chmod(productHome, 0o700)
  const entries = (await readdir(productHome)).sort()
  const markerPath = join(productHome, PRODUCT_HOME_MARKER)
  if (!entries.includes(PRODUCT_HOME_MARKER)) {
    if (entries.length > 0) {
      throw new Error(`DSH-SLOP requires a compatible product home; '${productHome}' already contains unrecognized data: ${entries.join(', ')}`)
    }
    await writeFile(markerPath, `${JSON.stringify({ schemaGeneration: PRODUCT_HOME_SCHEMA_GENERATION })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    return
  }
  let marker: unknown
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8'))
  } catch {
    throw new Error(`DSH-SLOP product-home marker is unreadable at '${markerPath}'.`)
  }
  if (!isProductHomeMarker(marker)) {
    throw new Error(`DSH-SLOP product-home marker is incompatible at '${markerPath}'.`)
  }
}

async function writeIfChanged(path: string, content: string, mode: number): Promise<void> {
  let current: string | undefined
  try {
    current = await readFile(path, 'utf8')
  } catch {
    current = undefined
  }
  if (current !== content) await writeFile(path, content, { encoding: 'utf8', mode })
  await chmod(path, mode)
}

const RUNTIME_LINK_MANIFEST = '.dsh-slop-runtime-links.json'
const RUNTIME_PACKAGES = new Map([
  ['bundle', '@dsh-slop/bundle'],
  ['knowledge', '@dsh-slop/knowledge'],
  ['plugin', '@dsh-slop/plugin'],
  ['ui', '@dsh-slop/ui'],
  ...['runtime', 'machine', 'queue-plugin', 'queue-webhook', 'web-runtime'].map(name => [name, `@dsh-slop/${name}`] as const),
])
const LEGACY_RUNTIME_PACKAGES = {
  bundle: '@dsh-slop/bundle',
  plugin: '@dsh-slop/plugin',
  ui: '@dsh-slop/ui',
} as const

interface RuntimeLinkManifest {
  readonly schema: 1
  readonly owner: 'dsh-slop-launcher'
  readonly packages: Readonly<Record<string, string>>
}

function expectedRuntimeLinkManifest(): RuntimeLinkManifest {
  return {
    schema: 1,
    owner: 'dsh-slop-launcher',
    packages: Object.fromEntries(RUNTIME_PACKAGES),
  }
}

function matchesRuntimePackages(
  actual: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([name, packageName]) => actual[name] === packageName)
}

function isRuntimeLinkManifest(value: unknown): value is RuntimeLinkManifest {
  if (!isRecord(value) || value.schema !== 1 || value.owner !== 'dsh-slop-launcher' || !isRecord(value.packages)) return false
  const expected = expectedRuntimeLinkManifest().packages
  const actual = value.packages
  return matchesRuntimePackages(actual, expected) || matchesRuntimePackages(actual, { ...LEGACY_RUNTIME_PACKAGES, knowledge: '@dsh-slop/knowledge' }) || matchesRuntimePackages(actual, LEGACY_RUNTIME_PACKAGES)
}

function isCurrentRuntimeLinkManifest(manifest: RuntimeLinkManifest): boolean {
  return matchesRuntimePackages(manifest.packages, expectedRuntimeLinkManifest().packages)
}

async function readRuntimeLinkManifest(path: string): Promise<RuntimeLinkManifest | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRuntimeLinkManifest(value)) throw new Error(`invalid managed runtime link manifest at ${path}`)
    return value
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function replaceRuntimeLink(destination: string, source: string): Promise<void> {
  const temporary = join(dirname(destination), `.${RUNTIME_LINK_MANIFEST}.${randomUUID()}`)
  await symlink(source, temporary, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    if (process.platform === 'win32') {
      // Windows cannot atomically rename over a directory junction. Retain
      // the old link until publication succeeds and restore it on failure.
      const previous = `${temporary}.previous`
      if (!(await lstat(destination)).isSymbolicLink()) throw new Error(`refusing to replace non-link runtime package at ${destination}`)
      await rename(destination, previous)
      try { await rename(temporary, destination) }
      catch (error) { await rename(previous, destination); throw error }
      await unlink(previous)
    } else {
      await rename(temporary, destination)
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function linkRuntimePackages(paths: ProductPaths): Promise<void> {
  const bundleManifest = fileURLToPath(import.meta.resolve('@dsh-slop/bundle/package.json'))
  const resolveFromBundle = createRequire(bundleManifest)
  const packages = new Map([...RUNTIME_PACKAGES].map(([key, name]) => [key, name === '@dsh-slop/bundle' ? dirname(bundleManifest) : dirname(resolveFromBundle.resolve(`${name}/package.json`))]))
  const scope = join(paths.profileDir, 'node_modules', '@dsh-slop')
  await mkdir(scope, { recursive: true, mode: 0o700 })
  const ownershipPath = join(scope, RUNTIME_LINK_MANIFEST)
  const ownership = await readRuntimeLinkManifest(ownershipPath)
  const expectedOwnership = expectedRuntimeLinkManifest()
  if (ownership === undefined) {
    for (const name of packages.keys()) {
      try {
        const destination = join(scope, name)
        const entry = await lstat(destination)
        if (!entry.isSymbolicLink()) throw new Error(`refusing to replace non-link runtime package at ${destination}`)
        throw new Error(`refusing to adopt unowned runtime package link at ${destination}`)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await writeIfChanged(ownershipPath, `${JSON.stringify(expectedOwnership, null, 2)}\n`, 0o600)
  } else if (!isCurrentRuntimeLinkManifest(ownership)) {
    for (const name of packages.keys()) {
      if (name in ownership.packages) continue
      try {
        await lstat(join(scope, name))
        throw new Error(`refusing to adopt unowned runtime package link at ${join(scope, name)}`)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    await writeIfChanged(ownershipPath, `${JSON.stringify(expectedOwnership, null, 2)}\n`, 0o600)
  }
  for (const [name, source] of packages) {
    const destination = join(scope, name)
    try {
      const entry = await lstat(destination)
      if (!entry.isSymbolicLink()) throw new Error(`refusing to replace non-link runtime package at ${destination}`)
      const current = resolve(dirname(destination), await readlink(destination))
      if (current !== source) await replaceRuntimeLink(destination, source)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      else throw error
    }
  }
}

/** Initialize the private product home and the composed DSH profile idempotently. */
export async function initializeProductHome(paths: ProductPaths, env: NodeJS.ProcessEnv = process.env, runtime?: RuntimeBundle): Promise<void> {
  await assertDisjoint(paths, env)
  await initializeGreenfieldProductHome(paths.productHome)
  for (const path of [paths.productHome, paths.dshHome, paths.dataHome, join(paths.dataHome, 'data'), join(paths.dataHome, 'logs'), join(paths.dataHome, 'sockets'), join(paths.dataHome, 'tmp'), paths.profileDir]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    await chmod(path, 0o700)
  }
  await migrateComponentConfiguration(paths)
  const manifest = await composeProfileManifest({
    path: join(paths.profileDir, 'package.json'),
    dshVersion: DSH_VERSION,
    productVersion: PRODUCT_VERSION,
    ...(runtime === undefined ? {} : { runtime }),
  })
  await migrateLegacyAgentPresets(paths.dshHome)
  await prepareLegacyKnowledgeSettings(paths.dshHome)
  await writeIfChanged(join(paths.profileDir, 'package.json'), manifest, 0o600)
  try {
    await writeFile(join(paths.profileDir, 'cordis.patch.yml'), '# User-owned profile overrides. Keep secrets in DSH credential facilities.\n[]\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  await linkRuntimePackages(paths)
  if (runtime !== undefined) await linkRuntimeBundle(paths.profileDir, runtime)
}

/** Resolve the installed DSH CLI entry without invoking a shell. */
export async function resolveDshBin(manifestOverride?: string): Promise<string> {
  const manifestPath = manifestOverride ?? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!isRecord(manifest)) throw new Error('installed DSH manifest must be an object')
  if (manifest.name !== '@deepseek-ai/dsh') throw new Error(`dsh-slop expected @deepseek-ai/dsh; found ${String(manifest.name)}`)
  if (manifest.version !== DSH_VERSION) throw new Error(`dsh-slop requires @deepseek-ai/dsh ${DSH_VERSION}; found ${String(manifest.version)}`)
  if (!isRecord(manifest.bin) || typeof manifest.bin.dsh !== 'string') throw new Error('installed @deepseek-ai/dsh package has no dsh binary')
  const bin = resolve(dirname(manifestPath), manifest.bin.dsh)
  await access(bin, constants.R_OK)
  return bin
}

/** Validate the installed DSH package before reporting launcher diagnostics. */
export async function launcherDiagnostics(paths: ProductPaths, manifestOverride?: string): Promise<Readonly<Record<string, string>>> {
  await resolveDshBin(manifestOverride)
  return {
    productVersion: PRODUCT_VERSION,
    dshVersion: DSH_VERSION,
    dshUpstreamCommit: DSH_UPSTREAM_COMMIT,
    productHome: paths.productHome,
    dshHome: paths.dshHome,
    dataHome: paths.dataHome,
    loopback: '127.0.0.1:3080',
    telemetry: 'disabled',
  }
}

/** Safe environment inherited by the DSH child. */
export function productEnvironment(paths: ProductPaths, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const bundledSkills = assetDirectory('skills')
  return {
    ...env,
    DSH_SLOP_HOME: paths.productHome,
    DSH_HOME: paths.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_SLOP_SKILL_DIR: bundledSkills,
  }
}

function assetDirectory(name: 'skills'): string {
  const packed = fileURLToPath(new URL(`./assets/${name}/`, import.meta.url))
  if (existsSync(packed)) return packed
  return fileURLToPath(new URL(`../../../${name}/`, import.meta.url))
}
