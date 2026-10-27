import { z } from 'zod'
import {
  accessProfileIdSchema,
  executionProviderIdSchema,
  executionTargetPathSchema,
  instantSchema,
  machineIdSchema,
  nonEmptyTextSchema,
  principalIdSchema,
  revisionSchema,
} from '../primitives.ts'
import { schemaVersionSchema } from './common.ts'

/** The only authenticated principal exposed by the local-owner transport. */
export const localOwnerPrincipalIdSchema = z.literal('local-owner').transform(value => principalIdSchema.parse(value))

const sshFingerprintSchema = z.string()
  .regex(/^SHA256:[A-Za-z0-9+/]+={0,2}$/, 'must be an OpenSSH SHA256 fingerprint')
  .max(256)

/** SSH addressing requires either a config alias or an explicit endpoint. */
export const sshTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('config-alias'),
    alias: z.string().trim().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal('endpoint'),
    host: z.string().trim().min(1).max(253),
    user: z.string().trim().min(1).max(128).optional(),
    port: z.number().int().min(1).max(65_535),
  }).strict(),
])

const hostTrustPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-known-hosts') }).strict(),
  z.object({ kind: z.literal('trust-on-first-use') }).strict(),
  z.object({
    kind: z.literal('pinned'),
    expectedFingerprints: z.array(sshFingerprintSchema).min(1).max(16),
  }).strict(),
])

/**
 * Retained only so existing AccessProfile rows remain readable. Setup no
 * longer exposes VPN and new rows always persist `{ kind: 'none' }`.
 */
const vpnPrerequisiteCompatibilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({
    kind: z.literal('required'),
    label: nonEmptyTextSchema.max(256),
    instructions: nonEmptyTextSchema.max(4_096).optional(),
  }).strict(),
])

const authenticationPrerequisiteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ssh-agent'),
    /** Non-secret local path to the selected private-key file. */
    localKeyFilePath: nonEmptyTextSchema.max(4_096).optional(),
  }).strict(),
  z.object({ kind: z.literal('interactive') }).strict(),
  z.object({ kind: z.literal('provider-managed'), provider: nonEmptyTextSchema.max(128) }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
])

export const accessProfileDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({
    kind: z.literal('ssh'),
    target: sshTargetSchema,
    controlOwnership: z.enum(['app-managed', 'adopt-user-master', 'direct']),
    trustPolicy: hostTrustPolicySchema,
    authentication: authenticationPrerequisiteSchema,
    timeouts: z.object({
      connectSeconds: z.number().int().min(5).max(120),
      keepaliveSeconds: z.number().int().min(10).max(300),
      keepaliveMisses: z.number().int().min(1).max(10),
      idleSeconds: z.number().int().min(60).max(86_400),
    }).strict(),
  }).strict(),
])

const accessProfileBase = {
  schemaVersion: schemaVersionSchema,
  id: accessProfileIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  revision: revisionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
}

/** Non-secret connection intent. Credentials and authentication bytes have no field. */
export const accessProfileSchema = z.discriminatedUnion('kind', [
  z.object({ ...accessProfileBase, kind: z.literal('local') }).strict(),
  z.object({
    ...accessProfileBase,
    kind: z.literal('ssh'),
    target: sshTargetSchema,
    controlOwnership: z.enum(['app-managed', 'adopt-user-master', 'direct']),
    trustPolicy: hostTrustPolicySchema,
    vpn: vpnPrerequisiteCompatibilitySchema.optional(),
    authentication: authenticationPrerequisiteSchema,
    timeouts: z.object({
      connectSeconds: z.number().int().min(5).max(120),
      keepaliveSeconds: z.number().int().min(10).max(300),
      keepaliveMisses: z.number().int().min(1).max(10),
      idleSeconds: z.number().int().min(60).max(86_400),
    }).strict(),
  }).strict(),
])

export const declaredRootSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128),
  role: z.enum(['home', 'work', 'scratch', 'project', 'other']),
  label: nonEmptyTextSchema.max(256),
  path: executionTargetPathSchema,
}).strict()

/** Principal-owned durable target identity, without live connection state. */
export const machineSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: machineIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  accessProfileId: accessProfileIdSchema,
  name: nonEmptyTextSchema.max(256),
  declaredRoots: z.array(declaredRootSchema).max(64),
  preferredExecutionProviderId: executionProviderIdSchema.optional(),
  revision: revisionSchema,
  lifecycle: z.enum(['active', 'archived']),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  archivedAt: instantSchema.optional(),
}).strict().superRefine((machine, context) => {
  if ((machine.lifecycle === 'archived') !== (machine.archivedAt !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'archivedAt must exist exactly when the Machine is archived',
      path: ['archivedAt'],
    })
  }
  if (new Set(machine.declaredRoots.map(root => root.id)).size !== machine.declaredRoots.length) {
    context.addIssue({ code: 'custom', message: 'declared root ids must be unique', path: ['declaredRoots'] })
  }
})

export type AccessProfileDraft = z.output<typeof accessProfileDraftSchema>
export type AccessProfile = z.output<typeof accessProfileSchema>
export type Machine = z.output<typeof machineSchema>

export const MIN_APP_MANAGED_SSH_IDLE_SECONDS = 43_200

type SshAccessConfiguration = Pick<
  Extract<AccessProfileDraft, { readonly kind: 'ssh' }>,
  'controlOwnership' | 'timeouts'
>

/** Stored SSH intent and the runtime idle horizon that DSH-SLOP actually applies. */
export type EffectiveSshIdlePolicy =
  | Readonly<{
      kind: 'app-managed'
      configuredIdleSeconds: number
      minimumIdleSeconds: number
      effectiveIdleSeconds: number
    }>
  | Readonly<{
      kind: 'external'
      controlOwnership: 'adopt-user-master' | 'direct'
      configuredIdleSeconds: number
      effectiveIdleSeconds: number
    }>

/** Preserve the durable baseline while enforcing the product-owned master minimum. */
export function effectiveSshIdlePolicy(access: SshAccessConfiguration): EffectiveSshIdlePolicy {
  const configuredIdleSeconds = access.timeouts.idleSeconds
  if (access.controlOwnership === 'app-managed') {
    return {
      kind: 'app-managed',
      configuredIdleSeconds,
      minimumIdleSeconds: MIN_APP_MANAGED_SSH_IDLE_SECONDS,
      effectiveIdleSeconds: Math.max(configuredIdleSeconds, MIN_APP_MANAGED_SSH_IDLE_SECONDS),
    }
  }
  return {
    kind: 'external',
    controlOwnership: access.controlOwnership,
    configuredIdleSeconds,
    effectiveIdleSeconds: configuredIdleSeconds,
  }
}
