import { posix } from 'node:path'

export function isAbsoluteRemotePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\r') && !value.includes('\n') && !value.includes('\0')
}

/** Only the logged-in user's home shorthand or an absolute path is accepted. */
export function discoveryRootInput(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || (value.includes('\r') || value.includes('\n') || value.includes('\0'))) return undefined
  if (value !== '~' && !value.startsWith('~/') && !isAbsoluteRemotePath(value)) return undefined
  if (value.split('/').includes('..')) return undefined
  return value
}

/** Host-built, read-only path resolution. No user string is evaluated as shell. */
export function resolveDiscoveryRootCommand(root: string): string {
  if (discoveryRootInput(root) === undefined) throw new Error('Root must be an absolute path or ~/path without parent traversal.')
  const literal = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`
  const path = root === '~' ? '"$HOME"' : root.startsWith('~/') ? `"$HOME"/${literal(root.slice(2))}` : literal(root)
  return `cd -- ${path} && pwd -P`
}

export function resolvedDiscoveryRoot(stdout: unknown): string | undefined {
  if (typeof stdout !== 'string') return undefined
  const path = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  return isAbsoluteRemotePath(path) && path.length <= 4096 && posix.normalize(path) === path ? path : undefined
}
