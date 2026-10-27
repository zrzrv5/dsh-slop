import { posix, win32 } from 'node:path'
import { z } from 'zod'

/** Nominal product value carried as its JSON representation at runtime. */
export type Brand<Value, Tag extends string> = Value & { readonly __brand: Tag }

export type Sha256 = Brand<string, 'Sha256'>
export type Instant = Brand<string, 'Instant'>
export type DecimalString = Brand<string, 'DecimalString'>
export type LocalAbsolutePath = Brand<string, 'LocalAbsolutePath'>
export type RemotePath = Brand<string, 'RemotePath'>
export type Revision = Brand<number, 'Revision'>

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA_256 = /^[a-f0-9]{64}$/
const UTC_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DECIMAL = /^(?:0|[1-9][0-9]*)$/
const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const idSchema = <Tag extends string>(tag: Tag) => z.string()
  .regex(UUID_V7, `${tag} must be a lowercase UUIDv7`)
  .transform(value => value as Brand<string, Tag>)

export const productIdSchema = idSchema
export const sha256Schema = z.string().regex(SHA_256, 'must be a lowercase SHA-256 hex digest').transform(value => value as Sha256)

export function asSha256(value: string): Sha256 {
  return sha256Schema.parse(value)
}

export const instantSchema = z.string()
  .regex(UTC_MILLISECONDS, 'must be a UTC RFC 3339 timestamp with millisecond precision')
  .refine(value => new Date(value).toISOString() === value, 'must be a valid UTC instant')
  .transform(value => value as Instant)

export function toInstant(value: Date = new Date()): Instant {
  return value.toISOString() as Instant
}

export const decimalStringSchema = z.string()
  .regex(DECIMAL, 'must be a non-negative base-10 integer without leading zeroes')
  .max(80, 'must contain at most 80 digits')
  .transform(value => value as DecimalString)

export const revisionSchema = z.number().int().min(1).max(2_147_483_647).transform(value => value as Revision)

export const machineIdSchema = idSchema('MachineId')
export const accessProfileIdSchema = idSchema('AccessProfileId')
export const connectionObservationIdSchema = idSchema('ConnectionObservationId')
export const accessChallengeIdSchema = idSchema('AccessChallengeId')
export const authFlowIdSchema = idSchema('AuthFlowId')
export const authAttachmentLeaseIdSchema = idSchema('AuthAttachmentLeaseId')
export const connectionWaiterIdSchema = idSchema('ConnectionWaiterId')
export const connectionLeaseIdSchema = idSchema('ConnectionLeaseId')
export const approvalReceiptIdSchema = idSchema('ApprovalReceiptId')

/** DSH-owned ids stay opaque and are never reparsed as product UUIDs. */
export const sessionIdSchema = z.string().min(1).max(512).transform(value => value as Brand<string, 'SessionId'>)
export const agentIdSchema = z.string().min(1).max(512).transform(value => value as Brand<string, 'AgentId'>)
export const principalIdSchema = z.string().min(1).max(256).transform(value => value as Brand<string, 'PrincipalId'>)
export const executionProviderIdSchema = z.string().regex(PROVIDER_ID, 'must be lowercase kebab-case').max(128)
  .transform(value => value as Brand<string, 'ExecutionProviderId'>)

export type MachineId = z.output<typeof machineIdSchema>
export type AccessProfileId = z.output<typeof accessProfileIdSchema>
export type ConnectionObservationId = z.output<typeof connectionObservationIdSchema>
export type AccessChallengeId = z.output<typeof accessChallengeIdSchema>
export type AuthFlowId = z.output<typeof authFlowIdSchema>
export type AuthAttachmentLeaseId = z.output<typeof authAttachmentLeaseIdSchema>
export type ConnectionWaiterId = z.output<typeof connectionWaiterIdSchema>
export type ConnectionLeaseId = z.output<typeof connectionLeaseIdSchema>
export type ApprovalReceiptId = z.output<typeof approvalReceiptIdSchema>
export type SessionId = z.output<typeof sessionIdSchema>
export type AgentId = z.output<typeof agentIdSchema>
export type PrincipalId = z.output<typeof principalIdSchema>
export type ExecutionProviderId = z.output<typeof executionProviderIdSchema>

export function asPrincipalId(value: string): PrincipalId {
  return principalIdSchema.parse(value)
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || !value.startsWith('/')) return false
  if (value !== '/' && value.endsWith('/')) return false
  if (posix.normalize(value) !== value) return false
  return !value.split('/').some(segment => segment === '.' || segment === '..')
}

export const localAbsolutePathSchema = z.string().min(1).max(4_096)
  .refine(value => {
    if (isCanonicalAbsolutePath(value)) return true
    if (/[\0\r\n]/u.test(value) || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u.test(value)) return false
    const normalized = value.replaceAll('\\', '/')
    return win32.isAbsolute(value) && win32.normalize(value).replaceAll('\\', '/') === normalized
      && !normalized.split('/').some(part => part === '.' || part === '..')
      && (value === win32.parse(value).root || !/[\\/]$/u.test(value))
  }, 'must be a canonical absolute local path')
  .transform(value => value as LocalAbsolutePath)

export const remotePathSchema = z.string().min(1).max(4_096)
  .refine(isCanonicalAbsolutePath, 'must be a canonical absolute POSIX path')
  .transform(value => value as RemotePath)

export const executionTargetPathSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: localAbsolutePathSchema }).strict(),
  z.object({ kind: z.literal('remote'), path: remotePathSchema }).strict(),
])

export const nonEmptyTextSchema = z.string().trim().min(1).max(4_096).refine(value => !value.includes('\0'), 'must not contain NUL')
