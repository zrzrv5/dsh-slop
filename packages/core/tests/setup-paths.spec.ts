import { describe, expect, it } from 'vitest'
import { machineCreateRequestSchema } from '../src/inventory-service.ts'

const input = { sshTarget: 'cluster', authentication: { kind: 'requires-2fa' }, scheduler: 'unknown', idempotencyKey: 'setup-test' }

describe('setup root paths', () => {
  it('accepts directory separators while preserving canonical stored paths', () => {
    expect(machineCreateRequestSchema.parse({ ...input, paths: { home: '/', work: '/volume1/work/' } }).paths).toEqual({ home: '/', work: '/volume1/work' })
  })
  it.each(['relative', '/work/../private', '/work//project'])('rejects ambiguous path %s', work => {
    expect(machineCreateRequestSchema.safeParse({ ...input, paths: { work } }).success).toBe(false)
  })
})
