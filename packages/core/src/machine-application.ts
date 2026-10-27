import { z, ZodError } from 'zod'
import type {
  SlopApplicationApi,
  SlopAuthWebSocketSession,
  SlopRemoteMethod,
  SlopWebSocketSession,
  PrincipalContext,
} from './application.ts'
import {
  AccessConflictError,
  AccessNotFoundError,
  AccessOrderingError,
  AuthAttachmentConflictError,
  AuthorityConflictError,
  AuthorityProjectionBridge,
  LOCAL_OWNER_PRINCIPAL_ID,
  type RelationalAuthority,
} from './index-machine-internal.ts'
import {
  accessProfileDraftSchema,
  effectiveSshIdlePolicy,
  type AccessProfile,
  type Machine,
} from './domain/inventory.ts'
import {
  InventoryConflictError,
  InventoryNotFoundError,
  InventoryService,
} from './inventory-service.ts'
import {
  initialMachineInfoApprovalDigest,
  initialMachineInfoSaveRequestSchema,
  machineInfoChangeMateriality,
  machineInfoUpdateApprovalDigest,
  machineInfoUpdateRequestSchema,
} from './machine-info.ts'
import {
  MachineInfoApprovalRequiredError,
  MachineInfoConflictError,
  MachineInfoNotFoundError,
  MachineInfoService,
} from './machine-info-service.ts'
import {
  machineIdSchema,
  revisionSchema,
  toInstant,
} from './primitives.ts'
import type { FailureCode, WireResult } from './schemas.ts'

const MACHINE_INFO_APPROVAL_TTL_MS = 10 * 60_000

const connectionRequireRequestSchema = z.object({
  toolCallId: z.string().min(1).max(512),
  machineId: machineIdSchema,
  purpose: z.enum(['remote-read', 'file-transfer']),
  expectedMachineRevision: revisionSchema,
  expectedAccessProfileRevision: revisionSchema,
  minimumRemainingSeconds: z.number().int().nonnegative().max(3_600).optional(),
}).strict()

const challengeRequestSchema = z.object({
  challengeId: z.string().uuid(),
  expectedChallengeRevision: revisionSchema,
}).strict()

const hostTrustRequestSchema = challengeRequestSchema.extend({
  decision: z.enum(['trust-once', 'trust-and-pin', 'reject']),
  fingerprint: z.string().min(1).max(512),
}).strict()

const machineInfoSaveFromChatRequestSchema = initialMachineInfoSaveRequestSchema
  .omit({ approvalReceiptId: true })
  .extend({ userApprovedInCurrentChat: z.literal(true) })
  .strict()

const machineInfoUpdateFromChatRequestSchema = machineInfoUpdateRequestSchema
  .omit({ approvalReceiptId: true })
  .extend({ userApprovedInCurrentChat: z.literal(true).optional() })
  .strict()
  .superRefine((request, context) => {
    const materiality = machineInfoChangeMateriality(request.changes)
    if (materiality === 'material' && request.userApprovedInCurrentChat !== true) {
      context.addIssue({
        code: 'custom',
        message: 'a material Machine Info update requires explicit approval in the current Chat',
        path: ['userApprovedInCurrentChat'],
      })
    }
    if (materiality === 'small' && request.userApprovedInCurrentChat !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a small Machine Info update must not claim explicit approval',
        path: ['userApprovedInCurrentChat'],
      })
    }
  })

export interface MachineConnectionRuntime {
  status(machineId: string, signal?: AbortSignal): Promise<Readonly<{
    state: string
  }>>
  requireConnection(input: unknown, signal?: AbortSignal): Promise<Readonly<{
    observation: Readonly<{
      connectedAt: string
      expiresAt: string
    }>
    lease: Readonly<{
      id: string
      machineId: string
      connectionIdentityDigest: string
      acquiredAt: string
      expiresAt: string
    }>
  }>>
  decideHostTrust(input: unknown, signal?: AbortSignal): Promise<Readonly<{
    challenge: Readonly<{ id: string; revision: number }>
    decision: Readonly<{ decision: string; fingerprint: string }>
  }>>
  startAuthentication(input: unknown): Promise<Readonly<{
    scope: 'machine'
    authFlowId: string
    carrierFlowId: string
    challenge: Readonly<{ id: string; revision: number }>
    expiresAt: string
  }>>
  authenticationStatus(authFlowId: string, signal?: AbortSignal): Promise<unknown>
  cancelAuthentication(authFlowId: string): Promise<void>
}

