import { createUuidV7, type JsonValue } from './canonical.ts'
import {
  LOCAL_OWNER_PRINCIPAL_ID,
  type ApprovalReceiptRecord,
  type AuthorityRecord,
  type RelationalAuthority,
} from './authority.ts'
import { machineSchema } from './domain/inventory.ts'
import {
  applyMachineInfoChanges,
  initialMachineInfoApprovalDigest,
  initialMachineInfoSaveRequestSchema,
  initialMachineInfoSaveResultSchema,
  machineInfoChangeMateriality,
  machineInfoSchema,
  machineInfoUpdateApprovalDigest,
  machineInfoUpdateIdSchema,
  machineInfoUpdateRecordSchema,
  machineInfoUpdateRequestSchema,
  machineInfoUpdateResultSchema,
  type InitialMachineInfoSaveResult,
  type MachineInfo,
  type MachineInfoUpdateRecord,
  type MachineInfoUpdateResult,
} from './machine-info.ts'
import { machineIdSchema, toInstant, type Instant, type Sha256 } from './primitives.ts'
import { jsonValueSchema } from './schemas.ts'

const MACHINE_DOMAIN = 'machine'
const MACHINE_INFO_DOMAIN = 'machine-info'
const MACHINE_INFO_UPDATE_DOMAIN = 'machine-info-update'

const initialMachineInfoIdempotencyRequestSchema = initialMachineInfoSaveRequestSchema.omit({ approvalReceiptId: true })
const machineInfoUpdateIdempotencyRequestSchema = machineInfoUpdateRequestSchema.omit({ approvalReceiptId: true })

export class MachineInfoNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachineInfoNotFoundError'
  }
}

export class MachineInfoConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachineInfoConflictError'
  }
}

export class MachineInfoApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MachineInfoApprovalRequiredError'
  }
}

function asJson(value: unknown): JsonValue {
  return jsonValueSchema.parse(value)
}

export interface MachineInfoServiceOptions {
  readonly now?: () => Date
}

/** Stores one current Machine Info context in the product's existing relational authority. */
export class MachineInfoService {
  private readonly now: () => Date

