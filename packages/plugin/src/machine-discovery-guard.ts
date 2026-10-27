import { discoveryRootInput, resolveDiscoveryRootCommand, resolvedDiscoveryRoot } from './resolve-discovery-root.ts'
import { DISCOVERY_CENSUS_COMMAND, compileDiscoveryProjectPage, discoveryFocus } from './discovery-pages.ts'
import { readKnowledgeTable, renderKnowledgeTable } from '@dsh-slop/knowledge'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  compileDiscoveryEvidenceCommand,
  parseDiscoveryEvidenceFiles,
  parseDiscoveryEvidenceTerms,
} from './discovery-evidence.ts'

const DISCOVERY_SKILLS = new Set(['deep-discover', 'machine-discovery'])
const SHELL_TOOL = 'slop_machine_shell'
const MACHINE_GET_TOOL = 'slop_machine_get'
const MACHINE_CONNECT_TOOL = 'slop_machine_connect'
const KNOWLEDGE_WRITE_TOOL = 'slop_knowledge_write'
const PER_CALL_OUTPUT_BYTES = 12 * 1_024
const TURN_OUTPUT_BYTES = 256 * 1_024
const MAX_ATTEMPTS = 32
const MAX_SELECTED_PROJECT_PATHS = 12
const MAX_ENUMERATION_ROWS = 64
const MAX_PROJECT_CALLS = 5
const MAX_TIMEOUT_MS = 20_000
const MAX_HOME_KNOWLEDGE_CREATE_BYTES = 4 * 1_024
const MAX_WORKSPACE_KNOWLEDGE_CREATE_BYTES = 16 * 1_024
const CENSUS_DISCOVERY_KEYS = new Set(['phase', 'root', 'purpose'])
const PROJECT_DISCOVERY_KEYS = new Set(['phase', 'projectPath', 'purpose', 'selectionPlan', 'focus'])
const SHELL_ARGUMENT_KEYS = new Set([
  'machineId',
  'machineAlias',
  'command',
  'evidenceFiles',
  'evidenceTerms',
  'workdir',
  'timeoutMs',
  'discovery',
])

interface DeclaredRoot {
  readonly path: string
  readonly role?: string
}

interface CensusDiscovery {
  readonly phase: 'census'
  readonly root: string
  readonly purpose: string
}

interface ProjectReadDiscovery {
  readonly phase: 'project-read'
  readonly projectPath: string
  readonly purpose: string
  readonly selectionPlan?: readonly string[]
  readonly focus?: string
}

type DiscoveryMetadata = CensusDiscovery | ProjectReadDiscovery | { readonly phase: 'resolve-root'; readonly root: string; readonly purpose: string }

interface ShellArguments {
  readonly machineId: string
  readonly command: string
  readonly evidenceFiles?: readonly string[]
  readonly evidenceTerms?: readonly string[]
  readonly workdir: string
  readonly timeoutMs: number
  readonly discovery: DiscoveryMetadata
}

interface ShellReservation {
  readonly callId: string
  readonly machineId: string
  readonly discovery: DiscoveryMetadata
  readonly observesRoot: boolean
  readonly runsFocusedRecovery: boolean
  outputAccounted: boolean
}

interface TurnState {
  readonly turn: number
  active: boolean
  terminalFailure?: 'remote-diagnostic' | 'knowledge-write' | 'local-program'
  localProgramFailures: number
  recoverableWriteFailures: number
  remoteDiagnosticFailures: number
  readonly recoverableShellCalls: Set<string>
  attempts: number
  outputBytes: number
  schedulerHistoryCalls: number
  queueCalls: number
  inFlightCallId?: string
  knowledgeWriteInFlightCallId?: string
  readonly seenAttemptCallIds: Set<string>
  readonly commandHashes: Set<string>
  readonly declaredRootsByMachine: Map<string, readonly DeclaredRoot[]>
  readonly sensitiveKnowledgeMarkersByMachine: Map<string, readonly string[]>
  readonly connectionStatesByMachine: Map<string, string>
  readonly observedRoots: Set<string>
  readonly projectPaths: Set<string>
  readonly projectSelectionPlansByMachine: Map<string, readonly string[]>
  readonly projectCalls: Map<string, number>
  readonly observedProjectPaths: Map<string, Set<string>>
  readonly observedProjectWorkstreams: Map<string, Set<string>>
  readonly observedProjectFiles: Map<string, Set<string>>
  readonly observedProjectEvidenceLines: Map<string, Map<string, Set<string>>>
  readonly focusedRecoveryProjectPaths: Set<string>
  readonly failedProjectPaths: Set<string>
  readonly knowledgeWriteOuterCallIds: Set<string>
  readonly successfulWriteOuterCallIds: Set<string>
  readonly projectSelectionCompleteCalls: Map<string, DiscoveryShellBudget>
  readonly duplicateSuppressedCalls: Map<string, DiscoveryShellBudget>
  readonly projectOutsidePlanCalls: Map<string, DiscoveryShellBudget>
  readonly unobservedEvidenceCalls: Map<string, Readonly<{
    budget: DiscoveryShellBudget
    unobservedPaths: readonly string[]
    observedPaths: readonly string[]
  }>>
  readonly focusedRecoveryRequiredCalls: Map<string, DiscoveryShellBudget>
  readonly reservations: Map<string, ShellReservation>
}

export interface DiscoveryShellBudget {
  readonly shellAttemptsUsed: number
  readonly shellAttemptsRemaining: number
  readonly selectedProjectPaths: number
  readonly turnOutputBytesRemaining: number
}

export type DiscoveryShellOutputDecision =
  | { readonly kind: 'accept'; readonly budget?: DiscoveryShellBudget }
  | {
      readonly kind: 'reject-bounds'
      readonly observedBytes: number
      readonly perCallLimitBytes: number
      readonly remainingTurnBytes: number
    }
  | {
      readonly kind: 'reject-diagnostic'
      readonly diagnostic: string
    }

export type DiscoveryShellRequestDecision =
  | { readonly kind: 'execute' }
  | { readonly kind: 'project-selection-complete'; readonly budget: DiscoveryShellBudget }
  | { readonly kind: 'duplicate-suppressed'; readonly budget: DiscoveryShellBudget }
  | { readonly kind: 'project-not-in-plan'; readonly budget: DiscoveryShellBudget }
  | {
      readonly kind: 'evidence-not-observed'
      readonly budget: DiscoveryShellBudget
      readonly unobservedPaths: readonly string[]
      readonly observedPaths: readonly string[]
    }
  | { readonly kind: 'focused-recovery-required'; readonly budget: DiscoveryShellBudget }

const FATAL_REMOTE_DIAGNOSTIC = /(?:syntax error near unexpected token|unexpected newline or end of string|unexpected EOF while looking for matching|unterminated quoted string)/iu

function fatalRemoteDiagnostic(stderr: string): string | undefined {
  const line = stderr.split('\n').find(candidate => FATAL_REMOTE_DIAGNOSTIC.test(candidate))
  return line?.trim().slice(0, 512)
}

function objectField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function hasOnlyKeys(value: unknown, allowed: ReadonlySet<string>): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.has(key))
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function openTurn(agent: Agent): number | undefined {
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    const event = agent.session.eventAt(SessionSeq(index))
    if (event?.type === 'turn/end') return undefined
    if (event?.type === 'turn/start') return event.data.turn
  }
  return undefined
}

function hasDirectSkillInvocation(agent: Agent): boolean {
  for (let index = agent.session.seq - 1; index >= 0; index -= 1) {
    const event = agent.session.eventAt(SessionSeq(index))
    if (event?.type === 'turn/start') return false
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (objectField(source, 'kind') === 'skill-invocation'
      && DISCOVERY_SKILLS.has(String(objectField(source, 'name')))
      && objectField(source, 'form') === 'instructions') return true
  }
  return false
}

