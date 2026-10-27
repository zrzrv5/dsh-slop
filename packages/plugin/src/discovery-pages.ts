import { posix } from 'node:path'

/** Commands are compiled on the Host; no model-generated parser is required. */
export const DISCOVERY_CENSUS_COMMAND = String.raw`find . -mindepth 1 -maxdepth 1 -printf '%f|%y\n' | head -n 64 | awk '{print} END {print "CENSUS|emitted=" NR "|cap=64"}'`

const DOCUMENT_PATTERNS = ['README*', 'note*.md', 'note*.txt', 'settings*.yaml', 'settings*.yml', 'opt*.yaml', 'opt*.yml', 'param.*']
const WRAPPER_PATTERNS = ['run*.sh', 'submit*.sh', '*.slurm']
const DRIVER_PATTERNS = ['run*.py', 'autorun.py', 'driver*.py', 'main*.py']
const CONFIG_PATTERNS = ['machine*.json', 'machine*.yaml', 'machine*.yml', 'resource*.json', 'resource*.yaml', 'resource*.yml']

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function files(root: string, depth: number, patterns: readonly string[], label: string, limit: number): string {
  const choices = patterns.map(pattern => `-iname ${quote(pattern)}`).join(' -o ')
  return String.raw`find ${root} -mindepth 1 -maxdepth ${depth} -type f \( ${choices} \) -printf '${label}|%p\n' | head -n ${limit}`
}

export function discoveryFocus(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('./') || value.length > 4_096
    || /[\0\r\n]/u.test(value) || value.split('/').includes('..')) return undefined
  const normalized = posix.normalize(value)
  return normalized === '.' ? undefined : `./${normalized}`
}

export function compileDiscoveryProjectPage(focus?: string): string {
  if (focus !== undefined) {
    const path = discoveryFocus(focus)
    if (path === undefined) throw new Error('Discovery focus must be an observed relative workstream path.')
    return `${files(quote(path), 2, [...DOCUMENT_PATTERNS, ...WRAPPER_PATTERNS, ...DRIVER_PATTERNS, ...CONFIG_PATTERNS, '*.md', '*.txt', '*.yaml', '*.yml', '*.json', '*.toml', '*.def'], 'FOCUSED', 24)} | LC_ALL=C cut -b 1-160 | head -n 24`
  }
  const rootPages = [
    files('.', 1, DOCUMENT_PATTERNS, 'MEANING', 2),
    files('.', 1, WRAPPER_PATTERNS, 'OUTER', 1),
    files('.', 1, DRIVER_PATTERNS, 'DRIVER', 1),
    files('.', 1, CONFIG_PATTERNS, 'CONFIG', 1),
    String.raw`find . -mindepth 1 -maxdepth 1 -type d -printf 'WORKSTREAM|%p\n' | head -n 20`,
    String.raw`find . -mindepth 1 -maxdepth 1 -type d -printf '%p\n' | head -n 8 | while IFS= read -r d; do ${files('"$d"', 2, [...DOCUMENT_PATTERNS, ...WRAPPER_PATTERNS, ...DRIVER_PATTERNS, ...CONFIG_PATTERNS], 'CANDIDATE', 4)}; done`,
  ]
  return `{ ${rootPages.join('; ')}; } | LC_ALL=C cut -b 1-160 | head -n 57`
}

export interface DiscoveryCensusPage {
  readonly entries: readonly { readonly entry: string; readonly category: 'unclassified'; readonly evidenceTier: 'census' }[]
  readonly complete: boolean
}

/** An empty census is valid; reaching the cap does not prove completeness. */
export function parseDiscoveryCensus(stdout: string): DiscoveryCensusPage | undefined {
  const lines = stdout.split('\n').filter(Boolean)
  const marker = lines.pop()?.match(/^CENSUS\|emitted=(\d+)\|cap=64$/u)
  if (marker === undefined || marker === null || Number(marker[1]) !== lines.length || lines.length > 64) return undefined
  const names = lines.map(line => /^(.*)\|[a-z]$/u.exec(line)?.[1])
  if (names.some(name => name === undefined || name.length === 0) || new Set(names).size !== names.length) return undefined
  return {
    entries: names.filter((name): name is string => name !== undefined).map(entry => ({ entry, category: 'unclassified', evidenceTier: 'census' })),
    complete: lines.length < 64,
  }
}
