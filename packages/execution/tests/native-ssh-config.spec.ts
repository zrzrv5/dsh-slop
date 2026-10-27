import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { machineIdSchema } from '@dsh-slop/core'
import { parseNativeSshConfig } from '../src/native-ssh-config.ts'
import { sshBackend } from '../src/ssh-backend.ts'
import type { SshConnectionProfile } from '../src/types.ts'

const profile: SshConnectionProfile = { machineId: machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a1'), revision: 1, alias: 'cluster', trust: { mode: 'tofu', expectedFingerprints: [] }, ownership: 'app-managed', connectTimeoutSeconds: 10, keepaliveSeconds: 30, idleTimeoutSeconds: 43200, concurrencyLimit: 8 }

describe('native Windows SSH selection and configuration', () => {
  it('defaults Windows to native and requires explicit WSL selection', () => {
    expect(sshBackend('win32', '')).toBe('native')
    expect(sshBackend('linux', '')).toBe('openssh')
    expect(sshBackend('win32', 'wsl')).toBe('wsl')
    expect(() => sshBackend('win32', 'openssh')).toThrow('Invalid')
  })
  it('preserves identity paths with spaces, expands home and resolves the agent', () => {
    const parsed = parseNativeSshConfig('hostname example.test\nuser alice\nport 2222\nidentityfile ~/.ssh/my key\nidentityagent none\nuserknownhostsfile ~/.ssh/known hosts ~/.ssh/other hosts\n', profile)
    expect(parsed.identityFiles).toEqual([join(homedir(), '.ssh/my key')])
    expect(parsed.knownHostsFiles).toEqual([join(homedir(), '.ssh/known hosts'), join(homedir(), '.ssh/other hosts')])
    expect(parsed.agent).toBeUndefined()
  })
  it('refuses a jump or proxy instead of connecting directly to the final host', () => {
    for (const value of ['proxyjump bastion', 'proxycommand custom-proxy %h', 'certificatefile ~/.ssh/cert']) expect(() => parseNativeSshConfig(`hostname example.test\nuser alice\n${value}\n`, profile)).toThrow('does not support')
  })
  it('respects disabled authentication and refuses to widen an unsupported algorithm policy', () => {
    const parsed = parseNativeSshConfig('hostname example.test\nuser alice\npubkeyauthentication false\npasswordauthentication no\nkbdinteractiveauthentication no\n', profile)
    expect(parsed.identityFiles).toEqual([]); expect(parsed.agent).toBeUndefined()
    expect(parsed.passwordAuthentication).toBe(false); expect(parsed.keyboardAuthentication).toBe(false)
    expect(() => parseNativeSshConfig('hostname example.test\nuser alice\nkexalgorithms unsupported-kex-only\n', profile)).toThrow('no native-supported')
  })
  it.skipIf(process.platform !== 'win32')('expands Windows ProgramData and preserves spaces in unquoted -G paths', () => {
    const parsed = parseNativeSshConfig('hostname example.test\nuser alice\nuserknownhostsfile C:\\Users\\Alice Smith/.ssh/known_hosts C:\\Users\\Alice Smith/.ssh/known_hosts2\nglobalknownhostsfile __PROGRAMDATA__\\ssh/ssh_known_hosts\n', profile)
    expect(parsed.knownHostsFiles).toHaveLength(3)
    expect(parsed.knownHostsFiles[0]).toBe('C:\\Users\\Alice Smith/.ssh/known_hosts')
    expect(parsed.knownHostsFiles[2]).toContain(process.env.ProgramData ?? 'C:\\ProgramData')
  })
})
