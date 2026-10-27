import { isAbsolute } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { FileOperationStreamStore, OperationTerminal } from './operation-stream-store.js'

export interface ManagedExecutionSpec {
  operationId: string
  argv: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  terminationGraceMs: number
}

export interface ManagedExecutionResult {
  terminal: OperationTerminal
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface ManagedExecution {
  done: Promise<ManagedExecutionResult>
  cancel(): void
}

function validateSpec(spec: ManagedExecutionSpec): void {
  if (spec.argv.length === 0 || spec.argv.some(value => value.includes('\0'))) throw new Error('managed execution requires NUL-free argv')
  if (!isAbsolute(spec.cwd) || spec.cwd.includes('\0')) throw new Error('managed execution requires an absolute cwd')
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) throw new Error('managed execution requires a positive timeout')
  if (!Number.isSafeInteger(spec.terminationGraceMs) || spec.terminationGraceMs <= 0) throw new Error('managed execution requires a positive termination grace')
}

async function pump(
  source: NodeJS.ReadableStream | undefined,
  operationId: string,
  stream: 'stdout' | 'stderr',
  store: FileOperationStreamStore,
): Promise<void> {
  if (source === undefined) throw new Error(`subprocess did not expose ${stream}`)
  for await (const chunk of source) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
    await store.append(operationId, stream, bytes)
  }
}

function resultTerminal(handle: SubprocessHandle, timedOut: () => boolean, cancelled: () => boolean): Promise<ManagedExecutionResult> {
  return handle.done.then((outcome) => ({
    terminal: timedOut() ? 'timeout' : cancelled() ? 'cancelled' : outcome.exitCode === 0 ? 'success' : 'rejected',
    exitCode: outcome.exitCode,
    signal: outcome.signal,
  }))
}

/** Spawn one argv-only DSH-managed process and persist independent output streams. */
export function runManagedProcess(runtime: SubprocessRuntime, store: FileOperationStreamStore, spec: ManagedExecutionSpec): ManagedExecution {
  validateSpec(spec)
  const controller = new AbortController()
  let timeout = false
  let cancellation = false
  const timer = setTimeout(() => { timeout = true; controller.abort(new Error('operation timed out')) }, spec.timeoutMs)
  const handle = runtime.spawn({
    argv: spec.argv,
    cwd: spec.cwd,
    env: spec.env,
    graceMs: spec.terminationGraceMs,
    signal: controller.signal,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  })
  const stdout = pump(handle.stdout, spec.operationId, 'stdout', store)
  const stderr = pump(handle.stderr, spec.operationId, 'stderr', store)
  const done = (async (): Promise<ManagedExecutionResult> => {
    try {
      const result = await resultTerminal(handle, () => timeout, () => cancellation)
      await Promise.all([stdout, stderr])
      await Promise.all([
        store.close(spec.operationId, 'stdout', result.terminal),
        store.close(spec.operationId, 'stderr', result.terminal),
      ])
      return result
    } finally {
      clearTimeout(timer)
    }
  })()
  return {
    done,
    cancel() {
      if (timeout || cancellation) return
      cancellation = true
      controller.abort(new Error('operation cancelled'))
    },
  }
}
