import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { scanSshConfig } from '../src/ssh-config-candidates.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'slop-ssh-config-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, '.ssh', 'conf.d'), { recursive: true })
  return home
}

describe('SSH candidate scan', () => {
  it('retains Windows backslashes and Unicode in identity paths', async () => {
    const home = await fixture()
    await writeFile(join(home, '.ssh/config'), 'Host windows\n IdentityFile "C:\\Users\\名字\\My Keys\\id_ed25519"\n')
    expect((await scanSshConfig(home)).candidates[0]?.identityFile).toBe('C:\\Users\\名字\\My Keys\\id_ed25519')
  })
  it('reads aliases and Includes without executing commands, reading keys, or expanding wildcard Hosts', async () => {
    const home = await fixture()
    await writeFile(join(home, '.ssh/config'), `Host * !excluded\n  User default\nInclude conf.d/*.conf\nHost cluster alias-two\n HostName login.example.org\n IdentityFile "~/.ssh/key with spaces"\n ProxyCommand touch /should-not-run\nMatch exec "touch /should-not-run"\n User conditional\nInclude config\n`)
    await writeFile(join(home, '.ssh/conf.d/one.conf'), 'Host nas\n HostName=nas.example.org # comment\n User alice\n Port 2200\n')
    const result = await scanSshConfig(home)
    expect(result.candidates.map(value => value.alias)).toEqual(['nas', 'cluster', 'alias-two'])
    expect(result.candidates[0]).toMatchObject({ hostName: 'nas.example.org', user: 'alice', port: '2200' })
    expect(result.candidates[1]).toMatchObject({ identityFile: '~/.ssh/key with spaces' })
    expect(result.candidates[1]?.user).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('touch')
  })

  it('returns an empty scan for missing config and bounds candidate count and file size', async () => {
    const home = await fixture()
    expect((await scanSshConfig(home)).candidates).toEqual([])
    await writeFile(join(home, '.ssh/config'), Array.from({ length: 80 }, (_, i) => `Host machine-${i}`).join('\n'))
    expect((await scanSshConfig(home)).candidates).toHaveLength(64)
    await writeFile(join(home, '.ssh/config'), '#'.repeat(70 * 1024))
    const result = await scanSshConfig(home)
    expect(result.candidates).toEqual([])
    expect(result.warnings).not.toEqual([])
  })

  it('honors cancellation', async () => {
    await expect(scanSshConfig(await fixture(), AbortSignal.abort())).rejects.toThrow()
  })
})
