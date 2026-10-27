import { createHmac } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { machineIdSchema } from '@dsh-slop/core'
import { nativeHostVerifier, knownHostName } from '../src/native-ssh-trust.ts'
import type { SshConnectionProfile } from '../src/types.ts'
import { fixtureKey, parsedKey } from './native-ssh-fixture.ts'

const profile: SshConnectionProfile = { machineId: machineIdSchema.parse('018f0000-0000-7000-8000-0000000000a1'), revision: 1, alias: 'cluster', trust: { mode: 'user-known-hosts', expectedFingerprints: [] }, ownership: 'app-managed', connectTimeoutSeconds: 10, keepaliveSeconds: 30, idleTimeoutSeconds: 43200, concurrencyLimit: 8 }

describe('native known_hosts verification', () => {
  it('honors hashed names, comments and revocation without treating another host as trusted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-trust-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'known_hosts'), key = parsedKey(fixtureKey()).getPublicSSH()
    const salt = Buffer.from('fixture-salt'), hash = createHmac('sha1', salt).update('[example.test]:2222').digest('base64')
    const line = `|1|${salt.toString('base64')}|${hash} ssh-rsa ${key.toString('base64')} fixture comment\n`
    const config = { host: 'example.test', port: 2222, username: 'fixture', identityFiles: [], knownHostsFiles: [file] }
    await writeFile(file, line)
    expect((await nativeHostVerifier(profile, config))(key)).toBe(true)
    const other = await nativeHostVerifier(profile, { ...config, host: 'another.test' })
    expect(() => other(key)).toThrow('not trusted')
    const changed = await nativeHostVerifier(profile, config)
    expect(() => changed(parsedKey(fixtureKey()).getPublicSSH())).toThrow('changed')
    await writeFile(file, line + '@revoked ' + line)
    const revoked = await nativeHostVerifier(profile, config)
    expect(() => revoked(key)).toThrow('revoked')
  })
  it('uses HostKeyAlias literally, including on a nondefault port', () => {
    expect(knownHostName({ host: 'example.test', hostKeyAlias: 'approved-alias', port: 2222, username: 'fixture', identityFiles: [], knownHostsFiles: [] })).toBe('approved-alias')
  })
})
