import { z } from 'zod'
import {
  type AuthorityMutation,
  type AuthorityRecord,
  LOCAL_OWNER_PRINCIPAL_ID,
  type RelationalAuthority,
} from './authority.ts'
import { canonicalSha256, createUuidV7, type JsonValue } from './canonical.ts'
import {
  accessProfileDraftSchema,
  accessProfileSchema,
  declaredRootSchema,
  MIN_APP_MANAGED_SSH_IDLE_SECONDS,
  machineSchema,
  type AccessProfile,
  type AccessProfileDraft,
  type Machine,
} from './domain/inventory.ts'
import { schemaVersionSchema } from './domain/common.ts'
import {
  accessProfileIdSchema,
  executionProviderIdSchema,
  machineIdSchema,
  nonEmptyTextSchema,
  remotePathSchema,
  revisionSchema,
  toInstant,
  type Instant,
  type Revision,
  type Sha256,
} from './primitives.ts'
import { jsonValueSchema } from './schemas.ts'

const MACHINE_DOMAIN = 'machine'
const ACCESS_PROFILE_DOMAIN = 'access-profile'
const idempotencyKeySchema = z.string().trim().min(1).max(512)

const setupSshTargetSchema = z.string().trim().max(512).refine(value => (
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value)
  || /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u.test(value)
), 'must be an SSH config alias or user@host')

const setupAuthenticationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requires-2fa') }).strict(),
  z.object({
    kind: z.literal('passwordless-key'),
    keyPath: nonEmptyTextSchema.max(4_096),
  }).strict(),
])

// A trailing directory separator is harmless setup input; other path validation
// remains canonical (in particular, do not resolve user-supplied .. segments).
const setupRootSchema = z.string().transform(value => value.length > 1 ? value.replace(/\/+$/u, '') || '/' : value).pipe(remotePathSchema)

/** Exact inventory input authorized by the accepted Setup Machine card. */
export const machineCreateRequestSchema = z.object({
  machineAlias: nonEmptyTextSchema.max(256).optional(),
  sshTarget: setupSshTargetSchema,
  authentication: setupAuthenticationSchema,
  scheduler: z.enum(['slurm', 'pbs', 'none', 'unknown']),
  paths: z.object({
    home: setupRootSchema.optional(),
    work: setupRootSchema.optional(),
    scratch: setupRootSchema.optional(),
  }).strict(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const machineBaseConfigurationSchema = z.object({
  name: nonEmptyTextSchema.max(256),
  access: accessProfileDraftSchema,
  declaredRoots: z.array(declaredRootSchema).max(64),
  preferredExecutionProviderId: executionProviderIdSchema.optional(),
}).strict()

export const machineListRequestSchema = z.object({
  includeArchived: z.boolean().optional(),
  search: z.string().trim().max(256).optional(),
}).strict()

export const machineGetRequestSchema = z.object({ machineId: machineIdSchema }).strict()

export const machineUpdateRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  machineId: machineIdSchema,
  expectedMachineRevision: revisionSchema,
  expectedAccessProfileRevision: revisionSchema,
  baseConfiguration: machineBaseConfigurationSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const machineArchiveRequestSchema = z.object({
  schemaVersion: schemaVersionSchema,
  machineId: machineIdSchema,
  expectedMachineRevision: revisionSchema,
  expectedAccessProfileRevision: revisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const machineInventoryRecordSchema = z.object({
  schemaVersion: schemaVersionSchema,
  machine: machineSchema,
  accessProfile: accessProfileSchema,
  normalizedConnectionIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const machineMutationResultSchema = z.object({
  schemaVersion: schemaVersionSchema,
  machine: machineSchema,
  accessProfile: accessProfileSchema,
}).strict()

export type MachineCreateRequest = z.output<typeof machineCreateRequestSchema>
export type MachineBaseConfiguration = z.output<typeof machineBaseConfigurationSchema>
export type MachineInventoryRecord = z.output<typeof machineInventoryRecordSchema>
export type MachineMutationResult = z.output<typeof machineMutationResultSchema>

export interface InventoryServiceOptions {
  readonly now?: () => Date
}

export class InventoryNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryNotFoundError'
  }
}

export class InventoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryConflictError'
  }
}

export class InventoryVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryVerificationError'
  }
}

interface StoredTarget {
  readonly machineRecord: AuthorityRecord
  readonly machine: Machine
  readonly accessProfileRecord: AuthorityRecord
  readonly accessProfile: AccessProfile
}

function asJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(value)
}

