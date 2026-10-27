import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoveryRootInput, resolveDiscoveryRootCommand, resolvedDiscoveryRoot } from '../src/resolve-discovery-root.ts'

describe('read-only discovery root resolution', () => {
  it.skipIf(process.platform === 'win32')('resolves spaces and literal shell punctuation without evaluating them', () => {
    const root = mkdtempSync(join(tmpdir(), 'slop-root-'))
    try {
      const name = "Data ' $(false); $USER"
      mkdirSync(join(root, name))
      const stdout = execFileSync('/bin/sh', ['-c', resolveDiscoveryRootCommand(`~/${name}`)], { env: { ...process.env, HOME: root }, encoding: 'utf8' })
      expect(resolvedDiscoveryRoot(stdout)).toBe(join(root, name).replace(/^\/var\//, '/private/var/'))
    } finally { rmSync(root, { recursive: true }) }
  })
  it.each(['relative', '~someone/data', '~/../secret', '/data\nother', '/data\0other'])('rejects ambiguous path %s', path => {
    expect(discoveryRootInput(path)).toBeUndefined()
  })
  it('rejects noisy output instead of guessing a root', () => {
    expect(resolvedDiscoveryRoot('welcome\n/home/alice\n')).toBeUndefined()
  })
})
