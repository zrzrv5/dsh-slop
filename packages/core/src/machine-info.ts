import { z } from 'zod'
import { canonicalSha256 } from './canonical.ts'
import {
  approvalReceiptIdSchema,
  instantSchema,
  machineIdSchema,
  nonEmptyTextSchema,
  productIdSchema,
  revisionSchema,
  sha256Schema,
} from './primitives.ts'
import { schemaVersionSchema } from './domain/common.ts'
import { localOwnerPrincipalIdSchema } from './domain/inventory.ts'

export const machineInfoUpdateIdSchema = productIdSchema('MachineInfoUpdateId')
const optionalOperationalTextSchema = nonEmptyTextSchema.max(4_096).optional()

export const machineInfoAuthenticationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requires-2fa') }).strict(),
  z.object({
    kind: z.literal('passwordless-key'),
    localKeyFilePath: nonEmptyTextSchema.max(4_096),
  }).strict(),
])

export const machineInfoSchedulerSchema = z.enum(['slurm', 'pbs', 'none', 'unknown'])

export const machineInfoSetupSchema = z.object({
  machineAlias: nonEmptyTextSchema.max(256).optional(),
  sshTarget: nonEmptyTextSchema.max(512),
  authentication: machineInfoAuthenticationSchema,
  scheduler: machineInfoSchedulerSchema,
  paths: z.object({
    home: optionalOperationalTextSchema,
    work: optionalOperationalTextSchema,
    scratch: optionalOperationalTextSchema,
  }).strict(),
  discoveryProfile: z.enum(['ordinary', 'deep']),
}).strict()

export const machineInfoOperatingDefaultsSchema = z.object({
  account: nonEmptyTextSchema.max(256).optional(),
  allocation: nonEmptyTextSchema.max(256).optional(),
  partition: nonEmptyTextSchema.max(256).optional(),
  queue: nonEmptyTextSchema.max(256).optional(),
}).strict()

export const machineInfoDiscoverySectionKindSchema = z.enum([
  'scheduler',
  'paths',
  'accounts',
  'software',
  'environment',
  'workflow',
  'other',
])

export const machineInfoDiscoverySectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128),
  kind: machineInfoDiscoverySectionKindSchema,
  title: nonEmptyTextSchema.max(256),
  content: nonEmptyTextSchema.max(65_536),
}).strict()

export const approvedMachineDiscoverySchema = z.object({
  summary: nonEmptyTextSchema.max(16_384),
  operatingDefaults: machineInfoOperatingDefaultsSchema,
  sections: z.array(machineInfoDiscoverySectionSchema).max(128),
}).strict().superRefine((discovery, context) => {
  const ids = new Set(discovery.sections.map(section => section.id))
  if (ids.size !== discovery.sections.length) {
    context.addIssue({ code: 'custom', message: 'discovery section ids must be unique', path: ['sections'] })
  }
})

export const machineInfoCandidateSchema = z.object({
  schemaVersion: schemaVersionSchema,
  machineId: machineIdSchema,
  setup: machineInfoSetupSchema,
  customNotes: z.string().max(65_536),
  approvedDiscovery: approvedMachineDiscoverySchema,
}).strict()

const explicitMachineInfoApprovalSchema = z.object({
  kind: z.literal('explicit-user-approval'),
  receiptId: approvalReceiptIdSchema,
  effectDigest: sha256Schema,
  approvedAt: instantSchema,
}).strict()

export const machineInfoSchema = machineInfoCandidateSchema.extend({
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  revision: revisionSchema,
  initialApproval: explicitMachineInfoApprovalSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
}).strict()

const discoveryCorrectionFields = {
  sectionId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(128),
  evidence: nonEmptyTextSchema.max(4_096),
}

