import { lstat, mkdir, readFile, readlink, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface RuntimeBundle {
  readonly name: string
  readonly version: string
  readonly directory: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Load an explicitly selected, installed deployment bundle. Core never discovers personal plugins. */
export async function resolveRuntimeBundle(directory: string): Promise<RuntimeBundle> {
  if (!isAbsolute(directory)) throw new Error('--runtime requires an absolute bundle directory')
  const canonical = await realpath(directory)
  const value: unknown = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8'))
  if (!isRecord(value) || typeof value.name !== 'string'
    || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(value.name)
    || value.name.startsWith('@deepseek-ai/')
    || ['@dsh-slop/bundle', '@dsh-slop/plugin', '@dsh-slop/knowledge', '@dsh-slop/ui', '@dsh-slop/runtime', '@dsh-slop/runtime-base', '@dsh-slop/machine', '@dsh-slop/queue-plugin', '@dsh-slop/queue-webhook', '@dsh-slop/web-runtime'].includes(value.name)
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(value.version)
    || !isRecord(value.dsh) || !isRecord(value.dsh.bundle) || typeof value.dsh.bundle.patch !== 'string') {
    throw new Error('--runtime must name a versioned DSH bundle, distinct from core packages')
  }
  return { name: value.name, version: value.version, directory: canonical }
}

/** Install only an absent link or reuse the same selected bundle; never adopt a different package. */
export async function linkRuntimeBundle(profileDir: string, bundle: RuntimeBundle): Promise<void> {
  const destination = join(profileDir, 'node_modules', bundle.name)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  try {
    const entry = await lstat(destination)
    if (!entry.isSymbolicLink() || resolve(dirname(destination), await readlink(destination)) !== bundle.directory) {
      throw new Error(`runtime bundle path already belongs to another installation: ${destination}`)
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    await symlink(bundle.directory, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
}
