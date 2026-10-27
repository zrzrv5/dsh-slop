import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-subprocess'
import { machineIdSchema } from '@dsh-slop/core'
import type { MachineService } from '@dsh-slop/execution'
import {
  queueProbeBatchSchema,
  type QueueObservation,
  type QueueProbeBatch,
  type QueueProbeIssue,
  type QueueProbePort,
  type QueueProbeRequest,
  type QueueState,
  type QueueTarget,
} from '@dsh-slop/queue'

const COMMAND_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 256 * 1_024
const NEW_JOB_GRACE_MS = 10 * 60_000
const SAFE_JOB_ID = /^[A-Za-z0-9_.+\-[\]]{1,256}$/u

export interface QueueCommandResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

export interface QueueCommandRunner {
  run(target: QueueTarget, command: string): Promise<QueueCommandResult>
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function stateFromScheduler(raw: string): QueueState {
  const state = raw.trim().toUpperCase().split(/[ +]/u)[0] ?? ''
  if (['PENDING', 'CONFIGURING', 'REQUEUED', 'Q', 'H', 'W', 'T'].includes(state)) return 'queued'
  if (['RUNNING', 'COMPLETING', 'SUSPENDED', 'R', 'E', 'B'].includes(state)) return 'running'
  if (['COMPLETED', 'C', 'F'].includes(state)) return 'completed'
  if (['CANCELLED', 'CANCELED', 'X'].includes(state)) return 'cancelled'
  if (['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'BOOT_FAIL', 'DEADLINE', 'PREEMPTED', 'REVOKED'].includes(state)) return 'failed'
  return 'unknown'
}

function slurmSeconds(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '' || /^(?:N\/A|UNLIMITED|INVALID)$/iu.test(trimmed)) return undefined
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(trimmed)
  if (match === null) return undefined
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

function schedulerAttention(reason: string): QueueObservation['attention'] {
  const normalized = reason.trim()
  if (normalized === '' || /^(?:none|resources|priority|dependency)$/iu.test(normalized)) return undefined
  if (!/(?:invalid|hold|denied|assoc|qos|partition|reservation|license|never|constraint|error)/iu.test(normalized)) return undefined
  return { code: 'SCHEDULER_ACTION_REQUIRED', message: normalized.slice(0, 4_096) }
}

function issue(
  queueItemId: QueueProbeIssue['queueItemId'],
  kind: QueueProbeIssue['kind'],
  code: string,
  message: string,
  evidence?: string,
): QueueProbeIssue {
  return {
    queueItemId,
    kind,
    code,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

function commandFailureIssues(request: QueueProbeRequest, result: QueueCommandResult): QueueProbeIssue[] {
  const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.exitCode)}`
  const unsupported = /(?:command not found|not recognized|no such file|unknown option|illegal option)/iu.test(diagnostic)
  return request.items.map((item) => issue(
    item.id,
    unsupported ? 'fallback' : 'retry',
    unsupported ? 'OBSERVER_UNSUPPORTED' : result.timedOut ? 'PROBE_TIMEOUT' : 'PROBE_COMMAND_FAILED',
    unsupported ? 'The deterministic observer is unavailable or incompatible.' : 'The deterministic observer command failed.',
    diagnostic.slice(0, 128_000),
  ))
}

function ambiguousOutputIssues(request: QueueProbeRequest, message: string, evidence?: string): QueueProbeIssue[] {
  return request.items.map((item) => issue(item.id, 'fallback', 'OBSERVER_OUTPUT_AMBIGUOUS', message, evidence))
}

function thrownCommandIssues(request: QueueProbeRequest, error: unknown): QueueProbeIssue[] {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'PROBE_TRANSPORT_FAILED'
  const message = error instanceof Error ? error.message : String(error)
  const actionRequired = code === 'AUTH_REQUIRED' || code === 'MACHINE_NOT_FOUND' || code === 'ACCESS_PROFILE_NOT_FOUND'
  return request.items.map((item) => issue(
    item.id,
    actionRequired ? 'action-required' : 'retry',
    code,
    message,
  ))
}

function slurmCommand(jobIds: readonly string[]): string {
  const ids = jobIds.join(',')
  return [
    'set +e',
    `LC_ALL=C TZ=UTC squeue -h -j ${shellQuote(ids)} -o '%i|%T|%M|%l|%S|%e|%R'`,
    "printf '\n__DSH_SACCT__\n'",
    `LC_ALL=C TZ=UTC sacct -n -P -X -j ${shellQuote(ids)} --format=JobIDRaw,State,Elapsed,Timelimit,Start,End,ExitCode,Reason`,
  ].join('\n')
}

function parseSlurm(request: QueueProbeRequest, result: QueueCommandResult, now: Date): QueueProbeBatch {
  const [queueText = '', accountingText = ''] = result.stdout.split('__DSH_SACCT__', 2)
  const rows = [...queueText.split('\n'), ...accountingText.split('\n')]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split('|'))
  const observations: QueueObservation[] = []
  const issues: QueueProbeIssue[] = []
  for (const item of request.items) {
    if (item.observer.kind !== 'slurm') continue
    const jobId = item.observer.jobId
    const exact = rows.find((fields) => fields[0] === jobId)
    const root = exact ?? rows.find((fields) => fields[0]?.split('.')[0] === jobId)
    if (root === undefined) {
      const young = now.getTime() - Date.parse(item.createdAt) < NEW_JOB_GRACE_MS
      issues.push(issue(
        item.id,
        young ? 'retry' : 'fallback',
        young ? 'JOB_NOT_VISIBLE_YET' : 'JOB_NOT_FOUND',
        young ? 'The scheduler may not have published this new job yet.' : 'The job was absent from both live and accounting output.',
        result.stderr.slice(0, 128_000),
      ))
      continue
    }
    const elapsedSeconds = slurmSeconds(root[2] ?? '')
    const walltimeSeconds = slurmSeconds(root[3] ?? '')
    const state = stateFromScheduler(root[1] ?? '')
    const start = root[4] ?? ''
    const startedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(start) && Number.isFinite(Date.parse(`${start}Z`)) ? new Date(`${start}Z`).toISOString() : undefined
    if (state === 'unknown') {
      issues.push(issue(item.id, 'fallback', 'OBSERVER_OUTPUT_AMBIGUOUS', 'The scheduler returned an unrecognized Slurm state.', root.join('|').slice(0, 128_000)))
      continue
    }
    const attention = state === 'queued'
      ? schedulerAttention((root.length >= 8 ? root[7] : root[6]) ?? '')
      : undefined
    observations.push({
      queueItemId: item.id,
      state,
      observedAt: now.toISOString(),
      evidence: root.join('|').slice(0, 128_000),
      ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
      ...(state === 'queued' || startedAt === undefined ? {} : { startedAt }),
      ...(walltimeSeconds === undefined ? {} : { walltimeSeconds }),
      ...(elapsedSeconds === undefined || walltimeSeconds === undefined
        ? {}
        : { walltimeRemainingSeconds: Math.max(0, walltimeSeconds - elapsedSeconds) }),
      source: 'code',
      ...(attention === undefined ? {} : { attention }),
    })
  }
  return queueProbeBatchSchema.parse({ observations, issues })
}

function pbsCommand(jobIds: readonly string[]): string {
  return `LC_ALL=C qstat -fx -F json ${jobIds.map(shellQuote).join(' ')}`
}

function numberFromPbsDuration(value: unknown): number | undefined {
  return typeof value === 'string' ? slurmSeconds(value) : undefined
}

function parsePbs(request: QueueProbeRequest, result: QueueCommandResult, now: Date): QueueProbeBatch {
  let document: unknown
  try {
    document = JSON.parse(result.stdout)
  } catch {
    const evidence = (result.stderr.trim() || result.stdout.trim()).slice(0, 128_000)
    const issues = result.exitCode === 0
      ? ambiguousOutputIssues(request, 'qstat returned output that was not valid JSON.', evidence)
      : commandFailureIssues(request, result)
    return queueProbeBatchSchema.parse({ observations: [], issues })
  }
  const root = document !== null && typeof document === 'object' ? document as Record<string, unknown> : {}
  const jobs = root.Jobs !== null && typeof root.Jobs === 'object' ? root.Jobs as Record<string, unknown> : {}
  const observations: QueueObservation[] = []
  const issues: QueueProbeIssue[] = []
  for (const item of request.items) {
    if (item.observer.kind !== 'pbs') continue
    const jobId = item.observer.jobId
    const entry = Object.entries(jobs).find(([id]) => id === jobId || id.split('.')[0] === jobId)?.[1]
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      const young = now.getTime() - Date.parse(item.createdAt) < NEW_JOB_GRACE_MS
      issues.push(issue(item.id, young ? 'retry' : 'fallback', young ? 'JOB_NOT_VISIBLE_YET' : 'JOB_NOT_FOUND', young
        ? 'The scheduler may not have published this new job yet.'
        : 'The job was absent from qstat JSON output.'))
      continue
    }
    const data = entry as Record<string, unknown>
    const used = z.object({ walltime: z.string().optional() }).passthrough().safeParse(data.resources_used)
    const resources = z.object({ walltime: z.string().optional() }).passthrough().safeParse(data.Resource_List)
    const elapsedSeconds = numberFromPbsDuration(data['resources_used.walltime'] ?? (used.success ? used.data.walltime : undefined))
    const walltimeSeconds = numberFromPbsDuration(data['Resource_List.walltime'] ?? (resources.success ? resources.data.walltime : undefined))
    const schedulerState = String(data.job_state ?? '')
    const exitStatus = typeof data.Exit_status === 'number' ? data.Exit_status : Number(data.Exit_status)
    const state = schedulerState.trim().toUpperCase() === 'F' && Number.isFinite(exitStatus) && exitStatus !== 0
      ? 'failed'
      : stateFromScheduler(schedulerState)
    if (state === 'unknown') {
      issues.push(issue(item.id, 'fallback', 'OBSERVER_OUTPUT_AMBIGUOUS', 'The scheduler returned an unrecognized PBS state.', JSON.stringify(entry).slice(0, 128_000)))
      continue
    }
    observations.push({
      queueItemId: item.id,
      state,
      observedAt: now.toISOString(),
      evidence: JSON.stringify(entry).slice(0, 128_000),
      ...(state !== 'queued' && typeof data.stime === 'number' && Number.isFinite(data.stime) && data.stime > 0 ? { startedAt: new Date(data.stime * 1_000).toISOString() } : {}),
      ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
      ...(walltimeSeconds === undefined ? {} : { walltimeSeconds }),
      ...(elapsedSeconds === undefined || walltimeSeconds === undefined
        ? {}
        : { walltimeRemainingSeconds: Math.max(0, walltimeSeconds - elapsedSeconds) }),
      source: 'code',
      ...(state !== 'queued' ? {} : {
        attention: schedulerAttention(String(data.comment ?? data.Hold_Types ?? '')),
      }),
    })
  }
  return queueProbeBatchSchema.parse({ observations, issues })
}

function processCommand(request: QueueProbeRequest): string {
  const lines = ['set +e']
  request.items.forEach((item, index) => {
    if (item.observer.kind !== 'process') return
    const handle = item.observer.handle
    lines.push(
      `if [ -f ${shellQuote(handle.exitCodePath)} ]; then printf '${String(index)}|exit|'; head -c 64 ${shellQuote(handle.exitCodePath)}; printf '\n'; `
      + `elif kill -0 ${String(handle.pid)} 2>/dev/null; then printf '${String(index)}|running|'; LC_ALL=C ps -p ${String(handle.pid)} -o lstart=; `
      + `else printf '${String(index)}|missing|\n'; fi`,
    )
  })
  return lines.join('\n')
}

function parseProcess(request: QueueProbeRequest, result: QueueCommandResult, now: Date): QueueProbeBatch {
  const rows = new Map<number, readonly string[]>()
  for (const line of result.stdout.split('\n')) {
    const fields = line.trim().split('|')
    const index = Number(fields[0])
    if (Number.isInteger(index) && fields.length >= 2) rows.set(index, fields)
  }
  const observations: QueueObservation[] = []
  const issues: QueueProbeIssue[] = []
  request.items.forEach((item, index) => {
    if (item.observer.kind !== 'process') return
    const fields = rows.get(index)
    if (fields === undefined) {
      issues.push(issue(item.id, 'retry', 'PROCESS_PROBE_INCOMPLETE', 'The process probe returned no row for this task.', result.stderr))
      return
    }
    const status = fields[1]
    const detail = fields.slice(2).join('|').trim()
    if (status === 'running' && detail !== item.observer.handle.startToken) {
      issues.push(issue(item.id, 'fallback', 'PROCESS_IDENTITY_CHANGED', 'The PID belongs to a different process and the original result is unresolved.', detail))
      return
    }
    if (status === 'running') {
      observations.push({ queueItemId: item.id, state: 'running', observedAt: now.toISOString(), startedAt: item.observer.handle.launchedAt, evidence: `PID ${String(item.observer.handle.pid)} start token matched.`, source: 'code' })
      return
    }
    if (status === 'exit') {
      const exitCode = Number.parseInt(detail, 10)
      if (!Number.isInteger(exitCode)) {
        issues.push(issue(item.id, 'fallback', 'EXIT_MARKER_INVALID', 'The process exit marker did not contain a valid exit code.', detail))
        return
      }
      observations.push({ queueItemId: item.id, state: exitCode === 0 ? 'completed' : 'failed', observedAt: now.toISOString(), evidence: `Exit marker: ${detail || 'invalid'}`, source: 'code' })
      return
    }
    issues.push(issue(item.id, 'fallback', 'PROCESS_RESULT_AMBIGUOUS', 'The original process is no longer running and no exit marker exists.'))
  })
  return queueProbeBatchSchema.parse({ observations, issues })
}

/** Deterministic scheduler/process observer. A model is requested only for explicitly ambiguous items. */
export class DshQueueProbe implements QueueProbePort {
  constructor(private readonly runner: QueueCommandRunner, private readonly now: () => Date = () => new Date()) {}

  async probe(request: QueueProbeRequest): Promise<unknown> {
    const invalid = request.items.filter((item) => item.observer.kind !== 'process' && !SAFE_JOB_ID.test(item.observer.jobId))
    if (invalid.length > 0) {
      const invalidIds = new Set(invalid.map((item) => item.id))
      return queueProbeBatchSchema.parse({
        observations: [],
        issues: request.items.map((item) => issue(item.id, invalidIds.has(item.id) ? 'action-required' : 'retry', invalidIds.has(item.id) ? 'INVALID_JOB_ID' : 'BATCH_BLOCKED', invalidIds.has(item.id)
          ? 'The scheduler job id contains unsupported characters.'
          : 'Another job id made this deterministic batch unsafe.')),
      })
    }
    const command = request.observerKind === 'slurm'
      ? slurmCommand(request.items.flatMap((item) => item.observer.kind === 'slurm' ? [item.observer.jobId] : []))
      : request.observerKind === 'pbs'
        ? pbsCommand(request.items.flatMap((item) => item.observer.kind === 'pbs' ? [item.observer.jobId] : []))
        : processCommand(request)
    let result: QueueCommandResult
    try {
      result = await this.runner.run(request.target, command)
    } catch (error) {
      return queueProbeBatchSchema.parse({ observations: [], issues: thrownCommandIssues(request, error) })
    }
    if (result.timedOut || (result.exitCode !== 0 && result.stdout.trim() === '')) {
      return queueProbeBatchSchema.parse({ observations: [], issues: commandFailureIssues(request, result) })
    }
    const now = this.now()
    if (request.observerKind === 'slurm') return parseSlurm(request, result, now)
    if (request.observerKind === 'pbs') return parsePbs(request, result, now)
    return parseProcess(request, result, now)
  }
}

/** Host command adapter shared by local managed subprocesses and protected Machine execution. */
export class DshQueueCommandRunner implements QueueCommandRunner {
  constructor(
    private readonly ctx: Context,
    private readonly machineService: Pick<MachineService, 'execute'> | (() => Pick<MachineService, 'execute'> | undefined),
    private readonly localCwd: string,
  ) {}

  async run(target: QueueTarget, command: string): Promise<QueueCommandResult> {
    if (target.kind === 'machine') {
      const machine = typeof this.machineService === 'function' ? this.machineService() : this.machineService
      if (machine === undefined) throw Object.assign(new Error('Machine component is disabled; remote observation is paused.'), { code: 'MACHINE_UNAVAILABLE' })
      const result = await machine.execute({
        machineId: machineIdSchema.parse(target.machineId),
        command,
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      return { exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr }
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Queue probe timed out')), COMMAND_TIMEOUT_MS)
    try {
      const bash = await this.ctx.subprocess.resolveExecutable('bash', { LC_ALL: 'C' }, controller.signal)
      const handle = this.ctx.subprocess.spawn({
        argv: [bash, '-lc', command],
        cwd: this.localCwd,
        env: { LC_ALL: 'C' },
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: MAX_OUTPUT_BYTES },
          stderr: { maxBytes: MAX_OUTPUT_BYTES },
        },
        graceMs: 1_000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        timedOut: controller.signal.aborted,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}