export interface MachineApplicationOptions {
  readonly authority: RelationalAuthority
  readonly inventory: InventoryService
  readonly connectionRuntime: MachineConnectionRuntime
  readonly openAuthFlow: (principal: PrincipalContext, signal?: AbortSignal) => Promise<SlopAuthWebSocketSession>
  readonly approvalTtlMs?: number
}

function ok(value: unknown): WireResult<unknown> {
  return { ok: true, value }
}

function failed(code: FailureCode, message: string, subject?: string, retryable = false): WireResult<unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(subject === undefined ? {} : { subject }),
      retryable,
    },
  }
}

function errorResult(error: unknown): WireResult<unknown> {
  if (error instanceof ZodError) return failed('INVALID_REQUEST', error.issues[0]?.message ?? 'The request is invalid.')
  if (error instanceof InventoryNotFoundError
    || error instanceof MachineInfoNotFoundError
    || error instanceof AccessNotFoundError) {
    return failed('NOT_FOUND', error.message)
  }
  if (error instanceof InventoryConflictError
    || error instanceof MachineInfoConflictError
    || error instanceof MachineInfoApprovalRequiredError
    || error instanceof AccessConflictError
    || error instanceof AccessOrderingError
    || error instanceof AuthAttachmentConflictError
    || error instanceof AuthorityConflictError) {
    return failed('STATE_CONFLICT', error.message)
  }
  if (error instanceof Error && error.name === 'AbortError') return failed('CANCELLED', error.message, undefined, true)
  return failed('INTERNAL', error instanceof Error ? error.message : 'Machine operation failed.', undefined, true)
}

function requireAgent(principal: PrincipalContext): Readonly<{ agentId: string; sessionId: string }> {
  if (principal.source !== 'agent' || principal.agentId === undefined || principal.sessionId === undefined) {
    throw new AuthorityConflictError('This Machine operation requires the current live Chat Agent.')
  }
  return { agentId: principal.agentId, sessionId: principal.sessionId }
}

/** Machine-only host facade. Queue deliberately lives in its own package and runtime. */
export class MachineApplication implements SlopApplicationApi {
  private readonly projections: AuthorityProjectionBridge
  private readonly machineInfo: MachineInfoService
  private readonly approvalTtlMs: number

  constructor(private readonly options: MachineApplicationOptions) {
    this.projections = new AuthorityProjectionBridge(options.authority)
    this.machineInfo = new MachineInfoService(options.authority)
    this.approvalTtlMs = Math.max(1, Math.min(options.approvalTtlMs ?? MACHINE_INFO_APPROVAL_TTL_MS, MACHINE_INFO_APPROVAL_TTL_MS))
  }

