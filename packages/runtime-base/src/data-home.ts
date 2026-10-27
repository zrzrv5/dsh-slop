import { isAbsolute, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Plugin installs follow the Harness home; the standalone launcher supplies its own home. */
export function pluginDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_SLOP_HOME
  if (configured === undefined) return join(resolveDshHome(undefined, env), 'slop-plugin')
  if (!isAbsolute(configured)) throw new Error('DSH_SLOP_HOME must be an absolute path')
  return resolve(configured)
}
