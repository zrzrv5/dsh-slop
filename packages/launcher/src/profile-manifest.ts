import { readFile } from 'node:fs/promises'
import type { RuntimeBundle } from './runtime-bundle.js'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Update launcher-owned pins while retaining the Plugin Manager's saved composition. */
export async function composeProfileManifest(input: {
  readonly path: string
  readonly dshVersion: string
  readonly productVersion: string
  readonly runtime?: RuntimeBundle
}): Promise<string> {
  let previous: unknown = {}
  try {
    previous = JSON.parse(await readFile(input.path, 'utf8'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (!record(previous)) throw new Error('DSH-SLOP profile manifest must be an object')
  const dependencies = previous.dependencies ?? {}
  const dsh = previous.dsh ?? {}
  const ownership = previous.dshSlop ?? {}
  if (!record(dependencies) || Object.values(dependencies).some(value => typeof value !== 'string')
    || !record(dsh) || !record(ownership)) {
    throw new Error('DSH-SLOP profile manifest has invalid dependencies or composition metadata')
  }
  const profile = dsh.profile ?? {}
  if (!record(profile)) throw new Error('DSH-SLOP profile manifest has an invalid profile')
  const bundles = profile.bundles ?? []
  if (!Array.isArray(bundles) || !bundles.every((value): value is string => typeof value === 'string')) {
    throw new Error('DSH-SLOP profile bundles must be package names')
  }
  const previousRuntime = ownership.runtimeBundle
  if (previousRuntime !== undefined && typeof previousRuntime !== 'string') {
    throw new Error('DSH-SLOP profile runtime ownership must be a package name')
  }
  const managedBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-slop/bundle', '@dsh-slop/web-runtime']
  // Only remove an optional runtime whose ownership we previously recorded.
  // A saved external bundle is configuration, never an inferred deployment.
  const retainedDependencies = { ...dependencies }
  if (previousRuntime !== undefined && !managedBundles.includes(previousRuntime)) delete retainedDependencies[previousRuntime]
  const retainedBundles = bundles.filter(name => !managedBundles.includes(name)
    && name !== previousRuntime && name !== input.runtime?.name)
  return `${JSON.stringify({
    ...previous,
    name: 'dsh-slop-profile',
    private: true,
    dependencies: {
      ...retainedDependencies,
      '@deepseek-ai/dsh-base': input.dshVersion,
      '@deepseek-ai/dsh-web-app': input.dshVersion,
      '@dsh-slop/bundle': input.productVersion,
      '@dsh-slop/web-runtime': input.productVersion,
      ...(input.runtime === undefined ? {} : { [input.runtime.name]: input.runtime.version }),
    },
    dsh: {
      ...dsh,
      profile: { ...profile, bundles: [...managedBundles, ...(input.runtime === undefined ? [] : [input.runtime.name]), ...retainedBundles] },
    },
    dshSlop: input.runtime === undefined ? {} : { runtimeBundle: input.runtime.name },
  }, null, 2)}\n`
}