  async invoke(
    method: SlopRemoteMethod,
    request: unknown,
    principal: PrincipalContext,
    signal?: AbortSignal,
  ): Promise<WireResult<unknown>> {
    if (principal.principalId !== LOCAL_OWNER_PRINCIPAL_ID) {
      return failed('POLICY_DENIED', 'The principal is not admitted by this local-owner deployment.')
    }
    try {
      signal?.throwIfAborted()
      switch (method) {
        case 'snapshot':
          return ok(this.projections.snapshot(request, principal.principalId))
        case 'machine.list':
          return ok(this.options.inventory.listMachines(request).map(record => this.machineProjection(record.machine, record.accessProfile)))
        case 'machine.get': {
          const record = this.options.inventory.getMachine(request)
          const projection = this.machineProjection(record.machine, record.accessProfile)
          if (record.accessProfile.kind === 'local') return ok(projection)
          const connection = await this.options.connectionRuntime.status(record.machine.id, signal)
          return ok({ ...projection, connectionState: connection.state })
        }
        case 'machine.create': {
          requireAgent(principal)
          const record = this.options.inventory.createMachine(request)
          return ok(this.machineProjection(record.machine, record.accessProfile))
        }
        case 'machine.update': {
          const result = this.options.inventory.updateMachine(request)
          return ok(this.machineProjection(result.machine, result.accessProfile))
        }
        case 'machine.archive': {
          const result = this.options.inventory.archiveMachine(request)
          return ok(this.machineProjection(result.machine, result.accessProfile))
        }
        case 'machineInfo.get': {
          const input = z.object({ machineId: machineIdSchema }).strict().parse(request)
          return ok(this.machineInfo.require(input.machineId))
        }
        case 'machineInfo.save':
          return ok(this.saveMachineInfo(request, principal))
        case 'machineInfo.update':
          return ok(this.updateMachineInfo(request, principal))
        case 'connection.require':
          return await this.requireConnection(request, principal, signal)
        case 'hostTrust.decide': {
          const result = await this.options.connectionRuntime.decideHostTrust(hostTrustRequestSchema.parse(request), signal)
          return ok({
            challenge: { id: result.challenge.id, revision: result.challenge.revision },
            decision: { decision: result.decision.decision, fingerprint: result.decision.fingerprint },
          })
        }
        case 'authFlow.start': {
          const result = await this.options.connectionRuntime.startAuthentication(challengeRequestSchema.parse(request))
          return ok({
            scope: result.scope,
            authFlowId: result.authFlowId,
            carrierFlowId: result.carrierFlowId,
            challenge: { id: result.challenge.id, revision: result.challenge.revision },
            expiresAt: result.expiresAt,
          })
        }
        case 'authFlow.status': {
          const input = z.object({ authFlowId: z.string().uuid() }).strict().parse(request)
          return ok(await this.options.connectionRuntime.authenticationStatus(input.authFlowId, signal))
        }
        case 'authFlow.cancel': {
          const input = z.object({ authFlowId: z.string().uuid() }).strict().parse(request)
          await this.options.connectionRuntime.cancelAuthentication(input.authFlowId)
          return ok({ cancelled: true })
        }
        default:
          return failed('CAPABILITY_UNAVAILABLE', `${method} is outside dsh-slop-machine and dsh-slop-queue.`, method)
      }
    } catch (error) {
      return errorResult(error)
    }
  }

