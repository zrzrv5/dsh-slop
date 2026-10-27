import { describe, expect, it } from 'vitest'
import { queueProbeBatchSchema, type QueueProbeRequest } from '@dsh-slop/queue'
import type { Context } from '@deepseek-ai/cordis'
import { DshQueueCommandRunner, DshQueueProbe, type QueueCommandResult, type QueueCommandRunner } from '../src/queue-probe.ts'

const now = new Date('2026-09-03T12:00:00.000Z')

function request(kind: 'slurm' | 'pbs'): QueueProbeRequest {
  return {
    batchId: 'batch',
    target: { kind: 'machine', machineId: 'nova' },
    observerKind: kind,
    items: [{
      id: 'item-1' as QueueProbeRequest['items'][number]['id'],
      label: 'simulation',
      state: 'queued',
      observer: { kind, jobId: '123' },
      createdAt: '2026-09-03T11:55:00.000Z',
    }],
  }
}

function runner(result: QueueCommandResult): QueueCommandRunner {
  return { run: async () => result }
}

describe('DshQueueProbe', () => {
  it('keeps a remote observation unavailable without requesting fallback when Machine is disabled', async () => {
    const command = new DshQueueCommandRunner({} as Context, () => undefined, '/tmp')
    const result = queueProbeBatchSchema.parse(await new DshQueueProbe(command).probe(request('slurm')))
    expect(result.observations).toEqual([])
    expect(result.issues).toEqual([expect.objectContaining({ kind: 'retry', code: 'MACHINE_UNAVAILABLE' })])
  })

  it('turns packed Slurm output into a code-sourced walltime observation', async () => {
    const probe = new DshQueueProbe(runner({
      exitCode: 0,
      timedOut: false,
      stdout: '123|RUNNING|00:10:00|04:00:00|2026-09-03T11:50:00|2026-09-03T15:50:00|node-a\n__DSH_SACCT__\n',
      stderr: '',
    }), () => now)
    const result = queueProbeBatchSchema.parse(await probe.probe(request('slurm')))
    expect(result.issues).toEqual([])
    expect(result.observations[0]).toMatchObject({
      queueItemId: 'item-1',
      state: 'running',
      source: 'code',
      elapsedSeconds: 600,
      walltimeSeconds: 14_400,
      walltimeRemainingSeconds: 13_800,
      startedAt: '2026-09-03T11:50:00.000Z',
    })
  })

  it('uses the new-job grace path without requesting agent fallback', async () => {
    const probe = new DshQueueProbe(runner({ exitCode: 0, timedOut: false, stdout: '__DSH_SACCT__\n', stderr: '' }), () => now)
    const result = queueProbeBatchSchema.parse(await probe.probe(request('slurm')))
    expect(result.observations).toEqual([])
    expect(result.issues[0]).toMatchObject({ kind: 'retry', code: 'JOB_NOT_VISIBLE_YET' })
  })

  it('classifies an unavailable scheduler for fallback rather than inventing state', async () => {
    const probe = new DshQueueProbe(runner({ exitCode: 127, timedOut: false, stdout: '', stderr: 'qstat: command not found' }), () => now)
    const result = queueProbeBatchSchema.parse(await probe.probe(request('pbs')))
    expect(result.observations).toEqual([])
    expect(result.issues[0]).toMatchObject({ kind: 'fallback', code: 'OBSERVER_UNSUPPORTED' })
  })

  it('routes unrecognized scheduler states to semantic fallback', async () => {
    const probe = new DshQueueProbe(runner({
      exitCode: 0,
      timedOut: false,
      stdout: '123|SITE_SPECIFIC|00:10:00|04:00:00||||\n__DSH_SACCT__\n',
      stderr: '',
    }), () => now)
    const result = queueProbeBatchSchema.parse(await probe.probe(request('slurm')))
    expect(result.observations).toEqual([])
    expect(result.issues[0]).toMatchObject({ kind: 'fallback', code: 'OBSERVER_OUTPUT_AMBIGUOUS' })
  })

  it('rejects unsafe job ids without constructing a command', async () => {
    let called = false
    const probe = new DshQueueProbe({ run: async () => { called = true; throw new Error('must not run') } }, () => now)
    const base = request('slurm')
    const unsafe: QueueProbeRequest = {
      ...base,
      items: [{ ...base.items[0]!, observer: { kind: 'slurm', jobId: '123; touch /tmp/nope' } }],
    }
    const result = queueProbeBatchSchema.parse(await probe.probe(unsafe))
    expect(called).toBe(false)
    expect(result.issues[0]).toMatchObject({ kind: 'action-required', code: 'INVALID_JOB_ID' })
  })
})
