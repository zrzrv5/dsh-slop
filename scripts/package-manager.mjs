import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** Execute package-manager JavaScript directly, including on Windows (no cmd quoting). */
export function runPackageManager(manager, args, options) {
  const cli = manager === 'npm'
    ? join(dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js')
    : process.env.npm_execpath
  if (cli === undefined) throw new Error('Run this build script through pnpm, for example pnpm plugin:pack.')
  return execFileSync(process.execPath, [cli, ...args], options)
}