  openFeed(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopWebSocketSession<unknown>> {
    return Promise.resolve(this.projections.openFeed(principal.principalId, signal))
  }

  openAuthFlow(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopAuthWebSocketSession> {
    return this.options.openAuthFlow(principal, signal)
  }

  close(): Promise<void> {
    return this.projections.close()
  }

  private async requireConnection(
    request: unknown,
    principal: PrincipalContext,
    signal?: AbortSignal,
  ): Promise<WireResult<unknown>> {
    const input = connectionRequireRequestSchema.parse(request)
    const owner = requireAgent(principal)
    const result = await this.options.connectionRuntime.requireConnection({ ...input, ...owner }, signal)
    return ok({
      kind: 'ready',
      machineId: result.lease.machineId,
      machineRevision: input.expectedMachineRevision,
      accessProfileRevision: input.expectedAccessProfileRevision,
      readyAt: result.observation.connectedAt,
      expiresAt: result.observation.expiresAt,
    })
  }

  private saveMachineInfo(request: unknown, principal: PrincipalContext): unknown {
    requireAgent(principal)
    const input = machineInfoSaveFromChatRequestSchema.parse(request)
    const callerRequest = { candidate: input.candidate, idempotencyKey: input.idempotencyKey }
    const replay = this.machineInfo.replayInitial(callerRequest)
    if (replay !== undefined) return replay
    const approval = this.options.authority.issueApproval({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      effectDigest: initialMachineInfoApprovalDigest(input.candidate),
      expiresAt: toInstant(new Date(Date.now() + this.approvalTtlMs)),
    })
    return this.machineInfo.saveInitial({ ...callerRequest, approvalReceiptId: approval.id })
  }

  private updateMachineInfo(request: unknown, principal: PrincipalContext): unknown {
    requireAgent(principal)
    const input = machineInfoUpdateFromChatRequestSchema.parse(request)
    const callerRequest = {
      machineId: input.machineId,
      expectedRevision: input.expectedRevision,
      explanation: input.explanation,
      changes: input.changes,
      idempotencyKey: input.idempotencyKey,
    }
    const replay = this.machineInfo.replayUpdate(callerRequest)
    if (replay !== undefined) return replay
    if (machineInfoChangeMateriality(input.changes) === 'small') return this.machineInfo.update(callerRequest)
    const approval = this.options.authority.issueApproval({
      principalId: LOCAL_OWNER_PRINCIPAL_ID,
      effectDigest: machineInfoUpdateApprovalDigest(callerRequest),
      expiresAt: toInstant(new Date(Date.now() + this.approvalTtlMs)),
    })
    return this.machineInfo.update({ ...callerRequest, approvalReceiptId: approval.id })
  }

  private machineProjection(machine: Machine, access: AccessProfile): Record<string, unknown> {
    const accessDraft = accessProfileDraftSchema.parse(access.kind === 'local'
      ? { kind: 'local' }
      : {
          kind: 'ssh',
          target: access.target,
          controlOwnership: access.controlOwnership,
          trustPolicy: access.trustPolicy,
          authentication: access.authentication,
          timeouts: access.timeouts,
        })
    const roots = new Map(machine.declaredRoots.map(root => [root.role, root.path.path] as const))
    const target = access.kind === 'local'
      ? undefined
      : access.target.kind === 'config-alias'
        ? access.target.alias
        : access.target.host
    return {
      id: machine.id,
      name: machine.name,
      kind: access.kind,
      state: machine.lifecycle === 'archived' ? 'archived' : 'ready',
      connectionState: access.kind === 'local' ? 'ready' : 'stale',
      ...(target === undefined ? {} : { target }),
      ...(access.kind === 'ssh' && access.target.kind === 'config-alias' ? { sshAlias: access.target.alias } : {}),
      ...(access.kind === 'ssh' && access.target.kind === 'endpoint'
        ? { host: access.target.host, port: access.target.port, ...(access.target.user === undefined ? {} : { username: access.target.user }) }
        : {}),
      ...(access.kind === 'ssh' ? {
        networkAccess: 'direct',
        authentication: access.authentication.kind === 'interactive'
          ? 'interactive-2fa'
          : access.authentication.kind === 'ssh-agent'
            ? 'ssh-agent'
            : 'unknown',
        trustMode: access.trustPolicy.kind === 'trust-on-first-use' ? 'tofu-labelled' : access.trustPolicy.kind,
      } : {}),
      ...(machine.preferredExecutionProviderId === undefined
        ? {}
        : { scheduler: machine.preferredExecutionProviderId, schedulerPreference: machine.preferredExecutionProviderId }),
      ...(roots.get('home') === undefined ? {} : { homePath: roots.get('home') }),
      ...(roots.get('work') === undefined ? {} : { workPath: roots.get('work'), storageRoot: roots.get('work') }),
      ...(roots.get('scratch') === undefined ? {} : { scratchPath: roots.get('scratch') }),
      revision: machine.revision,
      accessProfileRevision: access.revision,
      ...(access.kind === 'ssh' ? { sshIdlePolicy: effectiveSshIdlePolicy(access) } : {}),
      baseConfiguration: {
        name: machine.name,
        access: accessDraft,
        declaredRoots: machine.declaredRoots,
        ...(machine.preferredExecutionProviderId === undefined
          ? {}
          : { preferredExecutionProviderId: machine.preferredExecutionProviderId }),
      },
      ...(machine.archivedAt === undefined ? {} : { archivedAt: machine.archivedAt }),
    }
  }
}
