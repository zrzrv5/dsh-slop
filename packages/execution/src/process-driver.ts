import { isAbsolute } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CapturedProcess, ProcessDriver } from './types.ts'

const EMPTY = new Uint8Array()

async function boundedRead(
  stream: NodeJS.ReadableStream | undefined,
  maximum: number,
  consumerClosed: () => boolean,
): Promise<Uint8Array> {
  if (stream === undefined) throw new Error('subprocess did not expose a piped output stream')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const raw of stream) {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw as Uint8Array)
      size += chunk.byteLength
      if (size > maximum) throw new Error(`subprocess output exceeded ${maximum} bytes`)
      chunks.push(chunk)
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (!consumerClosed() || code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  }
  return Buffer.concat(chunks, size)
}

/** Capture-only adapter over DSH's one managed local subprocess authority. */
export class DshProcessDriver implements ProcessDriver {
  private readonly active = new Map<AbortController, Promise<CapturedProcess>>()
  private closed = false
  constructor(private readonly runtime: SubprocessRuntime, private readonly prepareCommand?: (argv: readonly string[]) => Promise<readonly string[]>) {}

  async stopActive(): Promise<void> {
    for (const controller of this.active.keys()) controller.abort(new Error('Machine component stopped'))
    await Promise.allSettled(this.active.values())
  }
  async close(): Promise<void> { this.closed = true; await this.stopActive() }

  async capture(request: Parameters<ProcessDriver['capture']>[0]): Promise<CapturedProcess> {
    if (this.closed) throw new Error('Machine process driver is closed')
    const lifetime = new AbortController()
    const signal = request.signal === undefined ? lifetime.signal : AbortSignal.any([request.signal, lifetime.signal])
    const task = this.captureOwned({ ...request, signal })
    this.active.set(lifetime, task)
    try { return await task } finally { this.active.delete(lifetime) }
  }

  private async captureOwned(request: Parameters<ProcessDriver['capture']>[0]): Promise<CapturedProcess> {
    request.signal?.throwIfAborted()
    if (request.argv.length === 0 || request.argv.some(value => value.length === 0 || value.includes('\0'))) throw new Error('argv must be nonempty and NUL-free')
    if (!isAbsolute(request.cwd) || request.cwd.includes('\0')) throw new Error('cwd must be an absolute NUL-free path')
    if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1) throw new Error('maxOutputBytes must be positive')
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('process timed out'))
    }, request.timeoutMs)
    try {
      const argv = await this.prepareCommand?.(request.argv) ?? request.argv
      controller.signal.throwIfAborted()
      const handle = this.runtime.spawn({
        argv,
        cwd: request.cwd,
        env: { ...request.env },
        graceMs: 5_000,
        signal: controller.signal,
        stdio: { stdin: request.stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' },
      })
      if (request.stdin !== undefined) {
        if (handle.stdin === undefined) throw new Error('subprocess did not expose stdin')
        handle.stdin.end(request.stdin)
      }
      let consumerClosed = false
      const stdout = boundedRead(handle.stdout, request.maxOutputBytes, () => consumerClosed)
      const stderr = boundedRead(handle.stderr, request.maxOutputBytes, () => consumerClosed)
      // The subprocess provider bounds whole-tree settlement, but raw pipe
      // ownership belongs to this consumer. A killed SSH client can leave a
      // remote descendant holding the channel after the local leader settles;
      // close our read ends when `done` settles so capture cannot wait forever
      // after its timeout has already fired.
      const outcome = handle.done.finally(() => {
        consumerClosed = true
        handle.stdout?.destroy()
        handle.stderr?.destroy()
      })
      const [settled, capturedStdout, capturedStderr] = await Promise.all([
        outcome,
        stdout,
        stderr,
      ])
      return {
        argv: [...request.argv],
        exitCode: settled.exitCode,
        signal: settled.signal,
        stdout: capturedStdout,
        stderr: capturedStderr,
        timedOut,
      }
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
  }
}

/** Deterministic driver for provider contract tests. */
export class ScriptedProcessDriver implements ProcessDriver {
  readonly requests: Parameters<ProcessDriver['capture']>[0][] = []
  constructor(private readonly handler: (request: Parameters<ProcessDriver['capture']>[0]) => Promise<Partial<CapturedProcess>> | Partial<CapturedProcess>) {}

  async capture(request: Parameters<ProcessDriver['capture']>[0]): Promise<CapturedProcess> {
    this.requests.push(request)
    const result = await this.handler(request)
    return {
      argv: request.argv,
      exitCode: 0,
      signal: null,
      stdout: EMPTY,
      stderr: EMPTY,
      timedOut: false,
      ...result,
    }
  }
}
