const MAX_OUTPUT_CHARS = 128 * 1_024
const MAX_ENTRIES = 128

export interface TransferProgressSnapshot {
  readonly callId: string
  readonly status: 'running' | 'completed' | 'failed'
  readonly output: string
}

/** Process-local, bounded UI relay for native scp PTY bytes. */
export class TransferProgressHub {
  private readonly entries = new Map<string, TransferProgressSnapshot>()

  start(callId: string): void {
    this.entries.delete(callId)
    this.entries.set(callId, { callId, status: 'running', output: '' })
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  append(callId: string, text: string): void {
    const current = this.entries.get(callId)
    if (current === undefined || current.status !== 'running' || text.length === 0) return
    const output = `${current.output}${text}`
    this.entries.set(callId, {
      ...current,
      output: output.length <= MAX_OUTPUT_CHARS ? output : output.slice(-MAX_OUTPUT_CHARS),
    })
  }

  finish(callId: string, failed: boolean): void {
    const current = this.entries.get(callId)
    if (current === undefined) return
    this.entries.set(callId, { ...current, status: failed ? 'failed' : 'completed' })
  }

  get(callId: string): TransferProgressSnapshot | undefined {
    return this.entries.get(callId)
  }
}
