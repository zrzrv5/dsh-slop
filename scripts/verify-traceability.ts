import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from 'yaml'

type UnknownRecord = Record<string, unknown>

export interface VerifyTraceabilityOptions {
  readonly rootDirectory?: string
  readonly traceabilityFile?: string
  readonly release?: boolean
}

export interface TraceabilitySummary {
  readonly requirements: number
  readonly releaseGates: number
  readonly pendingReleaseGates: readonly string[]
}

export class TraceabilityVerificationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Traceability verification failed:\n${problems.map(problem => `- ${problem}`).join('\n')}`)
    this.name = 'TraceabilityVerificationError'
  }
}

const REQUIREMENT_KEYS = [
  'id',
  'title',
  'owner_package',
  'status',
  'implementation',
  'public_contracts',
  'ui_surfaces',
  'tests',
  'real_system_evidence',
] as const

const RELEASE_GATE_KEYS = ['id', 'title', 'owner', 'status', 'receipts'] as const
const FILE_REFERENCE_KEYS = ['file', 'symbol'] as const
const TEST_REFERENCE_KEYS = ['file', 'title'] as const
const REAL_EVIDENCE_KEYS = ['required', 'owner', 'status', 'receipts'] as const
const UI_FILE_KEYS = ['file', 'label'] as const
const UI_NOT_APPLICABLE_KEYS = ['not_applicable'] as const
const ID_PATTERN = /^SLOP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/

function record(value: unknown, label: string, problems: string[]): UnknownRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label} must be an object`)
    return undefined
  }
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], label: string, problems: string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) problems.push(`${label} has unknown field '${key}'`)
  for (const key of allowed) if (!(key in value)) problems.push(`${label} is missing required field '${key}'`)
}