function accessDraft(profile: AccessProfile): AccessProfileDraft {
  if (profile.kind === 'local') return accessProfileDraftSchema.parse({ kind: 'local' })
  return accessProfileDraftSchema.parse({
    kind: 'ssh',
    target: profile.target,
    controlOwnership: profile.controlOwnership,
    trustPolicy: profile.trustPolicy,
    authentication: profile.authentication,
    timeouts: profile.timeouts,
  })
}

/** Digest for duplicate target detection, excluding credentials and record ids. */
export function normalizedConnectionIdentityDigest(input: unknown): Sha256 {
  const access = accessProfileDraftSchema.parse(input)
  if (access.kind === 'local') return canonicalSha256({ schemaVersion: 1, kind: 'local' })
  if (access.target.kind === 'config-alias') {
    return canonicalSha256({
      schemaVersion: 1,
      kind: 'ssh-config-alias',
      alias: access.target.alias.trim().toLocaleLowerCase('en-US'),
      controlOwnership: access.controlOwnership,
    })
  }
  return canonicalSha256({
    schemaVersion: 1,
    kind: 'ssh-endpoint',
    host: access.target.host.trim().toLocaleLowerCase('en-US'),
    user: access.target.user?.trim() ?? null,
    port: access.target.port,
    controlOwnership: access.controlOwnership,
  })
}

function assertRootKinds(configuration: MachineBaseConfiguration): void {
  const expectedKind = configuration.access.kind === 'local' ? 'local' : 'remote'
  if (configuration.declaredRoots.some(root => root.path.kind !== expectedKind)) {
    throw new InventoryVerificationError(`Declared roots for this AccessProfile must use '${expectedKind}' paths.`)
  }
}

function accessDraftForSetup(request: MachineCreateRequest): AccessProfileDraft {
  const separator = request.sshTarget.indexOf('@')
  const target = separator < 0
    ? { kind: 'config-alias' as const, alias: request.sshTarget }
    : {
        kind: 'endpoint' as const,
        user: request.sshTarget.slice(0, separator),
        host: request.sshTarget.slice(separator + 1),
        port: 22,
      }
  return accessProfileDraftSchema.parse({
    kind: 'ssh',
    target,
    controlOwnership: 'app-managed',
    trustPolicy: { kind: 'user-known-hosts' },
    authentication: request.authentication.kind === 'requires-2fa'
      ? { kind: 'interactive' }
      : { kind: 'ssh-agent', localKeyFilePath: request.authentication.keyPath },
    timeouts: {
      connectSeconds: 30,
      keepaliveSeconds: 30,
      keepaliveMisses: 3,
      idleSeconds: MIN_APP_MANAGED_SSH_IDLE_SECONDS,
    },
  })
}

function declaredRootsForSetup(paths: MachineCreateRequest['paths']): Machine['declaredRoots'] {
  const roots: Machine['declaredRoots'][number][] = []
  for (const role of ['home', 'work', 'scratch'] as const) {
    const path = paths[role]
    if (path !== undefined) roots.push({ id: role, role, label: role, path: { kind: 'remote', path } })
  }
  return roots
}

