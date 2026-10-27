#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'
import { initializeProductHome, launcherDiagnostics, productEnvironment, PRODUCT_VERSION, resolveDshBin, resolveProductPaths, resolveRuntimeBundle } from './index.js'

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${name} requires a value`)
  args.splice(index, 2)
  return value
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const home = valueAfter(args, '--home')
  const runtimePath = valueAfter(args, '--runtime')
  const paths = resolveProductPaths(home)
  if (args.includes('--version')) {
    process.stdout.write(`dsh-slop ${PRODUCT_VERSION}\n`)
    return 0
  }
  const runtime = runtimePath === undefined ? undefined : await resolveRuntimeBundle(runtimePath)
  await initializeProductHome(paths, process.env, runtime)
  if (args.includes('--data-location')) {
    process.stdout.write(`${paths.productHome}\n`)
    return 0
  }
  if (args.includes('--diagnostics')) {
    process.stdout.write(`${JSON.stringify(await launcherDiagnostics(paths), null, 2)}\n`)
    return 0
  }
  const bin = await resolveDshBin()
  const child = spawn(process.execPath, [bin, '--profile', 'slop', ...args], {
    stdio: 'inherit',
    env: productEnvironment(paths),
  })
  const interrupt = () => { child.kill('SIGINT') }
  const terminate = () => { child.kill('SIGTERM') }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolvePromise(signal === null ? code ?? 1 : signal === 'SIGINT' ? 130 : 143))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}

main().then((code) => { process.exitCode = code }, (error: unknown) => {
  process.stderr.write(`dsh-slop: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
