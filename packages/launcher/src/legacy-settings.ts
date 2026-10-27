import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { isMap, parseDocument } from 'yaml'

/** Map SLOP's old settings namespace to its existing profile entry before DSH imports it. */
export async function prepareLegacyKnowledgeSettings(dshHome: string): Promise<void> {
  const path = join(dshHome, 'settings.yaml')
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (info === undefined) return
  if (!info.isFile()) throw new Error('legacy settings must be a regular file')
  const original = await readFile(path, 'utf8')
  const document = parseDocument(original)
  if (document.errors.length > 0 || !isMap(document.contents)) throw new Error('legacy settings document is malformed')
  if (!document.has('dsh-slop-knowledge')) return
  if (document.has('slop-knowledge')) throw new Error('legacy Knowledge settings contains conflicting namespaces')
  const section = document.get('dsh-slop-knowledge', true)
  if (!isMap(section)) throw new Error('legacy Knowledge settings must be an object')
  const homeRoot = section.get('homeRoot')
  if (typeof homeRoot !== 'string' || !isAbsolute(homeRoot) || homeRoot === '/') throw new Error('legacy Knowledge homeRoot must be an absolute directory other than /')
  document.set('slop-knowledge', section)
  document.delete('dsh-slop-knowledge')
  const backup = `${path}.before-dsh-017`
  try {
    await writeFile(backup, original, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    if (await readFile(backup, 'utf8') !== original) throw new Error('legacy settings backup differs from the current document')
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, document.toString(), { flag: 'wx', mode: 0o600 })
    if (await readFile(path, 'utf8') !== original) throw new Error('legacy settings changed during preparation')
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    })
  }
}
