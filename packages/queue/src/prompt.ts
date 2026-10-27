import type { QueueQueryRequest, QueryBatchItem, QueueTarget } from './types.ts'

function targetDescription(target: QueueTarget): string {
  return target.kind === 'local' ? 'the local host' : `machine ${target.machineId}`
}

function observerInstructions(item: QueryBatchItem): string {
  if (item.observer.kind === 'slurm') return `Slurm job id: ${item.observer.jobId}`
  if (item.observer.kind === 'pbs') return `PBS job id: ${item.observer.jobId}`
  const handle = item.observer.handle
  return [
    `PID: ${String(handle.pid)}`,
    `process start token: ${handle.startToken}`,
    `launched at: ${handle.launchedAt}`,
    `exit-code marker: ${handle.exitCodePath}`,
    `stdout: ${handle.stdoutPath}`,
    `stderr: ${handle.stderrPath}`,
  ].join(', ')
}

/** Creates the complete short-context prompt. The adapter chooses the DSH subagent and tool filter. */
export function buildQueueQueryPrompt(request: Omit<QueueQueryRequest, 'prompt'>): string {
  const items = request.items.map((item) => [
    `- queueItemId: ${item.id}`,
    `  label: ${item.label}`,
    `  prior state: ${item.state}`,
    `  observer: ${observerInstructions(item)}`,
    item.notes === undefined ? undefined : `  notes: ${item.notes}`,
  ].filter((line) => line !== undefined).join('\n')).join('\n')
  const observerAdvice = request.observerKind === 'slurm'
    ? 'Use packed squeue and sacct queries for all listed job IDs.'
    : request.observerKind === 'pbs'
      ? 'Use one packed qstat query for all listed job IDs when the installation supports it.'
      : 'Check all listed PID identities and exit-code markers in one shell command. A reused PID does not count as the original process.'
  return [
    `Observe only these ${request.observerKind} tasks on ${targetDescription(request.target)}.`,
    observerAdvice,
    'Do not submit, cancel, retry, or modify a task.',
    'Return JSON only with this shape: {"observations":[{"queueItemId":"...","state":"queued|running|completed|failed|cancelled|unknown","observedAt":"ISO-8601","evidence":"raw evidence","elapsedSeconds":0,"expectedRemainingSeconds":0,"recommendedCheckAfterSeconds":30,"recommendationReason":"..."}]}.',
    'Return exactly one observation for every task you can identify. Omit a task rather than guessing its state.',
    items,
  ].join('\n')
}
