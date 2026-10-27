import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WSL_UNAVAILABLE_MESSAGE, verifyWslSocketRoot } from '../src/ssh-broker.ts'
import type { ProcessDriver } from '../src/types.ts'

type Capture = ProcessDriver['capture']
type Result = Awaited<ReturnType<Capture>>

function result(exitCode: number, stdout = '', stderr = ''): Result {
  return { exitCode, signal: null, timedOut: false, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) } as Result
}

/** Runs the script with the local POSIX shell, standing in for a working WSL distribution. */
const localShell: Pick<ProcessDriver, 'capture'> = {
  capture: async ({ argv }) => {
    const [command, ...args] = argv
    const run = spawnSync(command!, args, { encoding: 'buffer' })
    return result(run.status ?? 1, run.stdout.toString(), run.stderr.toString())
  },
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'slop-wsl-root-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('WSL control-socket root', () => {
  it('reports a WSL launch failure as missing WSL, not as a directory problem', async () => {
    // wsl.exe prints UTF-16 text and exits nonzero before any Linux command runs.
    const noDistribution: Pick<ProcessDriver, 'capture'> = { capture: async () => result(1, '', 'W\0i\0n\0d\0o\0w\0s\0 \0S\0u\0b\0s\0y\0s\0t\0e\0m\0') }
    await expect(verifyWslSocketRoot(noDistribution, join(root, 'sockets'), root)).rejects.toThrow(WSL_UNAVAILABLE_MESSAGE)
    await expect(verifyWslSocketRoot({ capture: async () => ({ ...result(1), timedOut: true }) }, join(root, 'sockets'), root)).rejects.toThrow(WSL_UNAVAILABLE_MESSAGE)
  })

  it.skipIf(process.platform !== 'linux')('creates a private directory once and accepts it again', async () => {
    const sockets = join(root, 'sockets')
    await verifyWslSocketRoot(localShell, sockets, root)
    expect((await stat(sockets)).mode & 0o777).toBe(0o700)
    await expect(verifyWslSocketRoot(localShell, sockets, root)).resolves.toBeUndefined()
  })

  it.skipIf(process.platform !== 'linux')('names the reason for an unsafe existing directory and does not repair it', async () => {
    const open = join(root, 'open')
    await mkdir(open, { mode: 0o755 })
    await expect(verifyWslSocketRoot(localShell, open, root)).rejects.toThrow(/permissions are not 700.*does not change it/u)
    expect((await stat(open)).mode & 0o777).toBe(0o755)

    const target = join(root, 'target'), linked = join(root, 'linked')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, linked)
    await expect(verifyWslSocketRoot(localShell, linked, root)).rejects.toThrow(/is a symbolic link/u)
  })
})
