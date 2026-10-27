import { describe, expect, it } from 'vitest'
import { SshPlatform } from '../src/ssh-platform.ts'
import { ScriptedProcessDriver } from '../src/process-driver.ts'
import { sshBaseArgv } from '@dsh-slop/operations'

describe('Windows SSH environment', () => {
  it('converts local key and trust files without rewriting the alias or remote command', async () => {
    const local = new ScriptedProcessDriver(request => {
      expect(request.argv.slice(0, 6)).toEqual(['wsl.exe', '--distribution', 'Ubuntu', '--cd', '~', '--exec'])
      expect(request.argv.slice(6, 9)).toEqual(['wslpath', '-a', '-u'])
      return { stdout: Buffer.from(request.argv[9]!.replace(/^C:[\\/]/u, '/mnt/c/').replaceAll('\\', '/') + '\n') }
    })
    const adapter = new SshPlatform(local, 'C:\\Work Files', 'win32', 'Ubuntu')
    const remote = 'printf "%s" "C:\\remote\\x; $(false)"'
    const argv = [...sshBaseArgv({ alias: 'cluster', connectTimeoutSeconds: 30, keepaliveSeconds: 30, controlMode: 'app-managed', controlPersistSeconds: 43200, localKeyFilePath: 'C:\\SSH Keys\\key', appKnownHosts: 'C:\\User Data\\known_hosts' }, '/tmp/master.sock'), 'sh', '-c', remote]
    const prepared = await adapter.prepareCommand(argv)
    expect(prepared).toContain('/mnt/c/SSH Keys/key')
    expect(prepared).toContain('UserKnownHostsFile="/mnt/c/User Data/known_hosts"')
    expect(prepared).toContain('ControlPath=/tmp/master.sock')
    expect(prepared.slice(-4)).toEqual(['cluster', 'sh', '-c', remote])
    expect(local.requests).toHaveLength(2)
  })

  it('converts scp local paths and its config while retaining remote operands and relay mode', async () => {
    const local = new ScriptedProcessDriver(request => ({ stdout: Buffer.from(request.argv.at(-1)!.replace('C:/', '/mnt/c/') + '\n') }))
    const adapter = new SshPlatform(local, 'C:/Work', 'win32')
    const prepared = await adapter.prepareCommand(['scp', '-F', 'C:/Temp Folder/config', '-3', '--', 'machine:/remote/C:/data', 'C:/Output Files/data'])
    expect(prepared.slice(-7)).toEqual(['scp', '-F', '/mnt/c/Temp Folder/config', '-3', '--', 'machine:/remote/C:/data', '/mnt/c/Output Files/data'])
    expect(local.requests).toHaveLength(2)
  })

  it('preserves Unix commands and does not probe WSL during construction', async () => {
    const driver = new ScriptedProcessDriver(() => { throw new Error('unexpected process') })
    const argv = ['ssh', '-i', '~/key', '--', 'cluster', 'true']
    expect(await new SshPlatform(driver, '/tmp', 'linux').prepareCommand(argv)).toBe(argv)
    new SshPlatform(driver, 'C:/Work', 'win32')
    expect(driver.requests).toHaveLength(0)
  })

  it('rejects failed path translation instead of passing a native path to Linux SSH', async () => {
    const driver = new ScriptedProcessDriver(() => ({ exitCode: 1 }))
    await expect(new SshPlatform(driver, 'C:/Work', 'win32').prepareCommand(['ssh', '-i', 'C:/key', '--', 'cluster'])).rejects.toThrow('WSL distribution')
  })
})