export const machineInfoChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set-machine-alias'), machineAlias: nonEmptyTextSchema.max(256).optional() }).strict(),
  z.object({ kind: z.literal('append-custom-notes'), addition: nonEmptyTextSchema.max(16_384) }).strict(),
  z.object({ kind: z.literal('add-discovery-section'), section: machineInfoDiscoverySectionSchema }).strict(),
  z.object({
    kind: z.literal('correct-stale-discovery-section'),
    ...discoveryCorrectionFields,
    replacement: machineInfoDiscoverySectionSchema.omit({ id: true }),
  }).strict(),
  z.object({ kind: z.literal('remove-stale-discovery-section'), ...discoveryCorrectionFields }).strict(),
  z.object({ kind: z.literal('set-ssh-target'), sshTarget: nonEmptyTextSchema.max(512) }).strict(),
  z.object({ kind: z.literal('set-authentication'), authentication: machineInfoAuthenticationSchema }).strict(),
  z.object({ kind: z.literal('set-scheduler'), scheduler: machineInfoSchedulerSchema }).strict(),
  z.object({
    kind: z.literal('set-execution-path'),
    role: z.enum(['home', 'work', 'scratch']),
    path: optionalOperationalTextSchema,
  }).strict(),
  z.object({
    kind: z.literal('set-operating-default'),
    field: z.enum(['account', 'allocation', 'partition', 'queue']),
    value: nonEmptyTextSchema.max(256).optional(),
  }).strict(),
  z.object({ kind: z.literal('replace-custom-notes'), customNotes: z.string().max(65_536) }).strict(),
  z.object({ kind: z.literal('replace-approved-discovery'), approvedDiscovery: approvedMachineDiscoverySchema }).strict(),
])

function changeTarget(change: MachineInfoChange): string {
  switch (change.kind) {
    case 'set-machine-alias': return 'setup:machine-alias'
    case 'append-custom-notes':
    case 'replace-custom-notes': return 'custom-notes'
    case 'add-discovery-section': return `discovery:${change.section.id}`
    case 'correct-stale-discovery-section':
    case 'remove-stale-discovery-section': return `discovery:${change.sectionId}`
    case 'set-ssh-target': return 'setup:ssh-target'
    case 'set-authentication': return 'setup:authentication'
    case 'set-scheduler': return 'setup:scheduler'
    case 'set-execution-path': return `setup:path:${change.role}`
    case 'set-operating-default': return `discovery:default:${change.field}`
    case 'replace-approved-discovery': return 'discovery:all'
    default: {
      const _exhaustive: never = change
      return _exhaustive
    }
  }
}

export const machineInfoChangesSchema = z.array(machineInfoChangeSchema).min(1).max(64)
  .superRefine((changes, context) => {
    const targets = changes.map(changeTarget)
    if (new Set(targets).size !== targets.length) {
      context.addIssue({ code: 'custom', message: 'one update cannot change the same Machine Info target twice' })
    }
    if (targets.includes('discovery:all') && targets.some(target => target.startsWith('discovery:') && target !== 'discovery:all')) {
      context.addIssue({ code: 'custom', message: 'a full discovery replacement cannot be combined with narrower discovery changes' })
    }
  })

export const machineInfoMaterialitySchema = z.enum(['small', 'material'])

const noPriorApprovalSchema = z.object({ kind: z.literal('not-required') }).strict()

export const machineInfoUpdateRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  id: machineInfoUpdateIdSchema,
  ownerPrincipalId: localOwnerPrincipalIdSchema,
  machineId: machineIdSchema,
  fromRevision: revisionSchema,
  toRevision: revisionSchema,
  materiality: machineInfoMaterialitySchema,
  explanation: nonEmptyTextSchema.max(8_192),
  changes: machineInfoChangesSchema,
  approval: z.discriminatedUnion('kind', [noPriorApprovalSchema, explicitMachineInfoApprovalSchema]),
  revision: z.literal(1),
  createdAt: instantSchema,
}).strict().superRefine((record, context) => {
  if (record.toRevision !== record.fromRevision + 1) {
    context.addIssue({ code: 'custom', message: 'Machine Info update revisions must be consecutive', path: ['toRevision'] })
  }
  if ((record.materiality === 'material') !== (record.approval.kind === 'explicit-user-approval')) {
    context.addIssue({ code: 'custom', message: 'material updates require explicit approval and small updates do not', path: ['approval'] })
  }
  if (record.materiality !== machineInfoChangeMateriality(record.changes)) {
    context.addIssue({ code: 'custom', message: 'update materiality must match its typed changes', path: ['materiality'] })
  }
})

export const machineInfoCardInstructionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('emit-new-card'), reason: z.enum(['initial-save', 'material-update']) }).strict(),
  z.object({ kind: z.literal('card-not-required'), reason: z.literal('small-update') }).strict(),
])

const writePathSchema = nonEmptyTextSchema.max(4_096).refine(
  path => path.startsWith('/') && !path.includes('\r') && !path.includes('\n') && !path.includes('\0'),
  'Resolve an absolute, single-line remote path before saving Machine Info.',
)

