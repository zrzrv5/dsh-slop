import { PassThrough } from 'node:stream'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'
import { DshProcessDriver } from '../src/process-driver.ts'

describe('DshProcessDriver', () => {
  it('closes consumer-owned raw pipes after the managed process settles', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.write('partial stdout')
    stderr.write('partial stderr')

    const runtime = {
      spawn: () => ({
        pid: 123,
        stdin: undefined,
        stdout,
        stderr,
        collected: {},
        done: Promise.resolve({ exitCode: null, signal: 'SIGTERM' as const }),
        terminate: () => undefined,
        waitForExit: () => Promise.resolve(true),
      }),
    } as unknown as SubprocessRuntime
    const driver = new DshProcessDriver(runtime)

    const result = await driver.capture({
      argv: ['/usr/bin/ssh', 'example'],
      cwd: '/tmp',
      timeoutMs: 20_000,
      maxOutputBytes: 1_024,
    })

    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: Buffer.from('partial stdout'),
      stderr: Buffer.from('partial stderr'),
      timedOut: false,
    })
    expect(stdout.destroyed).toBe(true)
    expect(stderr.destroyed).toBe(true)
  })

  it('returns a timed-out result even when killed-process pipes never close themselves', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.write('before timeout')
    let settle: ((value: { exitCode: null; signal: 'SIGTERM' }) => void) | undefined
    const done = new Promise<{ exitCode: null; signal: 'SIGTERM' }>(resolve => { settle = resolve })
    const runtime = {
      spawn: (spec: { signal?: AbortSignal }) => {
        spec.signal?.addEventListener('abort', () => settle?.({ exitCode: null, signal: 'SIGTERM' }), { once: true })
        return {
          pid: 456,
          stdin: undefined,
          stdout,
          stderr,
          collected: {},
          done,
          terminate: () => undefined,
          waitForExit: () => Promise.resolve(true),
        }
      },
    } as unknown as SubprocessRuntime
    const driver = new DshProcessDriver(runtime)

    const result = await driver.capture({
      argv: ['/usr/bin/ssh', 'example'],
      cwd: '/tmp',
      timeoutMs: 5,
      maxOutputBytes: 1_024,
    })

    expect(result).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: Buffer.from('before timeout'),
      stderr: Buffer.alloc(0),
      timedOut: true,
    })
  })
})
