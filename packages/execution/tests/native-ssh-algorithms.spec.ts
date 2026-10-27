import { describe, expect, it, vi } from 'vitest'
import ssh2 from 'ssh2'
import { machineIdSchema } from '@dsh-slop/core'
import { nativeAlgorithms } from '../src/native-ssh-algorithms.ts'
import { openNativeConnection } from '../src/native-ssh-client.ts'
import type { SshConnectionProfile } from '../src/types.ts'

const aes = ['aes-128-gcm', 'aes-256-gcm', 'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr']
const policy = (ciphers: string) => (key: string) => key === 'ciphers' ? ciphers : undefined

describe('native SSH runtime cipher capabilities', () => {
  it('omits ChaCha20 in Electron while preserving the configured AES order', () => {
    expect(nativeAlgorithms(policy('chacha20-poly1305@openssh.com,aes256-ctr,aes128-gcm@openssh.com'), aes).cipher)
      .toEqual(['aes256-ctr', 'aes128-gcm@openssh.com'])
  })
  it('retains ChaCha20 when supported by the runtime and allowed by the policy', () => {
    expect(nativeAlgorithms(policy('chacha20-poly1305@openssh.com,aes256-ctr'), [...aes, 'chacha20']).cipher)
      .toEqual(['chacha20-poly1305@openssh.com', 'aes256-ctr'])
    expect(nativeAlgorithms(policy('aes256-ctr'), [...aes, 'chacha20']).cipher).toEqual(['aes256-ctr'])
  })
  it('does not fall back outside a policy with no usable cipher', () => {
    expect(() => nativeAlgorithms(policy('chacha20-poly1305@openssh.com'), aes)).toThrow('no native-supported')
    expect(() => nativeAlgorithms(policy('aes256-ctr'), ['aes-128-ctr'])).toThrow('no native-supported')
  })
  it('uses only runtime ciphers when OpenSSH does not provide a cipher list', () => {
    expect(nativeAlgorithms(() => undefined, ['aes-256-ctr']).cipher).toEqual(['aes256-ctr'])
  })
})

describe('native SSH synchronous connection diagnostics', () => {
  const profile: SshConnectionProfile = { machineId: machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a1'), revision: 1, alias: 'fixture', trust: { mode: 'tofu', expectedFingerprints: [] }, ownership: 'app-managed', connectTimeoutSeconds: 3, keepaliveSeconds: 30, idleTimeoutSeconds: 43200, concurrencyLimit: 8 }
  const config = { host: '127.0.0.1', port: 22, username: 'fixture', identityFiles: [], knownHostsFiles: [] }
  it.each([
    ['Unsupported algorithm: chacha20-poly1305@openssh.com', 'Native SSH configuration is invalid. Unsupported algorithm: chacha20-poly1305@openssh.com.'],
    ['private diagnostic containing a secret', 'Native SSH configuration is invalid.'],
  ])('keeps a safe diagnostic for %s without connecting', async (message, expected) => {
    const cause = new Error(message)
    const connect = vi.spyOn(ssh2.Client.prototype, 'connect').mockImplementation(() => { throw cause })
    try {
      await expect(openNativeConnection(config, profile, new AbortController().signal)).rejects.toMatchObject({ code: 'CONNECTION_UNAVAILABLE', message: expected, cause })
    } finally { connect.mockRestore() }
  })
})
