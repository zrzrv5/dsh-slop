import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export type ValidationCheck =
  | { kind: 'required-file'; relativePath: string }
  | { kind: 'nonempty-file'; relativePath: string }
  | { kind: 'sha256'; relativePath: string; expected: string }
  | { kind: 'json-parseable'; relativePath: string }
  | { kind: 'numeric-range'; name: string; value: number; min?: number; max?: number }

export interface ValidationEvidence {
  check: ValidationCheck
  outcome: 'valid' | 'invalid' | 'inconclusive'
  summary: string
}

function contained(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('validation path must be relative')
  const target = resolve(root, relativePath)
  const within = relative(resolve(root), target)
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('validation path escapes its root')
  return target
}

export async function runValidationChecks(root: string, checks: readonly ValidationCheck[]): Promise<{ outcome: 'valid' | 'invalid' | 'inconclusive'; evidence: ValidationEvidence[] }> {
  const evidence: ValidationEvidence[] = []
  for (const check of checks) {
    try {
      if (check.kind === 'numeric-range') {
        const valid = Number.isFinite(check.value) && (check.min === undefined || check.value >= check.min) && (check.max === undefined || check.value <= check.max)
        evidence.push({ check, outcome: valid ? 'valid' : 'invalid', summary: valid ? `${check.name} is within range` : `${check.name} is outside range` })
        continue
      }
      const path = contained(root, check.relativePath)
      if (check.kind === 'required-file') {
        const info = await stat(path)
        evidence.push({ check, outcome: info.isFile() ? 'valid' : 'invalid', summary: info.isFile() ? 'required file exists' : 'required path is not a regular file' })
      } else if (check.kind === 'nonempty-file') {
        const info = await stat(path)
        evidence.push({ check, outcome: info.isFile() && info.size > 0 ? 'valid' : 'invalid', summary: info.isFile() && info.size > 0 ? 'file is nonempty' : 'file is empty or not regular' })
      } else if (check.kind === 'sha256') {
        const digest = createHash('sha256').update(await readFile(path)).digest('hex')
        evidence.push({ check, outcome: digest === check.expected ? 'valid' : 'invalid', summary: digest === check.expected ? 'checksum matches' : 'checksum mismatch' })
      } else {
        JSON.parse(await readFile(path, 'utf8'))
        evidence.push({ check, outcome: 'valid', summary: 'JSON parsed successfully' })
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      evidence.push({ check, outcome: code === 'ENOENT' ? 'invalid' : 'inconclusive', summary: code === 'ENOENT' ? 'required evidence is missing' : `check could not be completed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  const outcome = evidence.some(item => item.outcome === 'invalid') ? 'invalid' : evidence.some(item => item.outcome === 'inconclusive') ? 'inconclusive' : 'valid'
  return { outcome, evidence }
}