function newTurnState(agent: Agent, turn: number): TurnState {
  return {
    turn,
    active: hasDirectSkillInvocation(agent),
    localProgramFailures: 0,
    recoverableWriteFailures: 0,
    remoteDiagnosticFailures: 0,
    recoverableShellCalls: new Set(),
    attempts: 0,
    outputBytes: 0,
    schedulerHistoryCalls: 0,
    queueCalls: 0,
    seenAttemptCallIds: new Set(),
    commandHashes: new Set(),
    declaredRootsByMachine: new Map(),
    sensitiveKnowledgeMarkersByMachine: new Map(),
    connectionStatesByMachine: new Map(),
    observedRoots: new Set(),
    projectPaths: new Set(),
    projectSelectionPlansByMachine: new Map(),
    projectCalls: new Map(),
    observedProjectPaths: new Map(),
    observedProjectWorkstreams: new Map(),
    observedProjectFiles: new Map(),
    observedProjectEvidenceLines: new Map(),
    focusedRecoveryProjectPaths: new Set(),
    failedProjectPaths: new Set(),
    knowledgeWriteOuterCallIds: new Set(),
    successfulWriteOuterCallIds: new Set(),
    projectSelectionCompleteCalls: new Map(),
    duplicateSuppressedCalls: new Map(),
    projectOutsidePlanCalls: new Map(),
    unobservedEvidenceCalls: new Map(),
    focusedRecoveryRequiredCalls: new Map(),
    reservations: new Map(),
  }
}

function discoveryBudget(state: TurnState): DiscoveryShellBudget {
  return {
    shellAttemptsUsed: state.attempts,
    shellAttemptsRemaining: Math.max(0, MAX_ATTEMPTS - state.attempts),
    selectedProjectPaths: state.projectPaths.size,
    turnOutputBytesRemaining: Math.max(0, TURN_OUTPUT_BYTES - state.outputBytes),
  }
}

function outerCallId(callId: string): string {
  const separator = callId.indexOf(':code:')
  return separator < 0 ? callId : callId.slice(0, separator)
}