  constructor(
    private readonly authority: RelationalAuthority,
    options: MachineInfoServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date())
  }

  get(input: unknown): MachineInfo | undefined {
    const machineId = machineIdSchema.parse(input)
    const record = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_INFO_DOMAIN, machineId)
    return record === undefined ? undefined : this.infoFromRecord(record)
  }

  require(input: unknown): MachineInfo {
    const machineId = machineIdSchema.parse(input)
    const machineInfo = this.get(machineId)
    if (machineInfo === undefined) throw new MachineInfoNotFoundError(`Machine Info for '${machineId}' does not exist.`)
    return machineInfo
  }

  /** Future Agents consume this saved context directly. They never read the rendered card. */
  contextForAgent(input: unknown): MachineInfo {
    return this.require(input)
  }

  listUpdates(input: unknown): readonly MachineInfoUpdateRecord[] {
    const machineId = machineIdSchema.parse(input)
    return this.authority.list(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_INFO_UPDATE_DOMAIN, 500)
      .map(record => machineInfoUpdateRecordSchema.parse(record.value))
      .filter(update => update.machineId === machineId)
      .sort((left, right) => left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt))
  }

  replayInitial(input: unknown): InitialMachineInfoSaveResult | undefined {
    const request = initialMachineInfoIdempotencyRequestSchema.parse(input)
    const replay = this.authority.idempotencyResult({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      scope: 'machine-info-initial-save',
      key: request.idempotencyKey,
      request: asJson(request),
    })
    return replay === undefined ? undefined : initialMachineInfoSaveResultSchema.parse(replay)
  }

  replayUpdate(input: unknown): MachineInfoUpdateResult | undefined {
    const request = machineInfoUpdateIdempotencyRequestSchema.parse(input)
    const replay = this.authority.idempotencyResult({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      scope: 'machine-info-update',
      key: request.idempotencyKey,
      request: asJson(request),
    })
    return replay === undefined ? undefined : machineInfoUpdateResultSchema.parse(replay)
  }

  saveInitial(input: unknown): InitialMachineInfoSaveResult {
    const request = initialMachineInfoSaveRequestSchema.parse(input)
    const idempotencyRequest = initialMachineInfoIdempotencyRequestSchema.parse({
      candidate: request.candidate,
      idempotencyKey: request.idempotencyKey,
    })
    const replay = this.replayInitial(idempotencyRequest)
    if (replay !== undefined) return replay

    this.assertActiveMachine(request.candidate.machineId)
    if (this.get(request.candidate.machineId) !== undefined) {
      throw new MachineInfoConflictError(`Machine Info for '${request.candidate.machineId}' already exists.`)
    }

    const effectDigest = initialMachineInfoApprovalDigest(request.candidate)
    const approval = this.requireApproval(request.approvalReceiptId, effectDigest)
    const now = this.currentInstant()
    const machineInfo = machineInfoSchema.parse({
      ...request.candidate,
      ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
      revision: 1,
      initialApproval: this.explicitApproval(approval),
      createdAt: now,
      updatedAt: now,
    })
    const result = initialMachineInfoSaveResultSchema.parse({
      machineInfo,
      card: { kind: 'emit-new-card', reason: 'initial-save' },
    })

    const transaction = this.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [{ kind: 'insert', domain: MACHINE_INFO_DOMAIN, id: machineInfo.machineId, value: asJson(machineInfo) }],
      approval: { receiptId: approval.id, effectDigest },
      audit: [{
        kind: 'machine-info.initial-saved',
        subjectDomain: MACHINE_INFO_DOMAIN,
        subjectId: machineInfo.machineId,
        details: { approvalReceiptId: approval.id, effectDigest, revision: machineInfo.revision },
      }],
      idempotency: {
        scope: 'machine-info-initial-save',
        key: request.idempotencyKey,
        request: asJson(idempotencyRequest),
        result: asJson(result),
      },
    })
    return transaction.kind === 'replayed' ? initialMachineInfoSaveResultSchema.parse(transaction.result) : result
  }

  update(input: unknown): MachineInfoUpdateResult {
    const request = machineInfoUpdateRequestSchema.parse(input)
    const idempotencyRequest = machineInfoUpdateIdempotencyRequestSchema.parse({
      machineId: request.machineId,
      expectedRevision: request.expectedRevision,
      explanation: request.explanation,
      changes: request.changes,
      idempotencyKey: request.idempotencyKey,
    })
    const replay = this.replayUpdate(idempotencyRequest)
    if (replay !== undefined) return replay

    this.assertActiveMachine(request.machineId)
    const record = this.requireRecord(request.machineId)
    const current = this.infoFromRecord(record)
    if (current.revision !== request.expectedRevision) {
      throw new MachineInfoConflictError(`Machine Info revision ${request.expectedRevision} is stale; current revision is ${current.revision}.`)
    }

    const materiality = machineInfoChangeMateriality(request.changes)
    const effectDigest = machineInfoUpdateApprovalDigest(request)
    let approval: ApprovalReceiptRecord | undefined
    if (materiality === 'material') {
      if (request.approvalReceiptId === undefined) {
        throw new MachineInfoApprovalRequiredError('Material Machine Info updates require explicit user approval before persistence.')
      }
      approval = this.requireApproval(request.approvalReceiptId, effectDigest)
    } else if (request.approvalReceiptId !== undefined) {
      throw new MachineInfoConflictError('Small Machine Info updates do not consume approval receipts.')
    }

    const candidate = applyMachineInfoChanges(current, request.changes)
    const now = this.currentInstant()
    const machineInfo = machineInfoSchema.parse({
      ...candidate,
      ownerPrincipalId: current.ownerPrincipalId,
      revision: current.revision + 1,
      initialApproval: current.initialApproval,
      createdAt: current.createdAt,
      updatedAt: now,
    })
    const update = machineInfoUpdateRecordSchema.parse({
      schemaVersion: 1,
      id: machineInfoUpdateIdSchema.parse(createUuidV7()),
      ownerPrincipalId: LOCAL_OWNER_PRINCIPAL_ID,
      machineId: current.machineId,
      fromRevision: current.revision,
      toRevision: machineInfo.revision,
      materiality,
      explanation: request.explanation,
      changes: request.changes,
      approval: approval === undefined ? { kind: 'not-required' } : this.explicitApproval(approval),
      revision: 1,
      createdAt: now,
    })
    const result = machineInfoUpdateResultSchema.parse({
      machineInfo,
      update,
      card: materiality === 'material'
        ? { kind: 'emit-new-card', reason: 'material-update' }
        : { kind: 'card-not-required', reason: 'small-update' },
    })

    const transaction = this.authority.transact({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      mutations: [
        { kind: 'replace', domain: MACHINE_INFO_DOMAIN, id: current.machineId, expectedRevision: record.revision, value: asJson(machineInfo) },
        { kind: 'insert', domain: MACHINE_INFO_UPDATE_DOMAIN, id: update.id, value: asJson(update) },
      ],
      ...(approval === undefined ? {} : { approval: { receiptId: approval.id, effectDigest } }),
      audit: [{
        kind: `machine-info.${materiality}-updated`,
        subjectDomain: MACHINE_INFO_DOMAIN,
        subjectId: current.machineId,
        details: {
          updateId: update.id,
          fromRevision: update.fromRevision,
          toRevision: update.toRevision,
          explanation: update.explanation,
          card: result.card.kind,
        },
      }],
      idempotency: {
        scope: 'machine-info-update',
        key: request.idempotencyKey,
        request: asJson(idempotencyRequest),
        result: asJson(result),
      },
    })
    return transaction.kind === 'replayed' ? machineInfoUpdateResultSchema.parse(transaction.result) : result
  }

  private requireRecord(machineId: string): AuthorityRecord {
    const record = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_INFO_DOMAIN, machineId)
    if (record === undefined) throw new MachineInfoNotFoundError(`Machine Info for '${machineId}' does not exist.`)
    return record
  }

  private infoFromRecord(record: AuthorityRecord): MachineInfo {
    const machineInfo = machineInfoSchema.parse(record.value)
    if (machineInfo.machineId !== record.id
      || machineInfo.ownerPrincipalId !== record.ownerPrincipalId
      || machineInfo.revision !== record.revision) {
      throw new MachineInfoConflictError('Machine Info authority record is internally inconsistent.')
    }
    return machineInfo
  }

  private assertActiveMachine(machineId: string): void {
    const record = this.authority.get(LOCAL_OWNER_PRINCIPAL_ID, MACHINE_DOMAIN, machineId)
    if (record === undefined) throw new MachineInfoNotFoundError(`Machine '${machineId}' does not exist.`)
    const machine = machineSchema.parse(record.value)
    if (machine.id !== record.id || machine.ownerPrincipalId !== record.ownerPrincipalId || machine.revision !== record.revision) {
      throw new MachineInfoConflictError('Machine authority record is internally inconsistent.')
    }
    if (machine.lifecycle !== 'active') throw new MachineInfoConflictError('Archived Machines cannot change Machine Info.')
  }

  private requireApproval(receiptId: string, effectDigest: Sha256): ApprovalReceiptRecord {
    const approval = this.authority.approval(LOCAL_OWNER_PRINCIPAL_ID, receiptId)
    if (approval === undefined) throw new MachineInfoApprovalRequiredError('The explicit user approval receipt does not exist.')
    if (approval.state !== 'active') throw new MachineInfoApprovalRequiredError(`The explicit user approval receipt is ${approval.state}.`)
    if (approval.effectDigest !== effectDigest) {
      throw new MachineInfoApprovalRequiredError('The explicit user approval does not match the reviewed Machine Info change.')
    }
    return approval
  }

  private explicitApproval(approval: ApprovalReceiptRecord): {
    readonly kind: 'explicit-user-approval'
    readonly receiptId: ApprovalReceiptRecord['id']
    readonly effectDigest: ApprovalReceiptRecord['effectDigest']
    readonly approvedAt: ApprovalReceiptRecord['createdAt']
  } {
    return {
      kind: 'explicit-user-approval',
      receiptId: approval.id,
      effectDigest: approval.effectDigest,
      approvedAt: approval.createdAt,
    }
  }

  private currentInstant(): Instant {
    const now = this.now()
    if (Number.isNaN(now.getTime())) throw new MachineInfoConflictError('Machine Info clock returned an invalid date.')
    return toInstant(new Date(now.getTime()))
  }
}
