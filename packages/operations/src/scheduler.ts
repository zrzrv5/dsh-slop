export type SchedulerState = 'queued' | 'running' | 'cancellation-requested' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'held' | 'lost' | 'unknown'

export interface SchedulerObservationRecord {
  nativeId: string
  parentId: string
  childScope?: string
  state: SchedulerState
  rawState: string
  exitCode?: number
  exitSignal?: number
  elapsedSeconds?: number
  nodes?: string
  reason?: string
  source: 'slurm-squeue' | 'slurm-sacct' | 'pbs-qstat'
}

const SLURM_STATES: Readonly<Record<string, SchedulerState>> = {
  PENDING: 'queued', CONFIGURING: 'queued', RESIZING: 'queued', REQUEUED: 'queued', REQUEUE_FED: 'queued',
  RUNNING: 'running', COMPLETING: 'running', STAGE_OUT: 'running', SUSPENDED: 'held', STOPPED: 'held', SPECIAL_EXIT: 'held',
  CANCELLED: 'cancelled', DEADLINE: 'failed', FAILED: 'failed', NODE_FAIL: 'failed', OUT_OF_MEMORY: 'failed', PREEMPTED: 'failed', BOOT_FAIL: 'failed', REVOKED: 'failed',
  COMPLETED: 'completed',
}

export function normalizeSlurmState(raw: string): SchedulerState {
  const state = raw.trim().toUpperCase().replace(/\+$/, '').split(' ')[0] ?? ''
  return SLURM_STATES[state] ?? 'unknown'
}

function parseExitCode(value: string | undefined): { exitCode?: number; exitSignal?: number } {
  if (value === undefined || value === '') return {}
  const match = /^(\d+):(\d+)$/.exec(value.trim())
  if (match === null) return {}
  return { exitCode: Number(match[1]), exitSignal: Number(match[2]) }
}

/** Parse `sacct -P -n --format=JobIDRaw,State,ExitCode,ElapsedRaw,NodeList,Reason`. */
export function parseSlurmAccounting(text: string): SchedulerObservationRecord[] {
  const rows: SchedulerObservationRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [nativeId = '', rawState = '', rawExit, rawElapsed, nodes, reason] = line.split('|')
    if (!/^\d+(?:_[0-9]+)?(?:\.[A-Za-z0-9_-]+)?$/.test(nativeId)) continue
    const parentId = nativeId.split(/[_.]/)[0] ?? nativeId
    const childScope = nativeId === parentId ? undefined : nativeId.slice(parentId.length + 1)
    const elapsedSeconds = rawElapsed !== undefined && /^\d+$/.test(rawElapsed) ? Number(rawElapsed) : undefined
    rows.push({ nativeId, parentId, ...(childScope === undefined ? {} : { childScope }), state: normalizeSlurmState(rawState), rawState, ...parseExitCode(rawExit), ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }), ...(nodes ? { nodes } : {}), ...(reason ? { reason } : {}), source: 'slurm-sacct' })
  }
  return rows
}

const PBS_STATES: Readonly<Record<string, SchedulerState>> = {
  Q: 'queued', W: 'queued', T: 'queued', R: 'running', E: 'running', B: 'running', S: 'held', H: 'held', U: 'held', X: 'cancelled', F: 'completed', M: 'unknown',
}

interface PbsJob {
  job_state?: string
  Exit_status?: number | string
  resources_used?: { walltime?: string; nodect?: number | string }
  exec_host?: string
  comment?: string
}

/** Parse the JSON form of `qstat -f -F json`. */
export function parsePbsJson(text: string): SchedulerObservationRecord[] {
  const value = JSON.parse(text) as { Jobs?: Record<string, PbsJob> }
  return Object.entries(value.Jobs ?? {}).map(([nativeId, job]) => {
    const rawState = job.job_state ?? ''
    const state = PBS_STATES[rawState] ?? 'unknown'
    const exitCode = job.Exit_status === undefined ? undefined : Number(job.Exit_status)
    const wall = job.resources_used?.walltime
    const elapsedSeconds = wall === undefined ? undefined : parseWalltime(wall)
    return { nativeId, parentId: nativeId.replace(/\[[^\]]+\]/, '').split('.')[0] ?? nativeId, state: state === 'completed' && exitCode !== undefined && exitCode !== 0 ? 'failed' : state, rawState, ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}), ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }), ...(job.exec_host ? { nodes: job.exec_host } : {}), ...(job.comment ? { reason: job.comment } : {}), source: 'pbs-qstat' }
  })
}

function parseWalltime(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return undefined
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

export function slurmSubmitArgv(scriptPath: string): readonly string[] {
  return ['sbatch', '--parsable', '--', scriptPath]
}

export function pbsSubmitArgv(scriptPath: string): readonly string[] {
  return ['qsub', '--', scriptPath]
}

export function slurmObserveArgv(handles: readonly string[]): readonly string[] {
  if (handles.length === 0 || handles.some(id => !/^\d+(?:_[0-9]+)?(?:\.[A-Za-z0-9_-]+)?$/.test(id))) throw new Error('invalid Slurm handle')
  return ['sacct', '-P', '-n', '-j', handles.join(','), '--format=JobIDRaw,State,ExitCode,ElapsedRaw,NodeList,Reason']
}

export function pbsObserveArgv(handles: readonly string[]): readonly string[] {
  if (handles.length === 0 || handles.some(id => !/^[0-9]+(?:\[[0-9-]+\])?(?:\.[A-Za-z0-9._-]+)?$/.test(id))) throw new Error('invalid PBS handle')
  return ['qstat', '-f', '-F', 'json', ...handles]
}
