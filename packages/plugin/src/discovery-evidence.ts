import { posix } from 'node:path'

export const DISCOVERY_EVIDENCE_FILE_LIMIT = 6
export const DISCOVERY_EVIDENCE_TERM_LIMIT = 8
export const DISCOVERY_EVIDENCE_TERM_BYTES = 128

const EVIDENCE_PATTERN = 'purpose|workflow|stage|train|freeze|compress|optimi|simulat|analysis|msd|diffusion|conductiv|melt|quench|equation.of.state|eos|temperature|pressure|packmol|^[[:space:]]*#SBATCH[[:space:]]+--(partition|account|qos|nodes|ntasks|ntasks-per-node|cpus-per-task|constraint|exclusive|gres|gpus?|mem|time)(=|[[:space:]])|^[[:space:]]*(module[[:space:]]+load|source[[:space:]]|conda[[:space:]]+activate|micromamba[[:space:]]+activate|srun[[:space:]]|mpirun[[:space:]]|python(3)?[[:space:]]|bash[[:space:]]|sh[[:space:]])|machine|resource|settings|config|input|model|potential|source_list|dpdispatcher|submission|task|command|executable|subprocess|lmp|vasp|nodes|cpu|gpu|tasks|ntasks|queue|exclusive|steps|atoms|structure'

function canonicalEvidenceFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) return undefined
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) return undefined
  const segments = value.split('/')
  if (segments.includes('..')) return undefined
  const normalized = posix.normalize(value)
  if (posix.isAbsolute(normalized)) return normalized === '/' ? undefined : normalized
  if (normalized === '.' || normalized.startsWith('../')) return undefined
  return normalized.startsWith('./') ? normalized : `./${normalized}`
}

export function parseDiscoveryEvidenceFiles(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > DISCOVERY_EVIDENCE_FILE_LIMIT) return undefined
  const files = value.map(canonicalEvidenceFile)
  if (files.some(file => file === undefined)) return undefined
  const canonical = files.filter((file): file is string => file !== undefined)
  return new Set(canonical).size === canonical.length ? canonical : undefined
}

export function parseDiscoveryEvidenceTerms(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > DISCOVERY_EVIDENCE_TERM_LIMIT) {
    return undefined
  }
  const terms = value.map((item) => {
    if (typeof item !== 'string') return undefined
    const term = item.trim()
    if (
      term.length === 0 ||
      Buffer.byteLength(term, 'utf8') > DISCOVERY_EVIDENCE_TERM_BYTES ||
      term.includes('\0') ||
      term.includes('\n') ||
      term.includes('\r')
    ) return undefined
    return term
  })
  if (terms.some(term => term === undefined)) return undefined
  const canonical = terms.filter((term): term is string => term !== undefined)
  return new Set(canonical).size === canonical.length ? canonical : undefined
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function compileDiscoveryEvidenceCommand(
  files: readonly string[],
  evidenceTerms?: readonly string[],
): string {
  const canonical = parseDiscoveryEvidenceFiles(files)
  if (canonical === undefined) throw new Error('Discovery evidenceFiles must contain 1-6 unique relative file paths.')
  const terms = evidenceTerms === undefined ? undefined : parseDiscoveryEvidenceTerms(evidenceTerms)
  if (evidenceTerms !== undefined && terms === undefined) {
    throw new Error('Discovery evidenceTerms must contain 1-8 unique bounded literal terms.')
  }
  const list = canonical.map(shellQuote).join(' ')
  const matches = terms === undefined
    ? `grep -Ein '${EVIDENCE_PATTERN}' "$f"`
    : `grep -Fin ${terms.map(term => `-e ${shellQuote(term)}`).join(' ')} -- "$f"`
  return `{ for f in ${list}; do if [ -f "$f" ]; then printf 'FILE|%s\\n' "$f"; else printf 'MISSING|%s\\n' "$f"; fi; done; for f in ${list}; do test -f "$f" || continue; printf 'EVIDENCE|%s\\n' "$f"; sed -n '1,2p;2q' "$f"; ${matches} | head -n 6 || true; done; } | LC_ALL=C cut -b 1-180 | head -n 64`
}
