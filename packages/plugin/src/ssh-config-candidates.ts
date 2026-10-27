import { open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

interface SshCandidate {
  alias: string
  source: string
  line: number
  hostName?: string
  user?: string
  port?: string
  identityFile?: string
}

/** Tokenize configuration, never evaluate Match exec, ProxyCommand or key data. */
function words(line: string): string[] {
  const result: string[] = []
  let word = '', quote = '', escaped = false
  const characters = [...line]
  for (const [index, char] of characters.entries()) {
    if (escaped) { word += char; escaped = false; continue }
    if (char === '\\' && (characters[index + 1] === '"' || characters[index + 1] === "'" || /\s/u.test(characters[index + 1] ?? ''))) { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; else word += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#') break
    if (/\s/u.test(char)) { if (word) { result.push(word); word = '' }; continue }
    word += char
  }
  if (word) result.push(word)
  return result
}

/** Bounded hints, not an ssh -G expansion. OpenSSH applies config on connection. */
export async function scanSshConfig(home: string, signal?: AbortSignal) {
  const root = join(home, '.ssh')
  const candidates: SshCandidate[] = []
  const warnings = new Set<string>()
  const visited = new Set<string>()
  let remainingBytes = 256 * 1024, directoryReads = 0
  const expand = async (pattern: string): Promise<string[]> => {
    if (pattern.includes('%') || pattern.includes('${') || pattern.startsWith('~') && !pattern.startsWith('~/')) {
      warnings.add('An Include using unsupported substitutions was skipped.'); return []
    }
    const wslRoot = /^\\\\wsl(?:\.localhost|\$)\\/iu.test(home) ? parse(home).root : undefined
    const absolute = pattern.startsWith('~/') ? join(home, pattern.slice(2))
      : wslRoot !== undefined && pattern.startsWith('/') ? join(wslRoot, pattern)
      : isAbsolute(pattern) ? pattern : resolve(root, pattern)
    if (absolute.includes('[')) { warnings.add('An Include with a bracket pattern was skipped.'); return [] }
    if (!/[?*]/u.test(absolute)) return [absolute]
    const volume = parse(absolute).root
    let paths = [volume]
    for (const part of relative(volume, absolute).split(sep).filter(Boolean)) {
      if (!/[?*]/u.test(part)) { paths = paths.map(path => join(path, part)); continue }
      const matcher = new RegExp('^' + part.replace(/[.+^${}()|\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'u')
      const next: string[] = []
      for (const path of paths) {
        signal?.throwIfAborted()
        if (++directoryReads > 32) { warnings.add('Include directory limit reached.'); break }
        try {
          const entries = await readdir(path)
          for (const name of entries.sort()) {
            if (matcher.test(name)) next.push(join(path, name))
            if (next.length >= 64) { warnings.add('Include match limit reached.'); break }
          }
        } catch { warnings.add('An Include directory could not be read.') }
      }
      paths = next.slice(0, 64)
    }
    return paths
  }
  let active: SshCandidate[] = []
  const visit = async (path: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > 8 || visited.size >= 16 || remainingBytes <= 0) { warnings.add('SSH configuration scan limit reached.'); return }
    let canonical: string
    try { canonical = await realpath(path) } catch { return }
    if (visited.has(canonical)) return
    visited.add(canonical)
    const handle = await open(canonical, 'r')
    let text: string
    try {
      if (!(await handle.stat()).isFile()) return
      const buffer = Buffer.alloc(Math.min(64 * 1024, remainingBytes) + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead === buffer.length) { warnings.add('An oversized SSH configuration file was skipped.'); return }
      remainingBytes -= bytesRead
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await handle.close() }
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      signal?.throwIfAborted()
      const [key, ...values] = words(line.replace(/^\s*(\w+)\s*=\s*/u, '$1 '))
      const directive = key?.toLowerCase()
      if (directive === 'include') {
        for (const value of values) for (const include of await expand(value)) await visit(include, depth + 1)
      } else if (directive === 'host') {
        active = []
        for (const alias of values) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(alias)) continue
          if (candidates.some(item => item.alias === alias)) continue
          if (candidates.length >= 64) { warnings.add('Machine candidate limit reached.'); break }
          const candidate = { alias, source: canonical, line: index + 1 }
          candidates.push(candidate); active.push(candidate)
        }
      } else if (directive === 'match') {
        active = []
        warnings.add('Conditional Match settings are not evaluated; confirm the selected alias before connecting.')
      } else if (values.length === 1 && values[0]!.length <= 512) {
        const field = directive === 'hostname' ? 'hostName' : directive === 'user' ? 'user' : directive === 'port' ? 'port' : directive === 'identityfile' ? 'identityFile' : undefined
        if (field) for (const candidate of active) candidate[field] ??= values[0]!
      }
    }
  }
  try { await visit(join(root, 'config'), 0) } catch {
    signal?.throwIfAborted()
    warnings.add('Some SSH configuration could not be read; enter a target manually if needed.')
  }
  return { candidates, warnings: [...warnings], note: 'Only literal Host aliases and stanza hints are shown. Wildcard defaults and Match conditions are not resolved. No connections or key contents were read.' }
}