// Persisted historical records remain readable. Only new path writes are strict.
const writableCandidateSchema = machineInfoCandidateSchema.superRefine((candidate, context) => {
  for (const [role, path] of Object.entries(candidate.setup.paths)) {
    if (path !== undefined && !writePathSchema.safeParse(path).success) context.addIssue({ code: 'custom', path: ['setup', 'paths', role], message: 'Resolve an absolute remote path before saving Machine Info.' })
  }
})

export const initialMachineInfoSaveRequestSchema = z.object({
  candidate: writableCandidateSchema,
  approvalReceiptId: approvalReceiptIdSchema,
  idempotencyKey: nonEmptyTextSchema.max(512),
}).strict()

export const initialMachineInfoSaveResultSchema = z.object({
  machineInfo: machineInfoSchema,
  card: machineInfoCardInstructionSchema,
}).strict().superRefine((result, context) => {
  if (result.card.kind !== 'emit-new-card' || result.card.reason !== 'initial-save') {
    context.addIssue({ code: 'custom', message: 'an initial save must emit a new Machine Info card', path: ['card'] })
  }
})

export const machineInfoUpdateRequestSchema = z.object({
  machineId: machineIdSchema,
  expectedRevision: revisionSchema,
  explanation: nonEmptyTextSchema.max(8_192),
  changes: machineInfoChangesSchema.superRefine((changes, context) => {
    changes.forEach((change, index) => {
      if (change.kind === 'set-execution-path' && change.path !== undefined && !writePathSchema.safeParse(change.path).success) context.addIssue({ code: 'custom', path: [index, 'path'], message: 'Resolve an absolute remote path before saving Machine Info.' })
    })
  }),
  approvalReceiptId: approvalReceiptIdSchema.optional(),
  idempotencyKey: nonEmptyTextSchema.max(512),
}).strict()

export const machineInfoUpdateResultSchema = z.object({
  machineInfo: machineInfoSchema,
  update: machineInfoUpdateRecordSchema,
  card: machineInfoCardInstructionSchema,
}).strict().superRefine((result, context) => {
  if (result.update.materiality === 'material') {
    if (result.card.kind !== 'emit-new-card' || result.card.reason !== 'material-update') {
      context.addIssue({ code: 'custom', message: 'a material update must emit a new Machine Info card', path: ['card'] })
    }
  } else if (result.card.kind !== 'card-not-required') {
    context.addIssue({ code: 'custom', message: 'a small update does not require a new Machine Info card', path: ['card'] })
  }
})

export type MachineInfoAuthentication = z.output<typeof machineInfoAuthenticationSchema>
export type MachineInfoSetup = z.output<typeof machineInfoSetupSchema>
export type ApprovedMachineDiscovery = z.output<typeof approvedMachineDiscoverySchema>
export type MachineInfoCandidate = z.output<typeof machineInfoCandidateSchema>
export type MachineInfo = z.output<typeof machineInfoSchema>
export type MachineInfoChange = z.output<typeof machineInfoChangeSchema>
export type MachineInfoMateriality = z.output<typeof machineInfoMaterialitySchema>
export type MachineInfoUpdateRecord = z.output<typeof machineInfoUpdateRecordSchema>
export type InitialMachineInfoSaveRequest = z.output<typeof initialMachineInfoSaveRequestSchema>
export type InitialMachineInfoSaveResult = z.output<typeof initialMachineInfoSaveResultSchema>
export type MachineInfoUpdateRequest = z.output<typeof machineInfoUpdateRequestSchema>
export type MachineInfoUpdateResult = z.output<typeof machineInfoUpdateResultSchema>

/** Returns the approval digest for the exact reviewed initial Machine Info candidate. */
export function initialMachineInfoApprovalDigest(candidateInput: unknown): z.output<typeof sha256Schema> {
  const candidate = machineInfoCandidateSchema.parse(candidateInput)
  return canonicalSha256({ schemaVersion: 1, kind: 'machine-info-initial-save', candidate })
}

