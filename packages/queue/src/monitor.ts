import type { QueueService } from './service.ts'
import type { QueueClockPort, QueueTimerHandle, QueueTimerPort } from './types.ts'

const MAX_TIMEOUT_MILLISECONDS = 2_147_483_647

export const systemQueueClock: QueueClockPort = { now: () => new Date() }

export const systemQueueTimer: QueueTimerPort = {
  schedule(at, callback) {
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MILLISECONDS, at.getTime() - Date.now()))
    const timer = setTimeout(callback, delay)
    return { cancel: () => clearTimeout(timer) }
  },
}

export interface QueueMonitorOptions {
  readonly service: QueueService
  readonly clock?: QueueClockPort
  readonly timer?: QueueTimerPort
  readonly failureRetrySeconds?: number
  readonly onError?: (error: unknown) => void
}

/** Maintains one earliest-due timer. One firing coalesces every overdue item. */
export class QueueMonitor {
  private readonly clock: QueueClockPort
  private readonly timerPort: QueueTimerPort
  private readonly failureRetrySeconds: number
  private timer: QueueTimerHandle | undefined
  private started = false
  private firing = false

  constructor(private readonly options: QueueMonitorOptions) {
    this.clock = options.clock ?? systemQueueClock
    this.timerPort = options.timer ?? systemQueueTimer
    this.failureRetrySeconds = options.failureRetrySeconds ?? 30
    if (!Number.isFinite(this.failureRetrySeconds) || this.failureRetrySeconds <= 0) {
      throw new Error('failureRetrySeconds must be positive')
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      await this.options.service.initialize()
      await this.options.service.flushPendingDeliveries(this.clock.now())
      await this.refresh()
    } catch (error) {
      this.started = false
      throw error
    }
  }

  stop(): void {
    this.started = false
    this.timer?.cancel()
    this.timer = undefined
  }

  /** Call after track or update so a newly earlier deadline replaces the current timer. */
  async refresh(): Promise<void> {
    if (!this.started || this.firing) return
    this.timer?.cancel()
    this.timer = undefined
    const next = await this.options.service.earliestWorkAt()
    if (next === undefined || !this.started) return
    const now = this.clock.now()
    const dueAt = new Date(Math.max(now.getTime(), Date.parse(next)))
    this.timer = this.timerPort.schedule(dueAt, () => {
      void this.fire()
    })
  }

  private async fire(): Promise<void> {
    if (!this.started || this.firing) return
    this.timer = undefined
    this.firing = true
    try {
      await this.options.service.runDue(this.clock.now())
    } catch (error) {
      this.options.onError?.(error)
      if (this.started) {
        const retryAt = new Date(this.clock.now().getTime() + this.failureRetrySeconds * 1_000)
        this.timer = this.timerPort.schedule(retryAt, () => {
          void this.fire()
        })
      }
      return
    } finally {
      this.firing = false
    }
    await this.refresh()
  }
}