function nonEmptyString(value: unknown, label: string, problems: string[]): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${label} must be a non-empty string`)
    return undefined
  }
  return value
}

function array(value: unknown, label: string, problems: string[], allowEmpty = false): readonly unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    problems.push(`${label} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`)
    return []
  }
  return value
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, label: string, problems: string[]): T[number] | undefined {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    problems.push(`${label} must be one of ${allowed.join(', ')}`)
    return undefined
  }
  return value as T[number]
}

function repositoryPath(rootDirectory: string, value: unknown, label: string, problems: string[]): string | undefined {
  const path = nonEmptyString(value, label, problems)
  if (path === undefined) return undefined
  if (path.startsWith('/') || path.split(/[\\/]/).includes('..')) {
    problems.push(`${label} must be a repository-relative path without '..'`)
    return undefined
  }
  const absolute = resolve(rootDirectory, path)
  const repositoryRelative = relative(rootDirectory, absolute)
  if (repositoryRelative === '..' || repositoryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    problems.push(`${label} escapes the repository root`)
    return undefined
  }
  return absolute
}

async function requireFile(rootDirectory: string, value: unknown, label: string, problems: string[]): Promise<string | undefined> {
  const absolute = repositoryPath(rootDirectory, value, label, problems)
  if (absolute === undefined) return undefined
  try {
    if (!(await stat(absolute)).isFile()) problems.push(`${label} does not name a regular file`)
  } catch {
    problems.push(`${label} names a missing repository file`)
  }
  return absolute
}

function collectTestTitles(sourceText: string, filename: string): ReadonlySet<string> {
  const source = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const titles = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const callable = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
          ? expression.expression.text
          : undefined
      const title = node.arguments[0]
      if ((callable === 'it' || callable === 'test') && title !== undefined && ts.isStringLiteralLike(title)) titles.add(title.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return titles
}

async function workspacePackageNames(rootDirectory: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>()
  const packagesDirectory = resolve(rootDirectory, 'packages')
  for (const entry of await readdir(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(resolve(packagesDirectory, entry.name, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof manifest.name === 'string') names.add(manifest.name)
    } catch {
      // A non-package directory is irrelevant to the ownership check.
    }
  }
  return names
}

async function validateFileReferences(
  rootDirectory: string,
  value: unknown,
  label: string,
  problems: string[],
): Promise<void> {
  const rows = array(value, label, problems)
  await Promise.all(rows.map(async (item, index) => {
    const itemLabel = `${label}[${index}]`
    const reference = record(item, itemLabel, problems)
    if (reference === undefined) return
    exactKeys(reference, FILE_REFERENCE_KEYS, itemLabel, problems)
    const absolute = await requireFile(rootDirectory, reference.file, `${itemLabel}.file`, problems)
    const symbol = nonEmptyString(reference.symbol, `${itemLabel}.symbol`, problems)
    if (absolute !== undefined && symbol !== undefined) {
      try {
        if (!(await readFile(absolute, 'utf8')).includes(symbol)) {
          problems.push(`${itemLabel}.symbol '${symbol}' is not present in ${String(reference.file)}`)
        }
      } catch {
        // requireFile has already reported a missing/unreadable file.
      }
    }
  }))
}

async function validateUiSurfaces(rootDirectory: string, value: unknown, label: string, problems: string[]): Promise<void> {
  const rows = array(value, label, problems)
  await Promise.all(rows.map(async (item, index) => {
    const itemLabel = `${label}[${index}]`
    const surface = record(item, itemLabel, problems)
    if (surface === undefined) return
    if ('not_applicable' in surface) {
      exactKeys(surface, UI_NOT_APPLICABLE_KEYS, itemLabel, problems)
      nonEmptyString(surface.not_applicable, `${itemLabel}.not_applicable`, problems)
      return
    }
    exactKeys(surface, UI_FILE_KEYS, itemLabel, problems)
    await requireFile(rootDirectory, surface.file, `${itemLabel}.file`, problems)
    nonEmptyString(surface.label, `${itemLabel}.label`, problems)
  }))
}

async function validateTests(rootDirectory: string, value: unknown, label: string, problems: string[]): Promise<void> {
  const rows = array(value, label, problems)
  await Promise.all(rows.map(async (item, index) => {
    const itemLabel = `${label}[${index}]`
    const reference = record(item, itemLabel, problems)
    if (reference === undefined) return
    exactKeys(reference, TEST_REFERENCE_KEYS, itemLabel, problems)
    const absolute = await requireFile(rootDirectory, reference.file, `${itemLabel}.file`, problems)
    const title = nonEmptyString(reference.title, `${itemLabel}.title`, problems)
    if (absolute === undefined || title === undefined) return
    try {
      const titles = collectTestTitles(await readFile(absolute, 'utf8'), absolute)
      if (!titles.has(title)) problems.push(`${itemLabel}.title does not match an exact it()/test() title in ${String(reference.file)}`)
    } catch {
      // requireFile has already reported a missing/unreadable file.
    }
  }))
}

async function validateReceiptFiles(rootDirectory: string, receipts: readonly unknown[], label: string, problems: string[]): Promise<void> {
  await Promise.all(receipts.map((receipt, index) => requireFile(rootDirectory, receipt, `${label}[${index}]`, problems)))
}

async function validateRealEvidence(
  rootDirectory: string,
  value: unknown,
  label: string,
  release: boolean,
  problems: string[],
): Promise<void> {
  const evidence = record(value, label, problems)
  if (evidence === undefined) return
  exactKeys(evidence, REAL_EVIDENCE_KEYS, label, problems)
  if (typeof evidence.required !== 'boolean') problems.push(`${label}.required must be a boolean`)
  nonEmptyString(evidence.owner, `${label}.owner`, problems)
  const status = enumValue(evidence.status, ['not-required', 'pending', 'complete'] as const, `${label}.status`, problems)
  const receipts = array(evidence.receipts, `${label}.receipts`, problems, true)
  if (evidence.required === false && status !== 'not-required') problems.push(`${label}.status must be not-required when evidence is not required`)
  if (evidence.required === false && receipts.length !== 0) problems.push(`${label}.receipts must be empty when evidence is not required`)
  if (evidence.required === true && status === 'not-required') problems.push(`${label}.status cannot be not-required when evidence is required`)
  if (status === 'complete' && receipts.length === 0) problems.push(`${label}.receipts must contain at least one repository receipt when complete`)
  await validateReceiptFiles(rootDirectory, receipts, `${label}.receipts`, problems)
  if (release && evidence.required === true && status !== 'complete') problems.push(`${label} blocks release until real-system evidence is complete`)
}

export async function verifyTraceability(options: VerifyTraceabilityOptions = {}): Promise<TraceabilitySummary> {
  const rootDirectory = resolve(options.rootDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  const traceabilityFile = resolve(rootDirectory, options.traceabilityFile ?? 'requirements/traceability.yml')
  const release = options.release === true
  const problems: string[] = []
  let parsed: unknown
  try {
    parsed = parse(await readFile(traceabilityFile, 'utf8')) as unknown
  } catch (error) {
    throw new TraceabilityVerificationError([`cannot parse ${relative(rootDirectory, traceabilityFile)}: ${error instanceof Error ? error.message : String(error)}`])
  }

  const document = record(parsed, 'traceability', problems)
  if (document === undefined) throw new TraceabilityVerificationError(problems)
  exactKeys(document, ['schema_version', 'requirements', 'release_gates'], 'traceability', problems)
  if (document.schema_version !== 1) problems.push('traceability.schema_version must equal 1')

  const packages = await workspacePackageNames(rootDirectory)
  const requirements = array(document.requirements, 'traceability.requirements', problems)
  const releaseGates = array(document.release_gates, 'traceability.release_gates', problems)
  const identifiers = new Set<string>()

  for (const [index, item] of requirements.entries()) {
    const label = `traceability.requirements[${index}]`
    const requirement = record(item, label, problems)
    if (requirement === undefined) continue
    exactKeys(requirement, REQUIREMENT_KEYS, label, problems)
    const id = nonEmptyString(requirement.id, `${label}.id`, problems)
    if (id !== undefined && !ID_PATTERN.test(id)) problems.push(`${label}.id must match ${ID_PATTERN}`)
    if (id !== undefined && identifiers.has(id)) problems.push(`${label}.id duplicates '${id}'`)
    if (id !== undefined) identifiers.add(id)
    nonEmptyString(requirement.title, `${label}.title`, problems)
    const owner = nonEmptyString(requirement.owner_package, `${label}.owner_package`, problems)
    if (owner !== undefined && !packages.has(owner)) problems.push(`${label}.owner_package '${owner}' is not a workspace package`)
    const status = enumValue(requirement.status, ['source-complete', 'source-incomplete'] as const, `${label}.status`, problems)
    if (status !== 'source-complete') problems.push(`${label} is a required source row and must be source-complete`)
    await validateFileReferences(rootDirectory, requirement.implementation, `${label}.implementation`, problems)
    await validateFileReferences(rootDirectory, requirement.public_contracts, `${label}.public_contracts`, problems)
    await validateUiSurfaces(rootDirectory, requirement.ui_surfaces, `${label}.ui_surfaces`, problems)
    await validateTests(rootDirectory, requirement.tests, `${label}.tests`, problems)
    await validateRealEvidence(rootDirectory, requirement.real_system_evidence, `${label}.real_system_evidence`, release, problems)
  }

  const pendingReleaseGates: string[] = []
  for (const [index, item] of releaseGates.entries()) {
    const label = `traceability.release_gates[${index}]`
    const gate = record(item, label, problems)
    if (gate === undefined) continue
    exactKeys(gate, RELEASE_GATE_KEYS, label, problems)
    const id = nonEmptyString(gate.id, `${label}.id`, problems)
    if (id !== undefined && !ID_PATTERN.test(id)) problems.push(`${label}.id must match ${ID_PATTERN}`)
    if (id !== undefined && identifiers.has(id)) problems.push(`${label}.id duplicates '${id}'`)
    if (id !== undefined) identifiers.add(id)
    nonEmptyString(gate.title, `${label}.title`, problems)
    nonEmptyString(gate.owner, `${label}.owner`, problems)
    const status = enumValue(gate.status, ['pending', 'complete'] as const, `${label}.status`, problems)
    const receipts = array(gate.receipts, `${label}.receipts`, problems, true)
    if (status === 'complete' && receipts.length === 0) problems.push(`${label}.receipts must contain at least one repository receipt when complete`)
    await validateReceiptFiles(rootDirectory, receipts, `${label}.receipts`, problems)
    if (status === 'pending' && id !== undefined) pendingReleaseGates.push(id)
    if (release && status !== 'complete') problems.push(`${label} blocks release until its real-system receipt is complete`)
  }

  if (problems.length !== 0) throw new TraceabilityVerificationError(problems)
  return { requirements: requirements.length, releaseGates: releaseGates.length, pendingReleaseGates }
}

async function main(): Promise<void> {
  const unknownArguments = process.argv.slice(2).filter(argument => argument !== '--release')
  if (unknownArguments.length !== 0) throw new Error(`unknown argument(s): ${unknownArguments.join(', ')}`)
  const summary = await verifyTraceability({ release: process.argv.includes('--release') })
  const suffix = summary.pendingReleaseGates.length === 0
    ? 'all external release receipts are complete'
    : `external release receipts pending: ${summary.pendingReleaseGates.join(', ')}`
  console.log(`traceability ok: ${summary.requirements} source requirements, ${summary.releaseGates} release gates; ${suffix}`)
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