/** Classifies a typed update from its actual operations. Any material operation makes the whole update material. */
export function machineInfoChangeMateriality(changesInput: unknown): MachineInfoMateriality {
  const changes = machineInfoChangesSchema.parse(changesInput)
  for (const change of changes) {
    switch (change.kind) {
      case 'set-machine-alias':
      case 'append-custom-notes':
      case 'add-discovery-section':
      case 'correct-stale-discovery-section':
      case 'remove-stale-discovery-section':
        break
      case 'set-ssh-target':
      case 'set-authentication':
      case 'set-scheduler':
      case 'set-execution-path':
      case 'set-operating-default':
      case 'replace-custom-notes':
      case 'replace-approved-discovery':
        return 'material'
      default: {
        const _exhaustive: never = change
        return _exhaustive
      }
    }
  }
  return 'small'
}

/** Returns the approval digest for one exact material update against one current revision. */
export function machineInfoUpdateApprovalDigest(input: Pick<MachineInfoUpdateRequest, 'machineId' | 'expectedRevision' | 'explanation' | 'changes'>): z.output<typeof sha256Schema> {
  const request = machineInfoUpdateRequestSchema.omit({ approvalReceiptId: true, idempotencyKey: true }).parse({
    machineId: input.machineId,
    expectedRevision: input.expectedRevision,
    explanation: input.explanation,
    changes: input.changes,
  })
  return canonicalSha256({ schemaVersion: 1, kind: 'machine-info-material-update', request })
}

/** Applies typed changes without permitting unlisted fields to drift. */
export function applyMachineInfoChanges(currentInput: unknown, changesInput: unknown): MachineInfoCandidate {
  const current = machineInfoSchema.parse(currentInput)
  const changes = machineInfoChangesSchema.parse(changesInput)
  let setup = current.setup
  let customNotes = current.customNotes
  let approvedDiscovery = current.approvedDiscovery

  for (const change of changes) {
    switch (change.kind) {
      case 'set-machine-alias':
        setup = machineInfoSetupSchema.parse({ ...setup, machineAlias: change.machineAlias })
        break
      case 'append-custom-notes':
        customNotes = customNotes.length === 0 ? change.addition : `${customNotes}\n${change.addition}`
        break
      case 'add-discovery-section': {
        if (approvedDiscovery.sections.some(section => section.id === change.section.id)) {
          throw new TypeError(`Discovery section '${change.section.id}' already exists.`)
        }
        approvedDiscovery = approvedMachineDiscoverySchema.parse({
          ...approvedDiscovery,
          sections: [...approvedDiscovery.sections, change.section],
        })
        break
      }
      case 'correct-stale-discovery-section': {
        if (!approvedDiscovery.sections.some(section => section.id === change.sectionId)) {
          throw new TypeError(`Discovery section '${change.sectionId}' does not exist.`)
        }
        approvedDiscovery = approvedMachineDiscoverySchema.parse({
          ...approvedDiscovery,
          sections: approvedDiscovery.sections.map(section => section.id === change.sectionId
            ? { id: change.sectionId, ...change.replacement }
            : section),
        })
        break
      }
      case 'remove-stale-discovery-section':
        if (!approvedDiscovery.sections.some(section => section.id === change.sectionId)) {
          throw new TypeError(`Discovery section '${change.sectionId}' does not exist.`)
        }
        approvedDiscovery = approvedMachineDiscoverySchema.parse({
          ...approvedDiscovery,
          sections: approvedDiscovery.sections.filter(section => section.id !== change.sectionId),
        })
        break
      case 'set-ssh-target':
        setup = machineInfoSetupSchema.parse({ ...setup, sshTarget: change.sshTarget })
        break
      case 'set-authentication':
        setup = machineInfoSetupSchema.parse({ ...setup, authentication: change.authentication })
        break
      case 'set-scheduler':
        setup = machineInfoSetupSchema.parse({ ...setup, scheduler: change.scheduler })
        break
      case 'set-execution-path':
        setup = machineInfoSetupSchema.parse({ ...setup, paths: { ...setup.paths, [change.role]: change.path } })
        break
      case 'set-operating-default':
        approvedDiscovery = approvedMachineDiscoverySchema.parse({
          ...approvedDiscovery,
          operatingDefaults: { ...approvedDiscovery.operatingDefaults, [change.field]: change.value },
        })
        break
      case 'replace-custom-notes':
        customNotes = change.customNotes
        break
      case 'replace-approved-discovery':
        approvedDiscovery = change.approvedDiscovery
        break
      default: {
        const _exhaustive: never = change
        return _exhaustive
      }
    }
  }

  return machineInfoCandidateSchema.parse({
    schemaVersion: 1,
    machineId: current.machineId,
    setup,
    customNotes,
    approvedDiscovery,
  })
}