function canonicalRemotePath(value: unknown): string | undefined {
  const path = nonEmptyString(value)
  if (path === undefined || !posix.isAbsolute(path) || path.includes('\0')) return undefined
  if (path.split('/').includes('..')) return undefined
  return posix.normalize(path)
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function censusKey(machineId: string, root: string): string {
  return `${machineId}\0${root}`
}

function projectKey(machineId: string, path: string): string {
  return `${machineId}\0${path}`
}

function canonicalObservedPath(value: string): string | undefined {
  const [path] = parseDiscoveryEvidenceFiles([value]) ?? []
  return path
}

interface ObservedProjectOutput {
  readonly paths: readonly string[]
  readonly workstreams: readonly string[]
  readonly files: readonly string[]
  readonly evidenceLines: ReadonlyMap<string, readonly string[]>
}

function observedProjectOutput(stdout: string): ObservedProjectOutput {
  const paths = new Set<string>()
  const workstreams = new Set<string>()
  const files = new Set<string>()
  const evidenceLines = new Map<string, string[]>()
  let currentEvidenceFile: string | undefined
  const fileRecordKinds = new Set([
    'MEANING',
    'OUTER',
    'DRIVER',
    'CONFIG',
    'CANDIDATE',
    'FOCUSED',
    'FILE',
    'EVIDENCE',
  ])
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('|')
    const recordKind = separator > 0 ? line.slice(0, separator) : undefined
    if (recordKind === 'WORKSTREAM' || (recordKind !== undefined && fileRecordKinds.has(recordKind))) {
      const path = canonicalObservedPath(line.slice(separator + 1).trim())
      if (path !== undefined) {
        paths.add(path)
        if (recordKind === 'WORKSTREAM') workstreams.add(path)
        else files.add(path)
        if (recordKind === 'EVIDENCE') {
          currentEvidenceFile = path
          if (!evidenceLines.has(path)) evidenceLines.set(path, [])
        }
      }
    }
    if (recordKind !== undefined && fileRecordKinds.has(recordKind)) continue
    if (currentEvidenceFile !== undefined && line.length > 0) {
      evidenceLines.get(currentEvidenceFile)?.push(line.replace(/^\d+:/u, ''))
    }
    for (const match of line.matchAll(/(?:^|[\s("'`=:,])((?:\.\/|\/)[^\s"'`(){}[\],;|]+)/gu)) {
      const candidate = match[1]
      if (candidate === undefined) continue
      const path = canonicalObservedPath(candidate)
      if (path !== undefined) paths.add(path)
    }
  }
  return { paths: [...paths], workstreams: [...workstreams], files: [...files], evidenceLines }
}

function projectRelativeEvidencePath(
  input: ShellArguments,
  projectPath: string,
  evidenceFile: string,
): string | undefined {
  if (input.workdir === projectPath) return evidenceFile
  const prefix = `./${posix.basename(projectPath)}/`
  if (!evidenceFile.startsWith(prefix)) return undefined
  return canonicalObservedPath(`./${evidenceFile.slice(prefix.length)}`)
}

function focusedEnumerationPath(command: string): string | undefined {
  if (!command.includes('FOCUSED|')) return undefined
  const match = /\bfind\s+(?:'([^']+)'|"([^"]+)"|(\.[^\s;|]+))/u.exec(command)
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3]
  if (candidate === undefined || candidate === '.') return undefined
  return canonicalObservedPath(candidate)
}

function isWholeProjectFocusedEnumeration(command: string): boolean {
  return command.includes('FOCUSED|')
    && focusedEnumerationPath(command) === undefined
    && /\bfind\s+\./u.test(command)
}

function isProjectScopedWorkdir(input: ShellArguments, projectPath: string): boolean {
  if (input.workdir === projectPath) return true
  if (input.evidenceFiles === undefined || input.workdir !== posix.dirname(projectPath)) return false
  const projectPrefix = `./${posix.basename(projectPath)}/`
  return input.evidenceFiles.every(file => file.startsWith(projectPrefix))
}

function parseDiscovery(value: unknown): DiscoveryMetadata | undefined {
  const phase = objectField(value, 'phase')
  const purpose = nonEmptyString(objectField(value, 'purpose'))
  if (purpose === undefined) return undefined
  if (phase === 'resolve-root') {
    if (!hasOnlyKeys(value, CENSUS_DISCOVERY_KEYS)) return undefined
    const root = discoveryRootInput(objectField(value, 'root'))
    return root === undefined ? undefined : { phase, root, purpose }
  }
  if (phase === 'census') {
    if (!hasOnlyKeys(value, CENSUS_DISCOVERY_KEYS)) return undefined
    const root = canonicalRemotePath(objectField(value, 'root'))
    return root === undefined ? undefined : { phase, root, purpose }
  }
  if (phase === 'project-read') {
    if (!hasOnlyKeys(value, PROJECT_DISCOVERY_KEYS)) return undefined
    const projectPath = canonicalRemotePath(objectField(value, 'projectPath'))
    const rawPlan = objectField(value, 'selectionPlan')
    const rawFocus = objectField(value, 'focus')
    const focus = discoveryFocus(rawFocus)
    if (rawFocus !== undefined && focus === undefined) return undefined
    let selectionPlan: readonly string[] | undefined
    if (rawPlan !== undefined) {
      if (!Array.isArray(rawPlan) || rawPlan.length < 1 || rawPlan.length > MAX_SELECTED_PROJECT_PATHS) return undefined
      const paths = rawPlan.map(canonicalRemotePath)
      if (paths.some(path => path === undefined)) return undefined
      selectionPlan = paths as readonly string[]
      if (new Set(selectionPlan).size !== selectionPlan.length) return undefined
    }
    return projectPath === undefined
      ? undefined
      : { phase, projectPath, purpose, ...(selectionPlan === undefined ? {} : { selectionPlan }), ...(focus === undefined ? {} : { focus }) }
  }
  return undefined
}

function parseShellArguments(value: unknown): ShellArguments | undefined {
  if (!hasOnlyKeys(value, SHELL_ARGUMENT_KEYS)) return undefined
  const machineId = nonEmptyString(objectField(value, 'machineId'))
  const suppliedCommand = nonEmptyString(objectField(value, 'command'))
  const evidenceFiles = parseDiscoveryEvidenceFiles(objectField(value, 'evidenceFiles'))
  const hasEvidenceFiles = objectField(value, 'evidenceFiles') !== undefined
  const evidenceTerms = parseDiscoveryEvidenceTerms(objectField(value, 'evidenceTerms'))
  const hasEvidenceTerms = objectField(value, 'evidenceTerms') !== undefined
  const workdir = canonicalRemotePath(objectField(value, 'workdir'))
  const timeoutMs = objectField(value, 'timeoutMs')
  const discovery = parseDiscovery(objectField(value, 'discovery'))
  if (machineId !== undefined && discovery?.phase === 'resolve-root') {
    if (objectField(value, 'command') !== undefined || objectField(value, 'workdir') !== undefined || hasEvidenceFiles || hasEvidenceTerms || typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return undefined
    return { machineId, discovery, timeoutMs, command: resolveDiscoveryRootCommand(discovery.root), workdir: '/' }
  }
  if (machineId === undefined || workdir === undefined || discovery === undefined || discovery.phase === 'resolve-root'
    || typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)) return undefined
  const generatedPage = suppliedCommand === undefined && !hasEvidenceFiles
  if ((!generatedPage && (suppliedCommand === undefined) === !hasEvidenceFiles) || (hasEvidenceFiles && evidenceFiles === undefined)) return undefined
  if (discovery.phase === 'project-read' && discovery.focus !== undefined && !generatedPage) return undefined
  if (evidenceFiles !== undefined && discovery.phase !== 'project-read') return undefined
  if (hasEvidenceTerms && (evidenceFiles === undefined || evidenceTerms === undefined)) return undefined
  const command = generatedPage ? discovery.phase === 'census' ? DISCOVERY_CENSUS_COMMAND : compileDiscoveryProjectPage(discovery.focus)
    : suppliedCommand ?? compileDiscoveryEvidenceCommand(evidenceFiles ?? [], evidenceTerms)
  return {
    machineId,
    command,
    ...(evidenceFiles === undefined ? {} : { evidenceFiles }),
    ...(evidenceTerms === undefined ? {} : { evidenceTerms }),
    workdir,
    timeoutMs,
    discovery,
  }
}

function isEmptyProjectEvidenceSelection(value: unknown): boolean {
  const evidenceFiles = objectField(value, 'evidenceFiles')
  const workdir = canonicalRemotePath(objectField(value, 'workdir'))
  const timeoutMs = objectField(value, 'timeoutMs')
  const discovery = parseDiscovery(objectField(value, 'discovery'))
  return objectField(value, 'command') === undefined
    && Array.isArray(evidenceFiles)
    && evidenceFiles.length === 0
    && nonEmptyString(objectField(value, 'machineId')) !== undefined
    && typeof timeoutMs === 'number'
    && Number.isInteger(timeoutMs)
    && timeoutMs >= 1
    && timeoutMs <= MAX_TIMEOUT_MS
    && discovery?.phase === 'project-read'
    && workdir === discovery.projectPath
}

function extractMachineContext(value: unknown): {
  readonly machineId: string
  readonly roots: readonly DeclaredRoot[]
  readonly connectionState: string
  readonly sensitiveKnowledgeMarkers: readonly string[]
} | undefined {
  if (objectField(value, 'ok') !== true) return undefined
  const machine = objectField(objectField(value, 'value'), 'machine')
  const machineId = nonEmptyString(objectField(machine, 'id'))
  const connectionState = nonEmptyString(objectField(machine, 'connectionState'))
  const rootsValue = objectField(objectField(machine, 'baseConfiguration'), 'declaredRoots')
  if (machineId === undefined || connectionState === undefined || !Array.isArray(rootsValue)) return undefined
  const roots: DeclaredRoot[] = []
  for (const rootValue of rootsValue) {
    const path = canonicalRemotePath(objectField(objectField(rootValue, 'path'), 'path'))
    if (path === undefined) continue
    const role = nonEmptyString(objectField(rootValue, 'role'))
    roots.push(role === undefined ? { path } : { path, role })
  }
  const sensitiveKnowledgeMarkers = new Set<string>()
  for (const root of roots) {
    sensitiveKnowledgeMarkers.add(root.path)
    const segments = root.path.split('/').filter(Boolean)
    if (segments.length >= 3) sensitiveKnowledgeMarkers.add(posix.dirname(root.path))
  }
  for (const key of ['target', 'host', 'username'] as const) {
    const marker = nonEmptyString(objectField(machine, key))
    if (marker !== undefined) sensitiveKnowledgeMarkers.add(marker)
  }
  return { machineId, roots, connectionState, sensitiveKnowledgeMarkers: [...sensitiveKnowledgeMarkers] }
}

function knowledgeWriteText(value: unknown): string {
  const chunks: string[] = []
  const content = objectField(value, 'content')
  if (typeof content === 'string') chunks.push(content)
  const contentTables = objectField(value, 'contentTables')
  if (Array.isArray(contentTables)) {
    for (const value of contentTables) {
      const table = readKnowledgeTable(value)
      if (table !== undefined) chunks.push(renderKnowledgeTable(table))
    }
  }
  const replacements = objectField(value, 'sectionReplacements')
  if (Array.isArray(replacements)) {
    for (const replacement of replacements) {
      const table = readKnowledgeTable(objectField(replacement, 'table'))
      if (table !== undefined) chunks.push(renderKnowledgeTable(table))
      const body = objectField(replacement, 'body')
      if (typeof body === 'string') chunks.push(body)
      const bodyLines = objectField(replacement, 'bodyLines')
      if (Array.isArray(bodyLines)) {
        chunks.push(bodyLines.filter((line): line is string => typeof line === 'string').join('\n'))
      }
    }
  }
  return chunks.join('\n\n')
}

function markdownTableRows(markdown: string, header: string): readonly (readonly string[])[] {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex(line => line.trim() === header)
  if (start < 0 || !/^\|\s*-+/u.test(lines[start + 1]?.trim() ?? '')) return []
  const rows: string[][] = []
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break
    rows.push(line.split(/(?<!\\)\|/u).slice(1, -1).map(cell => cell.trim()))
  }
  return rows
}

function workspaceSourcePath(project: string, value: string, workRoot?: string): string | undefined {
  const source = value.replaceAll('`', '').trim()
  const anchoredPrefix = `<work-root>/${project}/`
  if (workRoot !== undefined && source.startsWith('<work-root>/') && !source.startsWith(anchoredPrefix)) {
    return canonicalObservedPath(`${workRoot}/${source.slice('<work-root>/'.length)}`)
  }
  const projectPrefix = `${project}/`
  const relative = source.startsWith(anchoredPrefix)
    ? `./${source.slice(anchoredPrefix.length)}`
    : source.startsWith(projectPrefix)
      ? `./${source.slice(projectPrefix.length)}`
      : source.startsWith('./')
        ? source
        : `./${source}`
  return canonicalObservedPath(relative)
}

function anchorObservedEvidenceLine(
  line: string,
  projectPath: string,
  project: string,
  declaredWorkRoot: string | undefined,
): string {
  return line
    .split(declaredWorkRoot ?? projectPath).join(declaredWorkRoot === undefined ? `<work-root>/${project}` : '<work-root>')
    .replace(/\/work\/[^/\s`'"]+\/(?:codes|software|apps)(?=\/)/gu, '<site-software-root>')
}

function isActiveWorkerCommand(line: string): boolean {
  if (/^\s*(?:#|from\s|import\s)/u.test(line)) return false
  return /\b(?:subprocess\.(?:run|Popen)|os\.system|exec|spawn)\s*\(/u.test(line)
    || /^\s*(?:[./][\w./-]+|[\w-]+)(?:\s+[^=]|$)/u.test(line)
    || /\b(?:exec|command)\s*[:=]\s*["'][^"']+['"]/u.test(line)
}

function evidenceLinesForProject(
  state: TurnState,
  project: string,
): Readonly<{
  projectPath: string
  declaredWorkRoot: string | undefined
  byFile: ReadonlyMap<string, Set<string>>
}> | undefined {
  const matches = [...state.observedProjectEvidenceLines.entries()]
    .filter(([key]) => posix.basename(key.slice(key.indexOf('\0') + 1)) === project)
  if (matches.length !== 1) return undefined
  const [key, byFile] = matches[0] as [string, Map<string, Set<string>>]
  const separator = key.indexOf('\0')
  const machineId = key.slice(0, separator)
  const projectPath = key.slice(separator + 1)
  const declaredWorkRoot = state.declaredRootsByMachine.get(machineId)
    ?.filter(root => isWithin(projectPath, root.path))
    .sort((left, right) => right.path.length - left.path.length)[0]?.path
  return { projectPath, declaredWorkRoot, byFile }
}

function workspaceDiscoveryKnowledgeReason(state: TurnState, value: unknown, text: string): string | undefined {
  if (objectField(value, 'scope') !== 'workspace') return undefined
  const classificationRows = markdownTableRows(text, '| Entry | Category | Evidence tier |')
  const sectionUpdate = objectField(value, 'operation') === 'replace-sections'
  if (classificationRows.length === 0 && !sectionUpdate) {
    return 'Deep Discovery Workspace Knowledge must contain the complete one-entry root classification table.'
  }
  const bindingRows = markdownTableRows(text, '| Project | Edge | Source file | Active line | Status |')
  if (bindingRows.length === 0 && !sectionUpdate) {
    return 'Deep Discovery Workspace Knowledge must contain the edge-level binding table; prose summaries are not a substitute.'
  }
  for (const row of bindingRows) {
    const project = row[0] ?? 'unknown project'
    const edge = (row[1] ?? '').toLowerCase()
    const activeLine = (row[3] ?? '').replaceAll('`', '').trim()
    const status = (row[4] ?? '').toLowerCase()
    if (status !== 'direct') continue
    if (/^(?:from|import)\s/u.test(activeLine)) {
      return `Deep Discovery cannot use an import as a direct execution edge for ${project}.`
    }
    if (edge.includes('worker') && !isActiveWorkerCommand(activeLine)) {
      return `Deep Discovery direct worker edge for ${project} must contain an active worker command, not only a config or resource reference.`
    }
    if (edge.includes('config')
      && !/(?:^\s*#(?:SBATCH|PBS)\s|load_from_json|settings|resource|machine|config|\.ya?ml|\.json|\.in\b)/iu.test(activeLine)) {
      return `Deep Discovery direct config edge for ${project} must contain an active config reference.`
    }
    const projectEvidence = evidenceLinesForProject(state, project)
    const sourcePath = workspaceSourcePath(project, row[2] ?? '', projectEvidence?.declaredWorkRoot)
    const evidenceForSource = sourcePath === undefined ? undefined : projectEvidence?.byFile.get(sourcePath)
    if (sourcePath === undefined || projectEvidence === undefined || evidenceForSource === undefined) {
      return `Deep Discovery direct edge for ${project} must cite a FILE returned for that project in this turn.`
    }
    const exactActiveLine = activeLine.replaceAll('\\|', '|')
    const lineWasReturned = [...evidenceForSource]
      .some(line => anchorObservedEvidenceLine(
        line,
        projectEvidence.projectPath,
        project,
        projectEvidence.declaredWorkRoot,
      ).trim() === exactActiveLine)
    if (!lineWasReturned) {
      return `Deep Discovery direct edge for ${project} must quote one active line returned verbatim from its cited FILE.`
    }
  }
  const selectedNames = new Set([...state.projectPaths].map(key => posix.basename(key.slice(key.indexOf('\0') + 1))))
  for (const row of classificationRows) {
    const entry = row[0] ?? ''
    const category = row[1] ?? ''
    const evidenceTier = row[2] ?? ''
    if (!selectedNames.has(entry) && (category !== 'unclassified' || evidenceTier !== 'census')) {
      return `Deep Discovery cannot classify unread root ${entry}; preserve it as unclassified with census evidence.`
    }
  }
  return undefined
}

function knowledgeWriteReason(state: TurnState, value: unknown): string | undefined {
  const text = knowledgeWriteText(value)
  const mode = objectField(value, 'mode')
  const scope = objectField(value, 'scope')
  if (mode === 'create' && (scope === 'home' || scope === 'workspace')) {
    const limit = scope === 'home' ? MAX_HOME_KNOWLEDGE_CREATE_BYTES : MAX_WORKSPACE_KNOWLEDGE_CREATE_BYTES
    if (Buffer.byteLength(text, 'utf8') > limit) {
      return `Deep Discovery Knowledge creates must stay concise: Home at most ${String(MAX_HOME_KNOWLEDGE_CREATE_BYTES)} bytes and Workspace at most ${String(MAX_WORKSPACE_KNOWLEDGE_CREATE_BYTES)} bytes.`
    }
  }
  for (const markers of state.sensitiveKnowledgeMarkersByMachine.values()) {
    const marker = markers.find(candidate => candidate.length >= 3 && text.includes(candidate))
    if (marker !== undefined) {
      return 'Deep Discovery Knowledge must replace exact Machine roots, their identity-bearing parents, endpoints, and usernames with stable anchors.'
    }
  }
  if (/(?:^|[\s("'`])\/(?:Users|home)\/[^/\s]+(?:\/|\b)/u.test(text)
    || /(?:^|[\s("'`])\/work\/[^/\s]+\/[^/\s]+(?:\/|\b)/u.test(text)) {
    return 'Deep Discovery Knowledge must not contain identity-bearing absolute home or work paths; use stable anchors.'
  }
  if (/\bMachine Info proposal\b/iu.test(text)) {
    return 'Deep Discovery Knowledge must not contain the Chat-only Machine Info proposal or its label.'
  }
  const workspaceReason = workspaceDiscoveryKnowledgeReason(state, value, text)
  if (workspaceReason !== undefined) return workspaceReason
  return undefined
}

function isSuccessfulShellResult(result: Readonly<ToolExecutionResult>): boolean {
  if (result.isError || objectField(result.value, 'ok') !== true) return false
  const value = objectField(result.value, 'value')
  return objectField(value, 'exitCode') === 0 && objectField(value, 'timedOut') === false
}

function headLimit(command: string): { readonly count: number; readonly index: number } | undefined {
  const match = /\bhead\s+(?:(?:-n\s*)|-)(\d+)\b/i.exec(command)
  if (match?.index === undefined) return undefined
  const count = Number(match[1])
  return Number.isSafeInteger(count) ? { count, index: match.index } : undefined
}

function terminalHeadLimit(command: string): number | undefined {
  const matches = [...command.matchAll(/\bhead\s+(?:(?:-n\s*)|-)(\d+)\b/gi)]
  const match = matches.at(-1)
  if (match?.index === undefined || match[1] === undefined) return undefined
  const count = Number(match[1])
  if (!Number.isSafeInteger(count)) return undefined
  const tail = command.slice(match.index + match[0].length)
  return /[;|&{}\n]/u.test(tail) ? undefined : count
}

function unquotedShellText(command: string): string {
  let quote: "'" | '"' | undefined
  let escaped = false
  let output = ''
  for (const character of command) {
    if (escaped) {
      output += quote === undefined ? character : ' '
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      output += quote === undefined ? character : ' '
      continue
    }
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character
      output += ' '
      continue
    }
    if (character === quote) {
      quote = undefined
      output += ' '
      continue
    }
    output += quote === undefined ? character : ' '
  }
  return output
}

function unquotedSegmentFrom(command: string, index: number): string {
  const unquoted = unquotedShellText(command)
  let end = command.length
  for (let cursor = index; cursor < unquoted.length; cursor += 1) {
    const character = unquoted[cursor]
    if (character === ';' || character === '\n'
      || (character === '&' && unquoted[cursor + 1] === '&')
      || (character === '|' && unquoted[cursor + 1] === '|')) {
      end = cursor
      break
    }
  }
  return command.slice(index, end)
}

function findShape(command: string, phase: DiscoveryMetadata['phase']): { readonly reason?: string; readonly observesRoot: boolean } {
  const unquoted = unquotedShellText(command)
  const findMatches = [...unquoted.matchAll(/\bfind\b/gi)]
  if (findMatches.length === 0) {
    const limit = headLimit(command)
    const boundedList = phase === 'census'
      && /(?:^|[;\n|])\s*ls\s+(?:-[A-Za-z]*[1Aa][A-Za-z]*\s+)?(?:--\s+)?["']?[.][/]?["']?(?:\s|$)/i.test(command)
      && limit !== undefined
      && limit.count <= MAX_ENUMERATION_ROWS
    return { observesRoot: boundedList }
  }
  let observesRoot = phase === 'census' && findMatches.length === 1
  for (const findMatch of findMatches) {
    if (findMatch.index === undefined) continue
    const segment = unquotedSegmentFrom(command, findMatch.index)
    const depthMatches = [...segment.matchAll(/-maxdepth\s+(\d+)\b/gi)]
    if (depthMatches.length !== 1) {
      return { reason: 'Each find requires exactly one explicit -maxdepth during Deep Discovery.', observesRoot: false }
    }
    const depth = Number(depthMatches[0]?.[1])
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 3) {
      return { reason: 'Deep Discovery find depth must be between 1 and 3.', observesRoot: false }
    }
    if (phase === 'census' && depth !== 1) {
      return { reason: 'A census is depth-one only; use -maxdepth 1.', observesRoot: false }
    }
    const limit = headLimit(segment)
    const quitIndex = segment.search(/-quit\b/i)
    const limiterIndex = limit?.index ?? (quitIndex >= 0 ? quitIndex : undefined)
    if (limiterIndex === undefined || (limit !== undefined && limit.count > MAX_ENUMERATION_ROWS)) {
      return { reason: `Each find must stop with -quit or head -n ${String(MAX_ENUMERATION_ROWS)} or less.`, observesRoot: false }
    }
    const sortIndex = segment.search(/\bsort\b/i)
    if (sortIndex >= 0 && sortIndex < limiterIndex) {
      return { reason: 'Limit filesystem enumeration before sort.', observesRoot: false }
    }
    observesRoot &&= depth === 1
      && /\bfind\s+(?:--\s+)?["']?[.][/]?["']?(?:\s|$)/i.test(segment)
      && /-mindepth\s+1\b/i.test(segment)
      && !/-type\s+/i.test(segment)
      && quitIndex < 0
      && limit !== undefined
  }
  return { observesRoot }
}

function literalAbsolutePaths(command: string): readonly string[] {
  const matches = command.matchAll(/(?:^|[\s=("'`])((?:\/[A-Za-z0-9_.$+*-]+)+)/gu)
  return [...matches].map(match => match[1]).filter((path): path is string => path !== undefined)
}

function mutationOrSensitiveReason(command: string): string | undefined {
  const unquoted = unquotedShellText(command).toLowerCase()
  const invocations = unquoted.replace(/\bcommand\s+-v\s+[^;\n]+/g, '')
  const withoutBoundedDate = command.replace(
    /\$\(\s*date\s+-d\s+["'](?:[1-9]\d?|[12]\d\d|3[0-5]\d|36[0-6])\s+days?\s+ago["']\s+\+%F\s*\)/gi,
    '',
  )
  if (withoutBoundedDate.includes('$(') || withoutBoundedDate.includes('`')) {
    return 'Deep Discovery rejects opaque command substitution; use fixed read-only commands.'
  }
  if (/\b(?:sh|bash|zsh|fish)\s+-c\b/.test(invocations)
    || /\b(?:eval|exec|xargs)\b/.test(invocations)
    || /\bfind\b[^;\n]*(?:-delete|-exec|-execdir|-ok|-okdir)\b/i.test(command)
    || /\bsystem\s*\(|\|\s*getline\b/i.test(command)) {
    return 'Deep Discovery rejects opaque or indirect command execution.'
  }
  if (/\b(?:rm|mv|cp|install|touch|mkdir|rmdir|chmod|chown|chgrp|ln|tee|truncate|dd|rsync|scp|sftp|curl|wget|git)\b/.test(invocations)
    || /\b(?:python|python3|perl|ruby|node)\b/.test(invocations)
    || /\bsed\b[^;\n]*\s-i(?:\s|$)/.test(invocations)) {
    return 'Deep Discovery is read-only; filesystem, network, or opaque script mutations are forbidden.'
  }
  if (/(?:^|[;\n]|&&|\|\|)\s*(?:source|[.])\s+/.test(invocations)
    || /\bmodule\s+(?:load|unload|purge|swap)\b/.test(invocations)
    || /\b(?:conda|micromamba)\s+(?:activate|install|create|remove)\b/.test(invocations)) {
    return 'Deep Discovery may inspect environment configuration but must not execute or alter it.'
  }
  const withoutSafeRedirects = invocations
    .replace(/\d*>\s*\/dev\/null\b/g, '')
    .replace(/\d*>\s*&\s*\d+/g, '')
  if (/(^|[^<])>>?\s*[^&]/.test(withoutSafeRedirects)) {
    return 'Deep Discovery commands may not redirect output into remote files.'
  }
  if (/\b(?:history|printenv)\b/.test(invocations)
    || /(?:^|[\s/])(?:[.]ssh|[.]aws|[.]netrc|credentials?|id_rsa|id_ed25519)(?:[\s/]|$)/i.test(command)) {
    return 'Deep Discovery may not read shell history, credential stores, or private keys.'
  }
  if (/(?:^|[\s/])(?:POTCAR|WAVECAR|CHGCAR|vasprun[.]xml)(?:[\s'";|]|$)/i.test(command)
    || /[.](?:traj|xtc|trr|lammpstrj|ckpt|checkpoint|pt|pth|tar|tgz|zip)(?:[\s'";|]|$)/i.test(command)) {
    return 'Deep Discovery may not read licensed inputs, trajectories, checkpoints, archives, or other large result files.'
  }
  return undefined
}

function schedulerWindowIsBounded(segment: string): boolean {
  if (/(?:^|[^\d])(?:[1-9]\d?|[12]\d\d|3[0-5]\d|36[0-6])\s*days?\s*ago/i.test(segment)) return true
  if (/now-(?:[1-9]\d?|[12]\d\d|3[0-5]\d|36[0-6])days?\b/i.test(segment)) return true
  const match = /(?:--starttime(?:=|\s+)|(?:^|\s)-S\s+)["']?(\d{4}-\d{2}-\d{2})/i.exec(segment)
  if (match?.[1] === undefined) return false
  const start = Date.parse(`${match[1]}T00:00:00Z`)
  const elapsedDays = (Date.now() - start) / 86_400_000
  return Number.isFinite(start) && elapsedDays >= -1 && elapsedDays <= 367
}

function schedulerSegment(command: string, name: 'sacct' | 'squeue'): string {
  const index = command.toLowerCase().indexOf(name)
  return index < 0 ? '' : unquotedSegmentFrom(command, index)
}

function validateCommand(command: string, phase: DiscoveryMetadata['phase']): {
  readonly reason?: string
  readonly observesRoot: boolean
  readonly usesSchedulerHistory: boolean
  readonly usesQueue: boolean
} {
  const lower = command.toLowerCase()
  const invocations = lower.replace(/\bcommand\s+-v\s+[^;\n]+/g, '')
  const unquoted = unquotedShellText(command)
  const usesSchedulerHistory = /\bsacct\b/.test(invocations)
  const usesQueue = /\bsqueue\b/.test(invocations)
  const base = { observesRoot: false, usesSchedulerHistory, usesQueue }
  const safetyReason = mutationOrSensitiveReason(command)
  if (safetyReason !== undefined) return { ...base, reason: safetyReason }
  if (/(?:^|[\s/'"])[.][.](?:[/\s'";]|$)/.test(command)) {
    return { ...base, reason: 'Deep Discovery commands may not inspect parent paths.' }
  }
  if (/(?:^|[;\n]|&&|\|\|)\s*(?:sbatch|qsub|scancel|qdel)\b/.test(invocations)) {
    return { ...base, reason: 'Deep Discovery is read-only; job submission and cancellation commands are forbidden.' }
  }
  if (/\b(?:ls\s+[^\n;]*-[^\n;\s]*r|tree|du|grep\s+[^\n;]*-[^\n;\s]*r|rg\s+[^\n;]*--?glob)\b/i.test(unquoted)
    || /\bfind\b[^\n;]*(?:-size|-mtime|-mmin|-newer)/i.test(unquoted)
    || /\bls\s+[^\n;]*-[^\n;\s]*[st][^\n;\s]*/i.test(unquoted)) {
    return { ...base, reason: 'recursive, size, or mtime scans are forbidden during Deep Discovery.' }
  }
  if (/\/(?:[^\s'";|]+\/)*\*(?:\/|\s|'|"|;|\||$)/.test(command)) {
    return { ...base, reason: 'Unknown-cardinality absolute globs are forbidden during Deep Discovery.' }
  }
  const find = findShape(command, phase)
  if (find.reason !== undefined) return { ...base, reason: find.reason }
  if (phase === 'project-read') {
    const terminalLimit = terminalHeadLimit(command)
    if (terminalLimit === undefined || terminalLimit < 1 || terminalLimit > MAX_ENUMERATION_ROWS) {
      return {
        ...base,
        reason: `Project evidence must end with one output-wide head -n ${String(MAX_ENUMERATION_ROWS)} or less.`,
      }
    }
  }
  if (/\bsort\b/i.test(command) && !/\bfind\b/i.test(command) && !usesSchedulerHistory) {
    return { ...base, reason: 'Global filesystem sorting is forbidden during Deep Discovery.' }
  }
  if (usesSchedulerHistory) {
    const segment = schedulerSegment(command, 'sacct')
    const limit = headLimit(segment)
    const currentUser = /(?:^|\s)(?:-u|--user)(?:\s|=)["']?\$USER\b/i.test(segment)
    const allUsers = /(?:^|\s)(?:-a|--allusers)(?:\s|$)/i.test(segment)
    if (!currentUser || allUsers || !schedulerWindowIsBounded(segment)
      || limit === undefined || limit.count > MAX_ENUMERATION_ROWS) {
      return { ...base, reason: 'sacct discovery must query only $USER over at most 366 days and return at most 64 bounded rows.' }
    }
  }
  if (usesQueue) {
    const segment = schedulerSegment(command, 'squeue')
    const limit = headLimit(segment)
    if (!/(?:^|\s)(?:-u|--user)(?:\s|=)["']?\$USER\b/i.test(segment)) {
      return { ...base, reason: 'squeue must be explicitly scoped to -u "$USER".' }
    }
    if (/%(?:i|A|F|K)\b/.test(segment) || /\bJobID\b/i.test(segment)) {
      return { ...base, reason: 'squeue discovery projections must omit job ids.' }
    }
    if (limit === undefined || limit.count > MAX_ENUMERATION_ROWS) {
      return { ...base, reason: 'squeue discovery must return at most 64 bounded rows.' }
    }
  }
  return { ...base, observesRoot: find.observesRoot }
}

function normalizedCommandHash(machineId: string, workdir: string, command: string): string {
  const normalized = command.trim().replace(/\s+/g, ' ')
  return createHash('sha256').update(machineId).update('\0').update(workdir).update('\0').update(normalized).digest('hex')
}

/** Current-turn policy for bounded, read-only Machine discovery. */
export class MachineDiscoveryGuard {
  private readonly states = new WeakMap<Agent, TurnState>()

  register(ctx: Context): () => void {
    const disposeGuard = ctx.tools.guard(execution => this.guard(execution))
    const disposeResult = ctx.on('tools/result', (execution, result) => {
      this.observeResult(execution, result)
    })
    return () => {
      disposeResult()
      disposeGuard()
    }
  }

  inspectShellRequest(execution: Readonly<ToolExecution>): DiscoveryShellRequestDecision {
    const state = this.stateFor(execution.agent)
    if (state === undefined) return { kind: 'execute' }
    const callId = String(execution.callId)
    const selectionBudget = state.projectSelectionCompleteCalls.get(callId)
    if (selectionBudget !== undefined) {
      return { kind: 'project-selection-complete', budget: selectionBudget }
    }
    const duplicateBudget = state.duplicateSuppressedCalls.get(callId)
    if (duplicateBudget !== undefined) return { kind: 'duplicate-suppressed', budget: duplicateBudget }
    const outsidePlanBudget = state.projectOutsidePlanCalls.get(callId)
    if (outsidePlanBudget !== undefined) return { kind: 'project-not-in-plan', budget: outsidePlanBudget }
    const unobserved = state.unobservedEvidenceCalls.get(callId)
    if (unobserved !== undefined) return { kind: 'evidence-not-observed', ...unobserved }
    const recoveryBudget = state.focusedRecoveryRequiredCalls.get(callId)
    return recoveryBudget === undefined
      ? { kind: 'execute' }
      : { kind: 'focused-recovery-required', budget: recoveryBudget }
  }

  inspectShellOutput(
    execution: Readonly<ToolExecution>,
    stdout: string,
    stderr: string,
  ): DiscoveryShellOutputDecision {
    const state = this.stateFor(execution.agent)
    if (state === undefined) return { kind: 'accept' }
    const reservation = state.reservations.get(String(execution.callId))
    if (reservation === undefined || reservation.outputAccounted) return { kind: 'accept' }
    const diagnostic = fatalRemoteDiagnostic(stderr)
    if (diagnostic !== undefined) {
      reservation.outputAccounted = true
      if (state.remoteDiagnosticFailures++ === 0) state.recoverableShellCalls.add(String(execution.callId))
      else state.terminalFailure = 'remote-diagnostic'
      if (state.terminalFailure !== undefined && reservation.discovery.phase === 'project-read') {
        state.failedProjectPaths.add(projectKey(reservation.machineId, reservation.discovery.projectPath))
      }
      return { kind: 'reject-diagnostic', diagnostic }
    }
    const observedBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8')
    const remainingTurnBytes = Math.max(0, TURN_OUTPUT_BYTES - state.outputBytes)
    reservation.outputAccounted = true
    if (observedBytes > PER_CALL_OUTPUT_BYTES || observedBytes > remainingTurnBytes) {
      if (reservation.discovery.phase === 'project-read') {
        state.failedProjectPaths.add(projectKey(reservation.machineId, reservation.discovery.projectPath))
      }
      return { kind: 'reject-bounds', observedBytes, perCallLimitBytes: PER_CALL_OUTPUT_BYTES, remainingTurnBytes }
    }
    state.outputBytes += observedBytes
    return {
      kind: 'accept',
      budget: discoveryBudget(state),
    }
  }

  private stateFor(agent: Agent | undefined): TurnState | undefined {
    if (agent === undefined) return undefined
    const turn = openTurn(agent)
    if (turn === undefined) {
      this.states.delete(agent)
      return undefined
    }
    let state = this.states.get(agent)
    if (state === undefined || state.turn !== turn) {
      state = newTurnState(agent, turn)
      this.states.set(agent, state)
    } else if (!state.active && hasDirectSkillInvocation(agent)) {
      state.active = true
    }
    return state
  }

  private guard(execution: Readonly<ToolExecution>): string | undefined {
    const state = this.stateFor(execution.agent)
    if (state === undefined || !state.active) return undefined
    if (state.terminalFailure !== undefined) {
      if (state.terminalFailure === 'knowledge-write') {
        return 'Deep Discovery stopped after a Knowledge write failure. Do not retry, write another document, or call more tools in this turn; report the successful receipts and failed document, then wait for a new user turn.'
      }
      if (state.terminalFailure === 'local-program') {
        return 'Deep Discovery stopped after the single allowed local Code Mode correction also failed. Do not debug or retry; report that preservation was not completed and wait for a new user turn.'
      }
      return 'Deep Discovery stopped after a remote shell or parser diagnostic. Do not retry or call more tools in this turn; report the partial result and wait for a new user turn.'
    }
    if (execution.name === KNOWLEDGE_WRITE_TOOL) {
      const callId = String(execution.callId)
      if (state.knowledgeWriteInFlightCallId !== undefined && state.knowledgeWriteInFlightCallId !== callId) {
        return 'Deep Discovery Knowledge writes must be awaited sequentially; do not use Promise.all or overlap writes.'
      }
      let reason: string | undefined
      try { reason = knowledgeWriteReason(state, execution.arguments) }
      catch { return 'Invalid structured Knowledge table; correct its bounded columns and rows before writing.' }
      if (reason !== undefined) return reason
      state.knowledgeWriteInFlightCallId = callId
      state.knowledgeWriteOuterCallIds.add(outerCallId(callId))
      return undefined
    }
    if (execution.name !== SHELL_TOOL) return undefined
    // A well-formed empty selection is a safe model no-op. Let the Tool return
    // a structured domain result without reserving or executing remote work.
    if (isEmptyProjectEvidenceSelection(execution.arguments)) return undefined
    const callId = String(execution.callId)
    const input = parseShellArguments(execution.arguments)
    if (input === undefined) {
      return 'Deep Discovery shell calls require only the documented fields, a structured discovery phase, an absolute workdir, and an explicit timeoutMs no greater than 20000. Correct the local call once; no remote attempt was recorded.'
    }
    if (input.discovery.phase === 'project-read' && input.discovery.selectionPlan === undefined) {
      return 'Every Deep Discovery project-read requires the complete ordered discovery.selectionPlan. Correct the local call once before any remote project read.'
    }
    if (input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) {
      return 'Deep Discovery timeoutMs must be between 1 and 20000.'
    }
    if (!state.seenAttemptCallIds.has(callId)) {
      state.seenAttemptCallIds.add(callId)
      state.attempts += 1
    }
    if (state.attempts > MAX_ATTEMPTS) return `Deep Discovery exhausted its ${String(MAX_ATTEMPTS)} shell-attempt budget.`
    if (state.inFlightCallId !== undefined && state.inFlightCallId !== callId) {
      return 'Run one Deep Discovery shell call at a time and inspect its result before the next call.'
    }
    const roots = state.declaredRootsByMachine.get(input.machineId)
    if (roots === undefined) return 'Call slop_machine_get for this Machine in the current turn before Deep Discovery shell calls.'
    if (state.connectionStatesByMachine.get(input.machineId) !== 'ready') {
      return 'Deep Discovery requires a ready Machine connection. Connect first when authentication is allowed, or stop before remote reads when the task requires an existing non-interactive connection.'
    }
    if (input.discovery.phase === 'resolve-root') {
      if ([...state.reservations.values()].some(value => value.discovery.phase === 'resolve-root')) return 'Wait for the current root resolution.'
      const key = normalizedCommandHash(input.machineId, '/', input.command)
      if (state.commandHashes.has(key)) return 'Reuse the root resolution already returned in this turn.'
      state.commandHashes.add(key)
      state.inFlightCallId = callId
      state.reservations.set(callId, { callId, machineId: input.machineId, discovery: input.discovery, observesRoot: false, runsFocusedRecovery: false, outputAccounted: false })
      return undefined
    }
    if (roots.length === 0) return 'This Machine has no resolved roots. Use resolve-root for an exact path already supplied by the user, including ~/path. Ask only if the user has supplied no root.'

    let projectPath: string | undefined
    let projectStateKey: string | undefined
    if (input.discovery.phase === 'census') {
      const censusRoot = input.discovery.root
      if (!roots.some(root => root.path === censusRoot) || input.workdir !== censusRoot) {
        return 'A census root and workdir must be the same exact Machine-declared root.'
      }
    } else {
      const selectedProjectPath = input.discovery.projectPath
      projectPath = selectedProjectPath
      if (!isProjectScopedWorkdir(input, selectedProjectPath)) {
        return 'Project-read workdir must exactly match discovery.projectPath. A host-built evidenceFiles read may instead use its parent census root only when every file starts with that project directory.'
      }
      const declaredProject = roots.some(root => root.role === 'project' && root.path === selectedProjectPath)
      if (!declaredProject && state.observedRoots.size === 0) return 'Complete one bounded depth-one census before project-read calls.'
      const directChild = roots.some(root => state.observedRoots.has(censusKey(input.machineId, root.path))
        && posix.dirname(selectedProjectPath) === root.path)
      if (!declaredProject && !directChild) {
        return 'projectPath must be a direct child of a completed census root or an exact declared project root.'
      }
      projectStateKey = projectKey(input.machineId, selectedProjectPath)
      const suppliedPlan = input.discovery.selectionPlan
      const frozenPlan = state.projectSelectionPlansByMachine.get(input.machineId)
      if (suppliedPlan !== undefined) {
        const planIsInScope = suppliedPlan.every(plannedPath => {
          const declared = roots.some(root => root.role === 'project' && root.path === plannedPath)
          const observedChild = roots.some(root => state.observedRoots.has(censusKey(input.machineId, root.path))
            && posix.dirname(plannedPath) === root.path)
          return declared || observedChild
        })
        if (!planIsInScope) return 'Every discovery selectionPlan path must be an exact declared project or direct child of a completed census root.'
        if (frozenPlan === undefined) {
          const alreadySelected = [...state.projectPaths]
            .filter(key => key.startsWith(`${input.machineId}\0`))
            .map(key => key.slice(key.indexOf('\0') + 1))
          if (alreadySelected.some(path => !suppliedPlan.includes(path))) {
            return 'A late discovery selectionPlan must contain every project path already selected in this turn.'
          }
          state.projectSelectionPlansByMachine.set(input.machineId, suppliedPlan)
        } else if (frozenPlan.length !== suppliedPlan.length
          || frozenPlan.some((path, index) => suppliedPlan[index] !== path)) {
          return 'The discovery selectionPlan is frozen after its first use and must not change during the turn.'
        }
      }
      const activePlan = state.projectSelectionPlansByMachine.get(input.machineId)
      if (activePlan !== undefined && !activePlan.includes(selectedProjectPath)) {
        state.attempts = Math.max(0, state.attempts - 1)
        state.projectOutsidePlanCalls.set(callId, discoveryBudget(state))
        return undefined
      }
      if (!state.projectPaths.has(projectStateKey)
        && state.projectPaths.size >= MAX_SELECTED_PROJECT_PATHS) {
        // This is an admitted, local control result rather than a guard denial:
        // no remote command runs, no shell budget is consumed, and the model can
        // continue with already-selected paths instead of entering an error loop.
        state.attempts = Math.max(0, state.attempts - 1)
        state.projectSelectionCompleteCalls.set(callId, discoveryBudget(state))
        return undefined
      }
      if (state.failedProjectPaths.has(projectStateKey)) {
        return 'A previous Deep Discovery read for this project failed. Preserve accepted evidence and report the unresolved field as unknown; do not retry this project.'
      }
      const observed = state.observedProjectPaths.get(projectStateKey) ?? new Set<string>()
      const unobservedPaths = input.evidenceFiles?.flatMap((file) => {
        const relative = projectRelativeEvidencePath(input, selectedProjectPath, file)
        const outsideRoots = posix.isAbsolute(file) && !roots.some(root => isWithin(file, root.path))
        return relative === undefined || !observed.has(relative) || outsideRoots ? [file] : []
      }) ?? []
      const focusedPath = input.discovery.focus ?? focusedEnumerationPath(input.command)
      if (focusedPath !== undefined && !observed.has(focusedPath)) unobservedPaths.push(focusedPath)
      if (unobservedPaths.length > 0) {
        state.attempts = Math.max(0, state.attempts - 1)
        state.unobservedEvidenceCalls.set(callId, {
          budget: discoveryBudget(state),
          unobservedPaths: [...new Set(unobservedPaths)].slice(0, 6),
          observedPaths: [...observed].sort().slice(0, 32),
        })
        return undefined
      }
      const observedWorkstreams = state.observedProjectWorkstreams.get(projectStateKey)
      const observedFiles = state.observedProjectFiles.get(projectStateKey)
      if (isWholeProjectFocusedEnumeration(input.command)
        && (observedWorkstreams?.size ?? 0) > 0
        && (observedFiles?.size ?? 0) === 0
        && !state.focusedRecoveryProjectPaths.has(projectStateKey)) {
        state.attempts = Math.max(0, state.attempts - 1)
        state.focusedRecoveryRequiredCalls.set(callId, discoveryBudget(state))
        return undefined
      }
      const outsidePath = literalAbsolutePaths(input.command)
        .filter(path => path !== '/dev/null')
        .find(path => !isWithin(posix.normalize(path), selectedProjectPath)
          && !(input.evidenceFiles?.includes(path) && observed.has(path) && roots.some(root => isWithin(path, root.path))))
      if (outsidePath !== undefined) {
        state.failedProjectPaths.add(projectStateKey)
        return 'A project-read command may not reference a path outside the active phase scope.'
      }
    }

    const commandInvocations = input.command.toLowerCase().replace(/\bcommand\s+-v\s+[^;\n]+/g, '')
    if (/\bsacct\b/.test(commandInvocations) && state.schedulerHistoryCalls >= 1) {
      return 'Deep Discovery permits only one remotely aggregated sacct call per turn.'
    }
    if (/\bsqueue\b/.test(commandInvocations) && state.queueCalls >= 1) {
      return 'Deep Discovery permits one bounded squeue projection per turn.'
    }
    const commandPolicy = validateCommand(input.command, input.discovery.phase)
    if (commandPolicy.reason !== undefined) {
      if (projectStateKey !== undefined) {
        state.failedProjectPaths.add(projectStateKey)
      }
      return commandPolicy.reason
    }
    const commandHash = normalizedCommandHash(input.machineId, input.workdir, input.command)
    if (state.commandHashes.has(commandHash)) {
      if (projectStateKey !== undefined) {
        // Repeating an already accepted project read is a planner no-op, not a
        // remote failure. Suppress it locally so one harmless duplicate cannot
        // terminate an otherwise valid discovery turn.
        state.attempts = Math.max(0, state.attempts - 1)
        state.duplicateSuppressedCalls.set(callId, discoveryBudget(state))
        return undefined
      }
      return 'Do not repeat an identical Deep Discovery command; narrow the next question instead.'
    }

    if (projectPath !== undefined) {
      const key = projectKey(input.machineId, projectPath)
      const calls = state.projectCalls.get(key) ?? 0
      if (calls >= MAX_PROJECT_CALLS) return `Deep Discovery permits at most ${String(MAX_PROJECT_CALLS)} shell calls per project.`
      state.projectPaths.add(key)
      state.projectCalls.set(key, calls + 1)
    }
    if (commandPolicy.usesSchedulerHistory) state.schedulerHistoryCalls += 1
    if (commandPolicy.usesQueue) state.queueCalls += 1
    state.commandHashes.add(commandHash)
    state.inFlightCallId = callId
    state.reservations.set(callId, {
      callId,
      machineId: input.machineId,
      discovery: input.discovery,
      observesRoot: commandPolicy.observesRoot,
      runsFocusedRecovery: (input.discovery.phase === 'project-read' && input.discovery.focus !== undefined) || focusedEnumerationPath(input.command) !== undefined,
      outputAccounted: false,
    })
    return undefined
  }

  private observeResult(execution: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const state = this.stateFor(execution.agent)
    if (state === undefined) return
    // The Skill Tool's canonical value is provider-defined. In Code Mode it
    // may be rendered instruction text rather than an object with a `name`
    // field. The validated call argument identifies the selected Skill; a
    // successful result is sufficient to activate the guard.
    if (execution.name === 'skill' && !result.isError
      && DISCOVERY_SKILLS.has(String(objectField(execution.arguments, 'name')))) {
      state.active = true
      return
    }
    if (state.active && execution.name === 'run_code' && result.isError) {
      // Local Code Mode failures are recoverable. Permanently rejecting every
      // later program makes models spin on an unchanged guard error. An outer
      // failure that owned a Knowledge write remains terminal because its
      // nested write may have committed before output validation failed.
      if (state.knowledgeWriteOuterCallIds.has(String(execution.callId))) {
        state.terminalFailure = 'knowledge-write'
      } else {
        state.localProgramFailures += 1
        if (state.localProgramFailures > 1) state.terminalFailure = 'local-program'
      }
      return
    }
    if (execution.name === MACHINE_GET_TOOL && !result.isError) {
      const projection = extractMachineContext(result.value)
      if (projection !== undefined) {
        state.declaredRootsByMachine.set(projection.machineId, projection.roots)
        state.connectionStatesByMachine.set(projection.machineId, projection.connectionState)
        state.sensitiveKnowledgeMarkersByMachine.set(projection.machineId, projection.sensitiveKnowledgeMarkers)
      }
      return
    }
    if (execution.name === MACHINE_CONNECT_TOOL && !result.isError
      && objectField(result.value, 'ok') === true) {
      const value = objectField(result.value, 'value')
      const machineId = nonEmptyString(objectField(value, 'machineId'))
      if (machineId !== undefined && objectField(value, 'kind') === 'ready') {
        state.connectionStatesByMachine.set(machineId, 'ready')
      }
      return
    }
    if (execution.name === KNOWLEDGE_WRITE_TOOL) {
      if (state.knowledgeWriteInFlightCallId === String(execution.callId)) delete state.knowledgeWriteInFlightCallId
      if (result.isError) {
        const recoverable = ['KNOWLEDGE_CONFLICT', 'KNOWLEDGE_INVALID_ARGUMENT', 'KNOWLEDGE_INVALID_MARKDOWN', 'KNOWLEDGE_NOT_FOUND', 'KNOWLEDGE_BOUNDS'].includes(result.error.info?.code ?? '')
        if (recoverable && state.recoverableWriteFailures++ === 0) {
          const outerId = outerCallId(String(execution.callId))
          if (!state.successfulWriteOuterCallIds.has(outerId)) state.knowledgeWriteOuterCallIds.delete(outerId)
        } else state.terminalFailure = 'knowledge-write'
      } else state.successfulWriteOuterCallIds.add(outerCallId(String(execution.callId)))
      return
    }
    if (execution.name !== SHELL_TOOL) return
    const callId = String(execution.callId)
    if (state.inFlightCallId === callId) delete state.inFlightCallId
    const reservation = state.reservations.get(callId)
    state.reservations.delete(callId)
    if (reservation?.discovery.phase === 'project-read' && isSuccessfulShellResult(result)) {
      const shell = objectField(result.value, 'value')
      const stdout = objectField(shell, 'stdout')
      if (typeof stdout === 'string') {
        const key = projectKey(reservation.machineId, reservation.discovery.projectPath)
        const paths = state.observedProjectPaths.get(key) ?? new Set<string>()
        const workstreams = state.observedProjectWorkstreams.get(key) ?? new Set<string>()
        const files = state.observedProjectFiles.get(key) ?? new Set<string>()
        const evidenceLines = state.observedProjectEvidenceLines.get(key) ?? new Map<string, Set<string>>()
        const observed = observedProjectOutput(stdout)
        for (const path of observed.paths) paths.add(path)
        for (const path of observed.workstreams) workstreams.add(path)
        for (const path of observed.files) files.add(path)
        for (const [path, lines] of observed.evidenceLines) {
          const fileLines = evidenceLines.get(path) ?? new Set<string>()
          for (const line of lines) fileLines.add(line)
          evidenceLines.set(path, fileLines)
        }
        state.observedProjectPaths.set(key, paths)
        state.observedProjectWorkstreams.set(key, workstreams)
        state.observedProjectFiles.set(key, files)
        state.observedProjectEvidenceLines.set(key, evidenceLines)
        if (reservation.runsFocusedRecovery) state.focusedRecoveryProjectPaths.add(key)
      }
    }
    if (reservation?.discovery.phase === 'resolve-root' && isSuccessfulShellResult(result)) {
      const path = resolvedDiscoveryRoot(objectField(objectField(result.value, 'value'), 'stdout'))
      if (path !== undefined) {
        const roots = state.declaredRootsByMachine.get(reservation.machineId) ?? []
        state.declaredRootsByMachine.set(reservation.machineId, [...roots.filter(root => root.path !== path), { path, role: 'work' }])
        const markers = state.sensitiveKnowledgeMarkersByMachine.get(reservation.machineId) ?? []
        state.sensitiveKnowledgeMarkersByMachine.set(reservation.machineId, [...markers, path, posix.dirname(path)])
      }
    }
    const recoverableShell = state.recoverableShellCalls.delete(callId)
    if (reservation?.discovery.phase === 'project-read' && !isSuccessfulShellResult(result) && !recoverableShell) {
      state.failedProjectPaths.add(projectKey(reservation.machineId, reservation.discovery.projectPath))
    }
    if (reservation?.observesRoot === true && reservation.discovery.phase === 'census'
      && isSuccessfulShellResult(result)) {
      state.observedRoots.add(censusKey(reservation.machineId, reservation.discovery.root))
    }
  }
}

/** Register one process-local guard instance. */
export function registerMachineDiscoveryGuard(ctx: Context): () => void {
  return new MachineDiscoveryGuard().register(ctx)
}
