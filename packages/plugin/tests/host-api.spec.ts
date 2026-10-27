import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Machine browser host', () => {
  it('does not mount retired greenfield-incompatible browser remotes', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const retired = [
      'machine.create',
      'onboarding.create',
      'onboarding.get',
      'onboarding.start',
      'onboarding.pause',
      'onboarding.resume',
      'onboarding.cancel',
      'onboarding.amendScope',
      'onboarding.review',
      'onboarding.apply',
      'setup.start',
      'software.binding.create',
      'hostTrust.inspect',
      'hostTrust.request',
      'hostTrust.decideRotation',
      'connection.connect',
      'connection.recheck',
      'connection.closeOwned',
      'auth.begin',
      'auth.status',
      'auth.cancel',
      'executionContext.select',
      'job.prepare',
      'job.logDownload',
      'transfer.resume',
      'workspacePolicy.write',
      'backup.restore',
    ] as const

    for (const method of retired) expect(source).not.toContain(`@Remote('${method}')`)
  })

  it('mounts only the Machine and transfer-progress browser remotes', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const required = [
      'snapshot',
      'machine.list',
      'machine.get',
      'machine.archive',
      'hostTrust.decide',
      'authFlow.start',
      'authFlow.status',
      'authFlow.cancel',
      'transferProgress.get',
    ] as const

    for (const method of required) expect(source).toContain(`@Remote('${method}')`)
    expect(source.match(/@Remote\('/gu)).toHaveLength(required.length)
  })
})
