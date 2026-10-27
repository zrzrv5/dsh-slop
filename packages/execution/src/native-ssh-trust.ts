import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { NativeSshConfig } from './native-ssh-config.ts'
import type { SshConnectionProfile } from './types.ts'
import { SshConnectionError, verifyPinnedTrust } from './ssh-broker.ts'

export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
}

export function knownHostName(config: NativeSshConfig): string {
  if (config.hostKeyAlias !== undefined) return config.hostKeyAlias
  return config.port === 22 ? config.host : `[${config.host}]:${config.port}`
}

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, digest] = pattern.split('|')
    if (salt === undefined || digest === undefined) return false
    const expected = Buffer.from(digest, 'base64')
    const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest()
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
  const patterns = pattern.split(',')
  const matches = (value: string): boolean => new RegExp(`^${value.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'iu').test(host)
  return !patterns.some(value => value.startsWith('!') && matches(value.slice(1))) && patterns.some(value => !value.startsWith('!') && matches(value))
}

/** Trust is prepared before authentication; unknown and changed keys fail closed. */
export async function nativeHostVerifier(profile: SshConnectionProfile, config: NativeSshConfig): Promise<(key: Buffer) => boolean> {
  if (profile.trust.mode === 'pinned') await verifyPinnedTrust(profile)
  const files = profile.trust.mode === 'pinned' ? [profile.trust.appKnownHostsPath!] : config.knownHostsFiles
  const entries: { key: Buffer; revoked: boolean }[] = []
  for (const file of files) {
    let text: string
    try { text = await readFile(file, 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw new SshConnectionError('CONNECTION_UNAVAILABLE', 'The SSH known_hosts file could not be read.')
    }
    for (const line of text.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u)
      if (fields[0]?.startsWith('#')) continue
      const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined
      if (fields.length < 3 || marker !== undefined && marker !== '@revoked' || !hostMatches(fields[0]!, knownHostName(config))) continue
      entries.push({ key: Buffer.from(fields[2]!, 'base64'), revoked: marker === '@revoked' })
    }
  }
  return key => {
    const equal = (entry: { key: Buffer }): boolean => entry.key.length === key.length && timingSafeEqual(entry.key, key)
    if (entries.some(entry => entry.revoked && equal(entry))) throw new SshConnectionError('HOST_KEY_CHANGED', 'The remote host key is revoked.')
    if (!entries.some(entry => !entry.revoked && equal(entry))) throw new SshConnectionError(entries.length ? 'HOST_KEY_CHANGED' : 'HOST_KEY_REQUIRED', entries.length ? 'The remote host key changed; reconnect is blocked.' : 'The remote host key is not trusted.')
    if (profile.trust.mode === 'pinned' && !profile.trust.expectedFingerprints.includes(sshFingerprint(key))) throw new SshConnectionError('HOST_KEY_CHANGED', 'The remote host key does not match the approved fingerprint.')
    return true
  }
}