function preferredProviderForSetup(scheduler: MachineCreateRequest['scheduler']): Machine['preferredExecutionProviderId'] {
  switch (scheduler) {
    case 'slurm': return executionProviderIdSchema.parse('slurm')
    case 'pbs': return executionProviderIdSchema.parse('pbs')
    case 'none': return executionProviderIdSchema.parse('direct')
    case 'unknown': return undefined
    default: {
      const exhaustive: never = scheduler
      return exhaustive
    }
  }
}

/** Authority-backed owner-scoped Machine and AccessProfile mutations. */
export class InventoryService {
  private readonly now: () => Date

  constructor(
    private readonly authority: RelationalAuthority,
    options: InventoryServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  listMachines(input: unknown = {}): readonly MachineInventoryRecord[] {
    const request = machineListRequestSchema.parse(input)
    const search = request.search?.toLocaleLowerCase('en-US')
    return this.authority.list(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_DOMAIN, 500)
      .map(record => this.targetFromMachineRecord(record))
      .filter(target => request.includeArchived === true || target.machine.lifecycle !== 'archived')
      .filter(target => search === undefined || target.machine.name.toLocaleLowerCase('en-US').includes(search))
      .map(target => machineInventoryRecordSchema.parse({
        schemaVersion: 1,
        machine: target.machine,
        accessProfile: target.accessProfile,
        normalizedConnectionIdentityDigest: normalizedConnectionIdentityDigest(accessDraft(target.accessProfile)),
      }))
  }

  createMachine(input: unknown): MachineInventoryRecord {
    const request = machineCreateRequestSchema.parse(input)
    const requestJson = asJson(request)
    const replay = this.authority.idempotencyResult({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      scope: 'inventory-machine-create',
      key: request.idempotencyKey,
      request: requestJson,
    })
    if (replay !== undefined) return machineInventoryRecordSchema.parse(replay)

    const access = accessDraftForSetup(request)
    this.assertConnectionIdentityAvailable(access)
    const now = this.currentInstant()
    const accessProfile = accessProfileSchema.parse({
      ...access,
      schemaVersion: 1,
      id: accessProfileIdSchema.parse(createUuidV7()),
      ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    const preferredExecutionProviderId = preferredProviderForSetup(request.scheduler)
    const machine = machineSchema.parse({
      schemaVersion: 1,
      id: machineIdSchema.parse(createUuidV7()),
      ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
      accessProfileId: accessProfile.id,
      name: request.machineAlias ?? request.sshTarget,
      declaredRoots: declaredRootsForSetup(request.paths),
      ...(preferredExecutionProviderId === undefined ? {} : { preferredExecutionProviderId }),
      revision: 1,
      lifecycle: 'active',
      createdAt: now,
      updatedAt: now,
    })
    const result = machineInventoryRecordSchema.parse({
      schemaVersion: 1,
      machine,
      accessProfile,
      normalizedConnectionIdentityDigest: normalizedConnectionIdentityDigest(access),
    })
    const transaction = this.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [
        { kind: 'insert', domain: ACCESS_PROFILE_DOMAIN, id: accessProfile.id, value: asJson(accessProfile) },
        { kind: 'insert', domain: MACHINE_DOMAIN, id: machine.id, value: asJson(machine) },
      ],
      audit: [{
        kind: 'inventory.machine-created',
        subjectDomain: MACHINE_DOMAIN,
        subjectId: machine.id,
        details: {
          accessProfileId: accessProfile.id,
          connectionIdentityDigest: result.normalizedConnectionIdentityDigest,
          scheduler: request.scheduler,
        },
      }],
      idempotency: {
        scope: 'inventory-machine-create',
        key: request.idempotencyKey,
        request: requestJson,
        result: asJson(result),
      },
    })
    return transaction.kind === 'replayed' ? machineInventoryRecordSchema.parse(transaction.result) : result
  }

  getMachine(input: unknown): MachineInventoryRecord {
    const request = machineGetRequestSchema.parse(input)
    const target = this.loadTarget(request.machineId)
    return machineInventoryRecordSchema.parse({
      schemaVersion: 1,
      machine: target.machine,
      accessProfile: target.accessProfile,
      normalizedConnectionIdentityDigest: normalizedConnectionIdentityDigest(accessDraft(target.accessProfile)),
    })
  }

  updateMachine(input: unknown): MachineMutationResult {
    const request = machineUpdateRequestSchema.parse(input)
    const replay = this.authority.idempotencyResult({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      scope: 'inventory-machine-update',
      key: request.idempotencyKey,
      request: asJson(request),
    })
    if (replay !== undefined) return machineMutationResultSchema.parse(replay)
    assertRootKinds(request.baseConfiguration)
    const target = this.loadTarget(
      request.machineId,
      request.expectedMachineRevision,
      request.expectedAccessProfileRevision,
    )
    if (target.machine.lifecycle !== 'active') throw new InventoryConflictError('Archived Machines cannot be updated.')
    this.assertConnectionIdentityAvailable(request.baseConfiguration.access, target.machine.id)

    const now = this.currentInstant()
    const accessChanged = canonicalSha256(accessDraft(target.accessProfile)) !== canonicalSha256(request.baseConfiguration.access)
    const accessProfile = accessChanged
      ? accessProfileSchema.parse({
          ...request.baseConfiguration.access,
          schemaVersion: 1,
          id: target.accessProfile.id,
          ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
          revision: target.accessProfile.revision + 1,
          createdAt: target.accessProfile.createdAt,
          updatedAt: now,
        })
      : target.accessProfile
    const machine = machineSchema.parse({
      schemaVersion: 1,
      id: target.machine.id,
      ownerPrincipalId: target.machine.ownerPrincipalId,
      accessProfileId: target.machine.accessProfileId,
      name: request.baseConfiguration.name,
      declaredRoots: request.baseConfiguration.declaredRoots,
      ...(request.baseConfiguration.preferredExecutionProviderId === undefined
        ? {}
        : { preferredExecutionProviderId: request.baseConfiguration.preferredExecutionProviderId }),
      revision: target.machine.revision + 1,
      lifecycle: target.machine.lifecycle,
      createdAt: target.machine.createdAt,
      updatedAt: now,
    })
    const result = machineMutationResultSchema.parse({ schemaVersion: 1, machine, accessProfile })
    const accessMutations: readonly AuthorityMutation[] = accessChanged
      ? [{
          kind: 'replace',
          domain: ACCESS_PROFILE_DOMAIN,
          id: accessProfile.id,
          expectedRevision: target.accessProfileRecord.revision,
          value: asJson(accessProfile),
        }]
      : []
    const transaction = this.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [
        ...accessMutations,
        {
          kind: 'replace',
          domain: MACHINE_DOMAIN,
          id: machine.id,
          expectedRevision: target.machineRecord.revision,
          value: asJson(machine),
        },
      ],
      audit: [{
        kind: 'inventory.machine-updated',
        subjectDomain: MACHINE_DOMAIN,
        subjectId: machine.id,
        details: {
          machineRevision: machine.revision,
          accessProfileRevision: accessProfile.revision,
          accessChanged,
        },
      }],
      idempotency: {
        scope: 'inventory-machine-update',
        key: request.idempotencyKey,
        request: asJson(request),
        result: asJson(result),
      },
    })
    return transaction.kind === 'replayed' ? machineMutationResultSchema.parse(transaction.result) : result
  }

  archiveMachine(input: unknown): MachineMutationResult {
    const request = machineArchiveRequestSchema.parse(input)
    const replay = this.authority.idempotencyResult({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      scope: 'inventory-machine-archive',
      key: request.idempotencyKey,
      request: asJson(request),
    })
    if (replay !== undefined) return machineMutationResultSchema.parse(replay)
    const target = this.loadTarget(
      request.machineId,
      request.expectedMachineRevision,
      request.expectedAccessProfileRevision,
    )
    if (target.machine.lifecycle !== 'active') throw new InventoryConflictError('Machine is already archived.')
    const now = this.currentInstant()
    const machine = machineSchema.parse({
      ...target.machine,
      lifecycle: 'archived',
      archivedAt: now,
      revision: target.machine.revision + 1,
      updatedAt: now,
    })
    const result = machineMutationResultSchema.parse({
      schemaVersion: 1,
      machine,
      accessProfile: target.accessProfile,
    })
    const transaction = this.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{
        kind: 'replace',
        domain: MACHINE_DOMAIN,
        id: machine.id,
        expectedRevision: target.machineRecord.revision,
        value: asJson(machine),
      }],
      audit: [{
        kind: 'inventory.machine-archived',
        subjectDomain: MACHINE_DOMAIN,
        subjectId: machine.id,
        details: { machineRevision: machine.revision },
      }],
      idempotency: {
        scope: 'inventory-machine-archive',
        key: request.idempotencyKey,
        request: asJson(request),
        result: asJson(result),
      },
    })
    return transaction.kind === 'replayed' ? machineMutationResultSchema.parse(transaction.result) : result
  }

  private currentInstant(): Instant {
    const now = this.now()
    if (Number.isNaN(now.getTime())) throw new InventoryConflictError('Inventory clock returned an invalid date.')
    return toInstant(new Date(now.getTime()))
  }

  private targetFromMachineRecord(record: AuthorityRecord): StoredTarget {
    const machine = machineSchema.parse(record.value)
    if (machine.id !== record.id || machine.ownerPrincipalId !== record.ownerPrincipalId || machine.revision !== record.revision) {
      throw new InventoryConflictError('Machine authority record is internally inconsistent.')
    }
    const accessProfileRecord = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, ACCESS_PROFILE_DOMAIN, machine.accessProfileId)
    if (accessProfileRecord === undefined) throw new InventoryNotFoundError(`AccessProfile '${machine.accessProfileId}' does not exist.`)
    const accessProfile = accessProfileSchema.parse(accessProfileRecord.value)
    if (accessProfile.id !== accessProfileRecord.id
      || accessProfile.ownerPrincipalId !== machine.ownerPrincipalId
      || accessProfile.revision !== accessProfileRecord.revision) {
      throw new InventoryConflictError('AccessProfile authority record is internally inconsistent.')
    }
    return { machineRecord: record, machine, accessProfileRecord, accessProfile }
  }

  private loadTarget(
    machineId: string,
    expectedMachineRevision?: Revision,
    expectedAccessProfileRevision?: Revision,
  ): StoredTarget {
    const id = machineIdSchema.parse(machineId)
    const record = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_DOMAIN, id)
    if (record === undefined) throw new InventoryNotFoundError(`Machine '${id}' does not exist.`)
    const target = this.targetFromMachineRecord(record)
    if (expectedMachineRevision !== undefined && target.machine.revision !== expectedMachineRevision) {
      throw new InventoryConflictError('Machine revision changed.')
    }
    if (expectedAccessProfileRevision !== undefined && target.accessProfile.revision !== expectedAccessProfileRevision) {
      throw new InventoryConflictError('AccessProfile revision changed.')
    }
    return target
  }

  private assertConnectionIdentityAvailable(access: AccessProfileDraft, currentMachineId?: Machine['id']): void {
    const requestedDigest = normalizedConnectionIdentityDigest(access)
    for (const record of this.authority.list(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_DOMAIN, 500)) {
      const target = this.targetFromMachineRecord(record)
      if (target.machine.id === currentMachineId || target.machine.lifecycle === 'archived') continue
      if (normalizedConnectionIdentityDigest(accessDraft(target.accessProfile)) === requestedDigest) {
        throw new InventoryConflictError(`Machine '${target.machine.id}' already owns this normalized connection identity.`)
      }
    }
  }
}
