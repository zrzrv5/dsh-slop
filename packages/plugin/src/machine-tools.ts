import { discoveryRootInput, resolveDiscoveryRootCommand, resolvedDiscoveryRoot, isAbsoluteRemotePath } from './resolve-discovery-root.ts'
import { machineInfoCandidateInput, machineInfoChangesInput } from './machine-info-input.ts'
import { DISCOVERY_CENSUS_COMMAND, compileDiscoveryProjectPage, discoveryFocus, parseDiscoveryCensus } from './discovery-pages.ts'
import type { JsonValue as ToolJsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type InferValue,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type ToolResult,
  type ToolResultView,
  type ValueSchemaSpec,
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
} from '@deepseek-ai/dsh-tools'
import {
  asPrincipalId,
  jsonValueSchema,
  localAbsolutePathSchema,
  machineIdSchema,
  machineInfoCandidateSchema,
  machineInfoChangesSchema,
  remotePathSchema,
  type PrincipalContext,
  type SlopApplicationApi,
  type WireResult,
} from '@dsh-slop/core'
import type {
  MachineService,
  MachineShellResult,
  MachineTransferService,
} from '@dsh-slop/execution'
import { sshDiagnostic } from '@dsh-slop/execution'
import { z } from 'zod'
import type { DiscoveryShellBudget, MachineDiscoveryGuard } from './machine-discovery-guard.ts'
import type { TransferProgressHub } from './transfer-progress.ts'
import {
  compileDiscoveryEvidenceCommand,
  parseDiscoveryEvidenceFiles,
  parseDiscoveryEvidenceTerms,
} from './discovery-evidence.ts'

const MODEL_TEXT_LIMIT = 128 * 1024
const DISCOVERY_MODEL_TEXT_LIMIT = 12 * 1024
const SHELL_MODEL_TEXT_LIMIT = 12 * 1024

function deadlineSignal(parent: AbortSignal, timeoutMs: number | undefined): AbortSignal {
  if (timeoutMs === undefined) return parent
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)])
}

const wireResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.string(),
      message: z.string(),
      subject: z.string().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
      retryable: z.boolean(),
    }).passthrough(),
  }).passthrough(),
])

const sshIdlePolicySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('app-managed'),
    configuredIdleSeconds: z.number().int().positive(),
    minimumIdleSeconds: z.number().int().positive(),
    effectiveIdleSeconds: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal('external'),
    controlOwnership: z.enum(['adopt-user-master', 'direct']),
    configuredIdleSeconds: z.number().int().positive(),
    effectiveIdleSeconds: z.number().int().positive(),
  }).strict(),
])

const machineProjectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  target: z.string().optional(),
  sshAlias: z.string().optional(),
  username: z.string().optional(),
  host: z.string().optional(),
  revision: z.number().int().positive(),
  accessProfileRevision: z.number().int().positive(),
  sshIdlePolicy: sshIdlePolicySchema.optional(),
  baseConfiguration: z.object({
    name: z.string().min(1),
    access: z.unknown(),
    declaredRoots: z.array(z.unknown()),
    preferredExecutionProviderId: z.string().optional(),
  }).passthrough(),
}).passthrough()

const setupInputSchema = z.object({
  machineId: z.undefined().optional(),
  machineAlias: z.string().trim().min(1).max(256).optional(),
  sshTarget: z.string().trim().min(1).max(512),
  authentication: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('requires-2fa') }).strict(),
    z.object({ kind: z.literal('passwordless-key'), keyPath: z.string().trim().min(1).max(4_096) }).strict(),
  ]),
  scheduler: z.enum(['slurm', 'pbs', 'none', 'unknown']),
  paths: z.object({
    home: z.string().min(1).max(8_192).optional(),
    work: z.string().min(1).max(8_192).optional(),
    scratch: z.string().min(1).max(8_192).optional(),
  }).strict(),
}).strict()

const savedMachineInputSchema = z.object({
  machineId: z.string().uuid(),
  machineName: z.undefined().optional(),
  machineAlias: z.undefined().optional(),
  sshTarget: z.undefined().optional(),
  authentication: z.undefined().optional(),
  scheduler: z.undefined().optional(),
  paths: z.undefined().optional(),
}).strict()

const savedMachineNameInputSchema = z.object({
  machineId: z.undefined().optional(),
  machineName: z.string().trim().min(1).max(256),
  machineAlias: z.undefined().optional(),
  sshTarget: z.undefined().optional(),
  authentication: z.undefined().optional(),
  scheduler: z.undefined().optional(),
  paths: z.undefined().optional(),
}).strict()

const connectInputSchema = z.union([setupInputSchema, savedMachineInputSchema, savedMachineNameInputSchema])

const transferEndpointSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: localAbsolutePathSchema }).strict(),
  z.object({
    kind: z.literal('machine'),
    machineId: machineIdSchema,
    path: remotePathSchema,
  }).strict(),
])

const transferInputSchema = z.object({
  protocol: z.enum(['sftp', 'scp']).optional(),
  source: transferEndpointSchema,
  destination: transferEndpointSchema,
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional(),
}).strict()

export const machineDiscoveryMetadataSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('resolve-root'), root: z.string().refine(value => discoveryRootInput(value) !== undefined), purpose: z.string().trim().min(1).max(512) }).strict(),
  z.object({
    phase: z.literal('census'),
    root: z.string().min(1).max(8_192),
    purpose: z.string().trim().min(1).max(512),
  }).strict(),
  z.object({
    phase: z.literal('project-read'),
    projectPath: z.string().min(1).max(8_192),
    purpose: z.string().trim().min(1).max(512),
    selectionPlan: z.array(z.string().min(1).max(8_192)).min(1).max(12),
    focus: z.string().refine(value => discoveryFocus(value) !== undefined, 'Use an observed relative workstream path such as ./source; omit focus for the first project page.').optional(),
  }).strict(),
])

export type MachineDiscoveryMetadata = z.output<typeof machineDiscoveryMetadataSchema>

export interface MachineToolServices {
  readonly application: SlopApplicationApi
  readonly machineService: MachineService
  readonly machineTransferService: MachineTransferService
  readonly transferProgress?: Pick<TransferProgressHub, 'start' | 'append' | 'finish'>
  readonly discoveryGuard?: Partial<Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'>>
}

function parameters(value: ParameterSchemaSpec): ParameterSchemaSpec {
  return Object.freeze(value)
}

function objectSchema<const Properties extends ParameterSchemaSpec>(
  properties: Properties,
): { readonly type: 'object'; readonly properties: Properties; readonly additionalProperties: false }
function objectSchema<const Properties extends ParameterSchemaSpec, const AdditionalProperties extends boolean>(
  properties: Properties,
  additionalProperties: AdditionalProperties,
): { readonly type: 'object'; readonly properties: Properties; readonly additionalProperties: AdditionalProperties }
function objectSchema(
  properties: ParameterSchemaSpec,
  additionalProperties = false,
): ValueSchemaSpec {
  return { type: 'object', properties, additionalProperties }
}

type RequiredValueSchema<Schema extends ValueSchemaSpec> =
  Schema extends ValueSchemaSpec ? Schema & { readonly required: true } : never

function required<const Schema extends ValueSchemaSpec>(
  schema: Schema,
): RequiredValueSchema<Schema>
function required(schema: ValueSchemaSpec): ParameterPropertySpec
function required(schema: ValueSchemaSpec): ParameterPropertySpec {
  return { ...schema, required: true }
}

const stringSchema = { type: 'string' } satisfies ValueSchemaSpec
const integerSchema = { type: 'integer' } satisfies ValueSchemaSpec
const booleanSchema = { type: 'boolean' } satisfies ValueSchemaSpec
const openObjectSchema = objectSchema({}, true)

const sshIdlePolicyOutputSchema = {
  oneOf: [
    objectSchema({
      kind: required({ type: 'string', const: 'app-managed' }),
      configuredIdleSeconds: required(integerSchema),
      minimumIdleSeconds: required(integerSchema),
      effectiveIdleSeconds: required(integerSchema),
    }, false),
    objectSchema({
      kind: required({ type: 'string', const: 'external' }),
      controlOwnership: required({ type: 'string', enum: ['adopt-user-master', 'direct'] }),
      configuredIdleSeconds: required(integerSchema),
      effectiveIdleSeconds: required(integerSchema),
    }, false),
  ],
} satisfies ValueSchemaSpec

const machineProjectionOutputSchema = objectSchema({
  id: required(stringSchema),
  name: required(stringSchema),
  kind: required({ type: 'string', enum: ['local', 'ssh'] }),
  state: required({ type: 'string', enum: ['ready', 'archived'] }),
  connectionState: required(stringSchema),
  target: stringSchema,
  sshAlias: stringSchema,
  username: stringSchema,
  host: stringSchema,
  port: integerSchema,
  networkAccess: stringSchema,
  authentication: stringSchema,
  trustMode: stringSchema,
  scheduler: stringSchema,
  schedulerPreference: stringSchema,
  homePath: stringSchema,
  workPath: stringSchema,
  storageRoot: stringSchema,
  scratchPath: stringSchema,
  revision: required(integerSchema),
  accessProfileRevision: required(integerSchema),
  sshIdlePolicy: sshIdlePolicyOutputSchema,
  baseConfiguration: required(objectSchema({
    name: required(stringSchema),
    access: required(openObjectSchema),
    declaredRoots: required({ type: 'array', items: openObjectSchema }),
    preferredExecutionProviderId: stringSchema,
  }, true)),
  archivedAt: stringSchema,
}, true)

const machineInfoOutputSchema = objectSchema({
  schemaVersion: required(integerSchema),
  machineId: required(stringSchema),
  setup: required(objectSchema({
    machineAlias: stringSchema,
    sshTarget: required(stringSchema),
    authentication: required(openObjectSchema),
    scheduler: required(stringSchema),
    paths: required(openObjectSchema),
    discoveryProfile: required(stringSchema),
  }, true)),
  customNotes: required(stringSchema),
  approvedDiscovery: required(objectSchema({
    summary: required(stringSchema),
    operatingDefaults: required(openObjectSchema),
    sections: required({ type: 'array', items: openObjectSchema }),
  }, true)),
  ownerPrincipalId: required(stringSchema),
  revision: required(integerSchema),
  initialApproval: required(openObjectSchema),
  createdAt: required(stringSchema),
  updatedAt: required(stringSchema),
}, true)

const machineFailureOutputSchema = objectSchema({
  schemaVersion: required({ type: 'integer', const: 1 }),
  ok: required({ type: 'boolean', const: false }),
  error: required(objectSchema({
    code: required(stringSchema),
    message: required(stringSchema),
    subject: stringSchema,
    details: openObjectSchema,
    retryable: required(booleanSchema),
  }, false)),
}, false)

function machineWireOutputSchema<const Schema extends ValueSchemaSpec>(value: Schema) {
  return {
    oneOf: [
      objectSchema({
        schemaVersion: required({ type: 'integer', const: 1 }),
        ok: required({ type: 'boolean', const: true }),
        value: required(value),
      }, false),
      machineFailureOutputSchema,
    ],
  } satisfies ValueSchemaSpec
}

const machineListOutputSchema = machineWireOutputSchema({
  type: 'array',
  items: machineProjectionOutputSchema,
})

const machineGetOutputSchema = machineWireOutputSchema(objectSchema({
  machine: required(machineProjectionOutputSchema),
  machineInfo: machineInfoOutputSchema,
}, false))

const machineConnectOutputSchema = machineWireOutputSchema({
  oneOf: [
    objectSchema({
      phase: required({ type: 'string', const: 'registered' }),
      machineId: required(stringSchema),
      machineRevision: required(integerSchema),
      accessProfileRevision: required(integerSchema),
      requiredNextAction: required(objectSchema({
        tool: required({ type: 'string', const: 'slop_machine_connect' }),
        arguments: required(objectSchema({
          machineId: required(stringSchema),
        }, false)),
      }, false)),
    }, false),
    objectSchema({
      kind: required({ type: 'string', const: 'ready' }),
      machineId: required(stringSchema),
      machineRevision: required(integerSchema),
      accessProfileRevision: required(integerSchema),
      readyAt: required(stringSchema),
      expiresAt: required(stringSchema),
      sessionCheck: objectSchema({
        ok: required(booleanSchema),
        message: stringSchema,
        exitCode: integerSchema,
        timedOut: booleanSchema,
        startupStderr: stringSchema,
      }, false),
    }, false),
  ],
})

const SESSION_PROBE_MARKER = 'dsh-slop-session-ready'
const SESSION_PROBE_TIMEOUT_MS = 15_000
const SESSION_STARTUP_BROKEN = 'The connection is ready, but a fixed test command (printf) did not run: the remote account\'s non-interactive shell startup stops before commands execute. Usual causes are lines in ~/.bashrc, ~/.bash_profile or ~/.profile that print output, start another shell with exec, or wait for input. Ask the user to run ssh <target> \'echo ok\' in a terminal, and to guard interactive-only lines with [[ $- == *i* ]] || return. Do not run other commands on this Machine until a reconnect passes this check.'
const SESSION_STARTUP_NOISE = 'Remote startup files print to stderr in non-interactive sessions. Commands still run; treat this text as noise in later results, not as a command failure.'

interface SessionCheck {
  readonly ok: boolean
  readonly message?: string
  readonly exitCode?: number
  readonly timedOut?: boolean
  readonly startupStderr?: string
}

/**
 * Run one fixed, side-effect-free marker command after the transport is ready.
 * A ready transport does not prove the account's shell startup lets commands run.
 */
async function checkRemoteSession(services: MachineToolServices, machineId: ReturnType<typeof machineIdSchema.parse>, signal: AbortSignal | undefined): Promise<SessionCheck> {
  try {
    const result = await services.machineService.execute({
      machineId,
      command: `printf '%s\\n' ${SESSION_PROBE_MARKER}`,
      timeoutMs: SESSION_PROBE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    })
    const ran = result.stdout.split(/\r?\n/u).some(line => line.trim() === SESSION_PROBE_MARKER)
    const startupStderr = result.stderr.trim().slice(0, 512)
    if (ran) return startupStderr === '' ? { ok: true } : { ok: true, startupStderr, message: SESSION_STARTUP_NOISE }
    return {
      ok: false,
      message: SESSION_STARTUP_BROKEN,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      timedOut: result.timedOut,
      ...(startupStderr === '' ? {} : { startupStderr }),
    }
  } catch (error) {
    signal?.throwIfAborted()
    return { ok: false, message: `The connection is ready, but the test command could not start: ${error instanceof Error ? error.message.slice(0, 512) : 'unknown error'}` }
  }
}

const machineInfoSetOutputSchema = machineWireOutputSchema(objectSchema({
  machineInfo: required(machineInfoOutputSchema),
  update: openObjectSchema,
  card: required(objectSchema({
    kind: required(stringSchema),
    reason: required(stringSchema),
  }, false)),
}, false))

const machineShellOutputSchema = machineWireOutputSchema(objectSchema({
  kind: required({ type: 'string', const: 'completed' }),
  machineId: required(stringSchema),
  machineRevision: required(integerSchema),
  accessProfileRevision: required(integerSchema),
  exitCode: required({ oneOf: [{ type: 'integer' }, { type: 'null' }] }),
  signal: required({ oneOf: [{ type: 'string' }, { type: 'null' }] }),
  timedOut: required(booleanSchema),
  stdout: required(stringSchema),
  stderr: required(stringSchema),
  outputTruncated: booleanSchema,
  outputBytes: integerSchema,
  outputNotice: stringSchema,
  machineAlias: required(stringSchema),
  censusPage: objectSchema({
    entries: required({ type: 'array', items: objectSchema({ entry: required(stringSchema), category: required({ type: 'string', const: 'unclassified' }), evidenceTier: required({ type: 'string', const: 'census' }) }, false) }),
    complete: required(booleanSchema),
  }, false),
  discoveryBudget: objectSchema({
    shellAttemptsUsed: required(integerSchema),
    shellAttemptsRemaining: required(integerSchema),
    selectedProjectPaths: required(integerSchema),
    turnOutputBytesRemaining: required(integerSchema),
  }, false),
  discoveryControl: required({
    oneOf: [
      objectSchema({
        kind: required({ type: 'string', const: 'project-selection-complete' }),
        message: required(stringSchema),
      }, false),
      objectSchema({
        kind: required({ type: 'string', const: 'duplicate-suppressed' }),
        message: required(stringSchema),
      }, false),
      objectSchema({
        kind: required({ type: 'string', const: 'project-not-in-plan' }),
        message: required(stringSchema),
      }, false),
      objectSchema({
        kind: required({ type: 'string', const: 'evidence-not-observed' }),
        message: required(stringSchema),
        unobservedPaths: required({ type: 'array', items: stringSchema }),
        observedPaths: required({ type: 'array', items: stringSchema }),
      }, false),
      objectSchema({
        kind: required({ type: 'string', const: 'focused-recovery-required' }),
        message: required(stringSchema),
      }, false),
      { type: 'null' },
    ],
  }),
}, false))

const transferEndpointOutputSchema = {
  oneOf: [
    objectSchema({
      kind: required({ type: 'string', const: 'local' }),
      path: required(stringSchema),
    }, false),
    objectSchema({
      kind: required({ type: 'string', const: 'machine' }),
      machineId: required(stringSchema),
      path: required(stringSchema),
    }, false),
  ],
} satisfies ValueSchemaSpec

const machineTransferOutputSchema = machineWireOutputSchema(objectSchema({
  kind: required({ type: 'string', const: 'completed' }),
  source: required(transferEndpointOutputSchema),
  destination: required(transferEndpointOutputSchema),
  entryKind: required({ type: 'string', enum: ['file', 'directory'] }),
  relayedThroughHost: required(booleanSchema),
  exitCode: required({ oneOf: [{ type: 'integer' }, { type: 'null' }] }),
  signal: required({ oneOf: [{ type: 'string' }, { type: 'null' }] }),
  timedOut: required(booleanSchema),
  terminalOutput: required(stringSchema),
}, false))

function jsonOutputDefinition<const Schema extends ValueSchemaSpec>(schema: Schema): {
  readonly schema: Schema
  readonly render: (_args: unknown, value: InferValue<Schema>) => { readonly type: 'text'; readonly text: string }[]
} {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
  }
}

function transferOutputDefinition(): {
  readonly schema: typeof machineTransferOutputSchema
  readonly render: (_args: unknown, value: InferValue<typeof machineTransferOutputSchema>) => { readonly type: 'text'; readonly text: string }[]
  readonly presentationMeta: (_args: unknown, value: InferValue<typeof machineTransferOutputSchema>) => ToolJsonValue
} {
  return {
    schema: machineTransferOutputSchema,
    render: (_args, value) => {
      const visible = structuredClone(value) as ToolJsonValue
      if (visible !== null && typeof visible === 'object' && !Array.isArray(visible)) {
        const result = visible['value']
        if (result !== null && typeof result === 'object' && !Array.isArray(result)) delete result['terminalOutput']
        const error = visible['error']
        if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
          const details = error['details']
          if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
            if (typeof details['terminalOutput'] === 'string') details['diagnostic'] = sshDiagnostic(details['terminalOutput'], 768)
            delete details['terminalOutput']
          }
        }
      }
      return [{ type: 'text', text: renderResult(visible) }]
    },
    presentationMeta: transferPresentationMeta,
  }
}

function canonicalOutput<const Schema extends ValueSchemaSpec>(
  schema: Schema,
  value: unknown,
): InferValue<Schema> {
  const parsed = jsonValueSchema.parse(value)
  const violations = validateJsonSchemaValue(valueSchemaSpecToJsonSchema(schema), parsed)
  if (violations.length > 0) {
    throw new Error(`Machine tool produced an invalid canonical result: ${violations.join('; ')}`)
  }
  return parsed as InferValue<Schema>
}

function outputJson(value: unknown): ToolJsonValue {
  const parsed = jsonValueSchema.parse(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed as ToolJsonValue
  return { ...parsed, schemaVersion: 1 } as ToolJsonValue
}

function renderResult(value: unknown): string {
  const text = JSON.stringify(jsonValueSchema.parse(value))
  if (Buffer.byteLength(text, 'utf8') <= MODEL_TEXT_LIMIT) return text
  return JSON.stringify({
    ok: false,
    error: {
      code: 'BOUNDS',
      message: 'The model-visible result exceeds 128 KiB. Narrow the command or query.',
      retryable: true,
    },
  })
}

function shellOutput(
  result: MachineShellResult,
  machineAlias: string,
  discovery: MachineDiscoveryMetadata | undefined,
  discoveryBudget: DiscoveryShellBudget | undefined,
  discoveryControl?: Readonly<{
    kind: 'project-selection-complete'
      | 'duplicate-suppressed'
      | 'project-not-in-plan'
      | 'evidence-not-observed'
      | 'focused-recovery-required'
    message: string
    unobservedPaths?: readonly string[]
    observedPaths?: readonly string[]
  }>,
): ToolJsonValue {
  const censusPage = discovery?.phase === 'census' && result.exitCode === 0 && !result.timedOut
    ? parseDiscoveryCensus(result.stdout) : undefined
  const output = outputJson({
    ok: true,
    value: {
      ...result,
      machineAlias,
      ...(censusPage === undefined ? {} : { censusPage }),
      ...(discoveryBudget === undefined ? {} : { discoveryBudget }),
      discoveryControl: discoveryControl ?? null,
    },
  })
  if (discovery === undefined) {
    if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= SHELL_MODEL_TEXT_LIMIT) return output
    // Bound the canonical result too: PTC consumes it without going through renderResult.
    const stdout = Buffer.from(result.stdout)
    const stderr = Buffer.from(result.stderr)
    let previewBytes = 8 * 1024
    for (;;) {
      const stderrBytes = Math.min(stderr.length, Math.floor(previewBytes / 2))
      const preview = outputJson({ ok: true, value: {
        ...result,
        stdout: new TextDecoder().decode(stdout.subarray(0, previewBytes - stderrBytes), { stream: true }),
        stderr: new TextDecoder().decode(stderr.subarray(0, stderrBytes), { stream: true }),
        machineAlias,
        discoveryControl: null,
        outputTruncated: true,
        outputBytes: stdout.length + stderr.length,
        outputNotice: 'Output preview capped at 12 KiB. The command already ran; do not rerun mutations. Narrow subsequent reads to the needed paths, terms, or ranges.',
      } })
      if (Buffer.byteLength(JSON.stringify(preview), 'utf8') <= SHELL_MODEL_TEXT_LIMIT) return preview
      previewBytes = Math.floor(previewBytes / 2)
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8')
  if (bytes <= DISCOVERY_MODEL_TEXT_LIMIT) return output
  return outputJson({
    ok: false,
    error: {
      code: 'DISCOVERY_RESULT_BOUNDS',
      message: 'Discovery output exceeded 12 KiB. Narrow the exact evidence or reduce its line ranges; do not repeat or broaden the command.',
      details: { observedBytes: bytes, limitBytes: DISCOVERY_MODEL_TEXT_LIMIT },
      retryable: false,
    },
  })
}

function shellTraceLabel(args: unknown): string {
  if (typeof args !== 'object' || args === null) return 'Remote shell · saved Machine'
  const alias = Reflect.get(args, 'machineAlias')
  return typeof alias === 'string' && alias.trim().length > 0
    ? `Remote shell · ${alias.trim()}`
    : 'Remote shell · saved Machine'
}

function shellResultPresentation(args: unknown, result: ToolResult): ToolResultView {
  const fallback: ToolResultView = { card: 'terminal' }
  if (result.isError || result.content.length !== 1 || result.content[0]?.type !== 'text') return fallback
  try {
    const parsed = JSON.parse(result.content[0].text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Reflect.get(parsed, 'ok') !== true) return fallback
    const value = Reflect.get(parsed, 'value')
    if (typeof value !== 'object' || value === null) return fallback
    const stdout = Reflect.get(value, 'stdout')
    const stderr = Reflect.get(value, 'stderr')
    const exitCode = Reflect.get(value, 'exitCode')
    const signal = Reflect.get(value, 'signal')
    const output = [stdout, stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('')
    return {
      card: 'terminal',
      ...(typeof Reflect.get(args as object, 'command') === 'string'
        ? { title: Reflect.get(args as object, 'command') as string }
        : {}),
      ...(output.length === 0 ? {} : { output }),
      ...(typeof signal === 'string'
        ? { signal }
        : typeof exitCode === 'number' && Number.isInteger(exitCode)
          ? { exitCode }
          : {}),
    }
  } catch {
    return fallback
  }
}

function transferResultPresentation(_args: unknown, result: ToolResult): ToolResultView {
  const fallback: ToolResultView = { card: 'terminal' }
  if (result.isError || result.content.length !== 1 || result.content[0]?.type !== 'text') return fallback
  const meta = result.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return fallback
  const output = meta['terminalOutput']
  const exitCode = meta['exitCode']
  const signal = meta['signal']
  return {
    card: 'terminal',
    ...(typeof output === 'string' && output.length > 0 ? { output } : {}),
    ...(typeof signal === 'string'
      ? { signal }
      : typeof exitCode === 'number' && Number.isInteger(exitCode)
        ? { exitCode }
        : {}),
  }
}

function transferPresentationMeta(_args: unknown, value: ToolJsonValue): ToolJsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = value['ok'] === true
    ? value['value']
    : value['ok'] === false && value['error'] !== null && typeof value['error'] === 'object' && !Array.isArray(value['error'])
      ? value['error']['details']
      : undefined
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return {}
  return {
    terminalOutput: typeof result['terminalOutput'] === 'string' ? result['terminalOutput'] : '',
    exitCode: typeof result['exitCode'] === 'number' ? result['exitCode'] : null,
    signal: typeof result['signal'] === 'string' ? result['signal'] : null,
  }
}

function transferEndpointLabel(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '?'
  const path = Reflect.get(value, 'path')
  const kind = Reflect.get(value, 'kind')
  if (typeof path !== 'string') return '?'
  if (kind === 'local') return path
  const machineId = Reflect.get(value, 'machineId')
  return `${typeof machineId === 'string' ? machineId : 'Machine'}:${path}`
}

function principalFor(execution: {
  readonly agent?: { readonly id: unknown; readonly session: { readonly id: unknown } }
}): PrincipalContext {
  if (execution.agent === undefined) throw new Error('DSH-SLOP Machine tools require the current live Agent')
  return {
    principalId: asPrincipalId('local-owner'),
    source: 'agent',
    agentId: String(execution.agent.id),
    sessionId: String(execution.agent.session.id),
  }
}

function requireOk(result: WireResult<unknown>): unknown {
  const parsed = wireResultSchema.parse(result)
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  return parsed.value
}

function exactTarget(machine: z.output<typeof machineProjectionSchema>): string | undefined {
  if (machine.sshAlias !== undefined) return machine.sshAlias
  if (machine.username !== undefined && machine.host !== undefined) return `${machine.username}@${machine.host}`
  return machine.target
}

function setupBaseConfiguration(
  current: z.output<typeof machineProjectionSchema>,
  input: z.output<typeof setupInputSchema>,
): Record<string, unknown> {
  const access = z.record(z.string(), z.unknown()).parse(current.baseConfiguration.access)
  const authentication = input.authentication.kind === 'requires-2fa'
    ? { kind: 'interactive' }
    : { kind: 'ssh-agent', localKeyFilePath: input.authentication.keyPath }
  const submittedRoots = Object.entries(input.paths).map(([role, path]) => ({
    id: role,
    role,
    label: role,
    path: { kind: 'remote', path },
  }))
  const preferredExecutionProviderId = input.scheduler === 'slurm'
    ? 'slurm'
    : input.scheduler === 'pbs'
      ? 'pbs'
      : input.scheduler === 'none'
        ? 'direct'
        : undefined
  return {
    name: input.machineAlias ?? current.name,
    access: { ...access, authentication },
    declaredRoots: submittedRoots.length === 0 ? current.baseConfiguration.declaredRoots : submittedRoots,
    ...(preferredExecutionProviderId === undefined ? {} : { preferredExecutionProviderId }),
  }
}

async function registerOrReuseMachine(
  services: MachineToolServices,
  input: z.output<typeof setupInputSchema>,
  principal: PrincipalContext,
  callId: string,
  signal: AbortSignal,
): Promise<z.output<typeof machineProjectionSchema>> {
  const listed = machineProjectionSchema.array().parse(requireOk(
    await services.application.invoke('machine.list', {}, principal, signal),
  ))
  const existing = listed.find(machine => exactTarget(machine) === input.sshTarget)
  if (existing === undefined) {
    return machineProjectionSchema.parse(requireOk(await services.application.invoke('machine.create', {
      machineAlias: input.machineAlias,
      sshTarget: input.sshTarget,
      authentication: input.authentication,
      scheduler: input.scheduler,
      paths: input.paths,
      idempotencyKey: `machine-connect:create:${callId}`,
    }, principal, signal)))
  }
  return machineProjectionSchema.parse(requireOk(await services.application.invoke('machine.update', {
    schemaVersion: 1,
    machineId: existing.id,
    expectedMachineRevision: existing.revision,
    expectedAccessProfileRevision: existing.accessProfileRevision,
    baseConfiguration: setupBaseConfiguration(existing, input),
    idempotencyKey: `machine-connect:update:${callId}`,
  }, principal, signal)))
}

async function machineWithInfo(
  services: MachineToolServices,
  machineId: string,
  principal: PrincipalContext,
  signal: AbortSignal,
): Promise<ToolJsonValue> {
  const machine = await services.application.invoke('machine.get', { machineId }, principal, signal)
  if (!machine.ok) return outputJson(machine)
  const info = await services.application.invoke('machineInfo.get', { machineId }, principal, signal)
  return outputJson({
    ok: true,
    value: {
      machine: machine.value,
      ...(info.ok ? { machineInfo: info.value } : {}),
    },
  })
}

async function savedMachineForConnection(
  services: MachineToolServices,
  input: z.output<typeof savedMachineInputSchema> | z.output<typeof savedMachineNameInputSchema>,
  principal: PrincipalContext,
  signal: AbortSignal,
): Promise<WireResult<unknown>> {
  if (input.machineId !== undefined) {
    return await services.application.invoke('machine.get', { machineId: input.machineId }, principal, signal)
  }
  const listed = await services.application.invoke('machine.list', {}, principal, signal)
  if (!listed.ok) return listed
  const normalizedName = input.machineName.toLocaleLowerCase()
  const matches = machineProjectionSchema.array().parse(listed.value)
    .filter(machine => machine.name.toLocaleLowerCase() === normalizedName)
  if (matches.length === 1) return { ok: true, value: matches[0] }
  if (matches.length === 0) {
    return {
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: `No saved Machine has the exact name '${input.machineName}'.`,
        retryable: false,
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'STATE_CONFLICT',
      message: `More than one saved Machine has the exact name '${input.machineName}'; use machineId.`,
      retryable: false,
    },
  }
}

function registerTool(
  ctx: Context,
  definition: Parameters<Context['tools']['register']>[0],
): () => void {
  return ctx.tools.register(definition)
}

/** Register the complete model-facing surface of dsh-slop-machine. */
export function registerMachineTools(ctx: Context, services: MachineToolServices): () => void {
  const disposers = [
    registerTool(ctx, defineTool({
      name: 'slop_machine_list',
      description: 'List saved Machines. A Chat may use any number of Machines; never assume one current Machine. In Code Mode call this binding with an explicit empty object, then read the JSON envelope Machine array at result.value, not at the envelope root.',
      parameters: parameters({}),
      output: jsonOutputDefinition(machineListOutputSchema),
      presentCall: () => ({ card: 'generic', title: 'List saved Machines', kind: 'read' }),
      async execute(_args, execution) {
        return canonicalOutput(
          machineListOutputSchema,
          outputJson(await services.application.invoke('machine.list', {}, principalFor(execution), execution.signal)),
        )
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_machine_get',
      description: 'Read one saved Machine and its approved Machine Info operational context. Select the Machine explicitly by id. For SSH Machines, machine.sshIdlePolicy distinguishes the saved configured idle value from the effective runtime horizon; app-managed masters enforce the reported minimum. In Code Mode first require result.ok === true, then read result.value.machine and optional result.value.machineInfo; Machine fields are never at the envelope root.',
      parameters: parameters({ machineId: { type: 'string', description: 'Exact saved Machine id', required: true } }),
      output: jsonOutputDefinition(machineGetOutputSchema),
      presentCall: () => ({ card: 'generic', title: 'Read Machine Info', kind: 'read' }),
      async execute(args, execution) {
        const machineId = z.string().uuid().parse(args.machineId)
        return canonicalOutput(
          machineGetOutputSchema,
          await machineWithInfo(services, machineId, principalFor(execution), execution.signal),
        )
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_machine_connect',
      description: 'Register or correct a Machine from an accepted Setup Machine card, or connect an already saved Machine. For an existing Machine use exactly one of machineId or machineName; machineName requires one unique exact case-insensitive saved-name match. Do not pass setup-only fields for that path. With setup fields, this returns the exact machineId and requires an immediate second slop_machine_connect call with only that machineId. The connection call uses the protected inline SSH/2FA flow and resumes this same Chat when access is ready; successful readiness is exactly result.ok === true and result.value.kind === "ready". Its result.value.expiresAt is the reusable-connection horizon, not an individual command lease; result.value.readyAt is when that reusable connection became ready. In Code Mode do not look for status or state fields. A ready result includes sessionCheck from one fixed test command; when sessionCheck.ok is false, relay its message and run no other command on that Machine. Never ask for SSH secrets in ordinary Chat.',
      parameters: parameters({
        machineId: { type: 'string', description: 'Exact saved Machine id; for an existing Machine pass this alone' },
        machineName: { type: 'string', description: 'Exact saved Machine name; use alone only when it identifies one saved Machine' },
        machineAlias: { type: 'string', description: 'Setup-only alias; valid only together with sshTarget and the other Setup fields' },
        sshTarget: { type: 'string', description: 'Exact Setup card SSH target' },
        authentication: { type: 'json', description: 'Exact Setup card authentication object' },
        scheduler: { type: 'string', enum: ['slurm', 'pbs', 'none', 'unknown'], description: 'Exact Setup card scheduler choice' },
        paths: { type: 'json', description: 'Exact Setup card optional path object' },
      }),
      output: jsonOutputDefinition(machineConnectOutputSchema),
      presentCall: args => ({
        card: 'generic',
        title: typeof args.machineAlias === 'string' && args.machineAlias.trim().length > 0
          ? `Connect Machine · ${args.machineAlias.trim()}`
          : 'Connect saved Machine',
        kind: 'execute',
      }),
      async execute(args, execution) {
        const input = connectInputSchema.parse(args)
        const principal = principalFor(execution)
        if (input.sshTarget !== undefined) {
          const machine = await registerOrReuseMachine(
            services,
            input,
            principal,
            String(execution.callId),
            execution.signal,
          )
          return canonicalOutput(machineConnectOutputSchema, outputJson({
            ok: true,
            value: {
              phase: 'registered',
              machineId: machine.id,
              machineRevision: machine.revision,
              accessProfileRevision: machine.accessProfileRevision,
              requiredNextAction: {
                tool: 'slop_machine_connect',
                arguments: { machineId: machine.id },
              },
            },
          }))
        }
        const resolvedMachine = await savedMachineForConnection(services, input, principal, execution.signal)
        if (!resolvedMachine.ok) {
          return canonicalOutput(machineConnectOutputSchema, outputJson(resolvedMachine))
        }
        const machine = machineProjectionSchema.parse(resolvedMachine.value)
        const machineId = machineIdSchema.parse(machine.id)
        const connected = await services.application.invoke('connection.require', {
          machineId,
          purpose: 'remote-read',
          expectedMachineRevision: machine.revision,
          expectedAccessProfileRevision: machine.accessProfileRevision,
          toolCallId: String(execution.callId),
        }, principal, execution.signal)
        const ready = connected.ok && typeof connected.value === 'object' && connected.value !== null && (connected.value as { kind?: unknown }).kind === 'ready'
        return canonicalOutput(
          machineConnectOutputSchema,
          outputJson(ready
            ? { ...connected, value: { ...(connected.value as Record<string, unknown>), sessionCheck: await checkRemoteSession(services, machineId, execution.signal) } }
            : connected),
        )
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_machine_info_set',
      description: 'Save the exact user-approved initial Machine Info, or apply an explained update. Initial and material changes require explicit approval in the current Chat; small corrections need no prior approval but must still be explained.',
      parameters: parameters({
        mode: { type: 'string', enum: ['initial', 'update'], description: 'Whether this is the first save or an update', required: true },
        candidate: machineInfoCandidateInput,
        machineId: { type: 'string', description: 'Machine id for an update' },
        expectedRevision: { type: 'integer', description: 'Observed Machine Info revision for an update' },
        explanation: { type: 'string', description: 'Explanation already stated in Chat for an update' },
        changes: machineInfoChangesInput,
        userApprovedInCurrentChat: { type: 'boolean', description: 'True only after explicit current-Chat approval when required' },
      }),
      output: jsonOutputDefinition(machineInfoSetOutputSchema),
      presentCall: () => ({ card: 'generic', title: 'Save Machine Info', kind: 'edit' }),
      async execute(args, execution) {
        const mode = z.enum(['initial', 'update']).parse(args.mode)
        const principal = principalFor(execution)
        const validated = mode === 'initial'
          ? machineInfoCandidateSchema.safeParse(args.candidate)
          : machineInfoChangesSchema.safeParse(args.changes)
        if (!validated.success) {
          return canonicalOutput(machineInfoSetOutputSchema, outputJson({ ok: false, error: {
            code: 'INVALID_REQUEST', retryable: false,
            message: validated.error.issues.slice(0, 8).map(issue => `${mode === 'initial' ? 'candidate' : 'changes'}.${issue.path.join('.')}: ${issue.message}`).join('; '),
          } }))
        }
        const invalidPath = mode === 'initial'
          ? Object.values(machineInfoCandidateSchema.parse(args.candidate).setup.paths).find(path => path !== undefined && !isAbsoluteRemotePath(path))
          : machineInfoChangesSchema.parse(args.changes).find(change => change.kind === 'set-execution-path' && change.path !== undefined && !isAbsoluteRemotePath(change.path))
        if (invalidPath !== undefined) {
          return canonicalOutput(machineInfoSetOutputSchema, outputJson({ ok: false, error: {
            code: 'INVALID_REQUEST', retryable: false,
            message: 'Machine Info paths must be absolute, single-line remote paths. Resolve the user-provided path with slop_machine_shell discovery.phase=resolve-root before proposing and saving it.',
          } }))
        }
        const request = mode === 'initial'
          ? {
              candidate: args.candidate,
              userApprovedInCurrentChat: z.literal(true).parse(args.userApprovedInCurrentChat),
              idempotencyKey: `machine-info:initial:${String(execution.callId)}`,
            }
          : {
              machineId: z.string().uuid().parse(args.machineId),
              expectedRevision: z.number().int().positive().parse(args.expectedRevision),
              explanation: z.string().trim().min(1).max(4_096).parse(args.explanation),
              changes: args.changes,
              ...(args.userApprovedInCurrentChat === undefined
                ? {}
                : { userApprovedInCurrentChat: z.boolean().parse(args.userApprovedInCurrentChat) }),
              idempotencyKey: `machine-info:update:${String(execution.callId)}`,
            }
        return canonicalOutput(
          machineInfoSetOutputSchema,
          outputJson(await services.application.invoke(
            mode === 'initial' ? 'machineInfo.save' : 'machineInfo.update',
            request,
            principal,
            execution.signal,
          )),
        )
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_machine_transfer',
      description: 'Copy one regular file or directory between the Host and a saved Machine, or between two saved Machines through the Host. Remote-to-remote transfer uses native SFTP channels or scp -3: both SSH connections terminate on the Host and the Machines never connect to each other. Existing app-managed Machine SSH connections are reused. Respect the user\'s requested method or an established project transfer workflow when available and suitable; otherwise use this tool. Preserve pre-existing files and partial copies; clean up only this operation\'s temporary artifacts after verification. See project-work references/transfer.md for the workflow. Use absolute paths. For local-to-local use the native cp tool; for a copy within one remote Machine use slop_machine_shell. The Host does not stage payload data in a temporary file. Check result.ok, then require result.value.exitCode === 0 and result.value.timedOut === false.',
      parameters: parameters({
        source: {
          ...transferEndpointOutputSchema,
          description: 'Source endpoint: Host local path or saved Machine id plus remote path',
          required: true,
        },
        destination: {
          ...transferEndpointOutputSchema,
          description: 'Destination endpoint: Host local path or saved Machine id plus remote path',
          required: true,
        },
        timeoutMs: { type: 'integer', description: 'Optional end-to-end timeout in milliseconds' },
        protocol: { type: 'string', enum: ['sftp', 'scp'], description: 'Default sftp. Native Windows supports SFTP only. With an OpenSSH backend, use scp only when the server requires remote shell paths (for example a NAS whose SFTP root differs). No automatic fallback or retry; inspect partial copies first.' },
      }),
      output: transferOutputDefinition(),
      presentCall: args => ({
        card: 'terminal',
        title: `Transfer ${transferEndpointLabel(Reflect.get(args as object, 'source'))} ${transferEndpointLabel(Reflect.get(args as object, 'destination'))}`,
        description: 'Transfer file · Host relay',
      }),
      presentResult: transferResultPresentation,
      async execute(args, execution) {
        const input = transferInputSchema.parse(args)
        const callId = String(execution.callId)
        services.transferProgress?.start(callId)
        const principal = principalFor(execution)
        let failed = true
        try {
          const machineIds = [...new Set([input.source, input.destination]
            .filter((value): value is Extract<z.output<typeof transferEndpointSchema>, { kind: 'machine' }> => value.kind === 'machine')
            .map(value => value.machineId))]
          const machines = await Promise.all(machineIds.map(async machineId => machineProjectionSchema.parse(requireOk(
            await services.application.invoke('machine.get', { machineId }, principal, execution.signal),
          ))))
          for (const machine of machines) {
            const access = await services.application.invoke('connection.require', {
              machineId: machine.id,
              purpose: 'file-transfer',
              expectedMachineRevision: machine.revision,
              expectedAccessProfileRevision: machine.accessProfileRevision,
              toolCallId: callId,
            }, principal, execution.signal)
            if (!access.ok) return canonicalOutput(machineTransferOutputSchema, outputJson(access))
          }
          let result: Awaited<ReturnType<MachineTransferService['transfer']>>
          try {
            result = await services.machineTransferService.transfer({
              source: input.source,
              destination: input.destination,
              ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
              ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
              signal: execution.signal,
              onProgress: text => { services.transferProgress?.append(callId, text) },
            })
          } catch (error) {
            execution.signal.throwIfAborted()
            return canonicalOutput(machineTransferOutputSchema, outputJson({
              ok: false,
              error: {
                code: 'TRANSFER_FAILED',
                message: error instanceof Error ? error.message : 'Machine transfer failed.',
                retryable: false,
              },
            }))
          }
          failed = result.exitCode !== 0 || result.timedOut
          if (failed) {
            return canonicalOutput(machineTransferOutputSchema, outputJson({
              ok: false,
              error: {
                code: result.timedOut ? 'TRANSFER_TIMEOUT' : 'TRANSFER_FAILED',
                message: result.timedOut
                  ? 'The file transfer exceeded its timeout.'
                  : `File transfer failed with status ${result.exitCode ?? 'unknown'}.`,
                details: {
                  partialDestinationPossible: true,
                  exitCode: result.exitCode,
                  timedOut: result.timedOut,
                  signal: result.signal,
                  terminalOutput: result.terminalOutput,
                },
                retryable: result.timedOut,
              },
            }))
          }
          return canonicalOutput(machineTransferOutputSchema, outputJson({ ok: true, value: result }))
        } finally {
          services.transferProgress?.finish(callId, failed)
        }
      },
    })),
    registerTool(ctx, defineTool({
      name: 'slop_machine_shell',
      description: 'Run a shell command on one explicit saved Machine through its managed SSH connection. Use bounded native commands for listings and text; Python is appropriate for structured or scientific work. Results are capped at 12 KiB, including PTC; outputTruncated means the command ran, so never repeat a mutation to recover output. For discovery, load deep-discover: omit command and evidenceFiles for a host-generated page, or supply observed evidenceFiles. Resolve a supplied root with discovery.phase resolve-root before inventory. For project-read, workdir must equal projectPath. Read each result before choosing the next call. Check discoveryControl, exitCode, and timedOut. A timeout does not prove the remote process stopped. Keep secrets out of commands.',
      parameters: parameters({
        machineAlias: { type: 'string', description: 'Exact saved Machine alias for the human-readable trace; include it whenever known' },
        machineId: { type: 'string', description: 'Exact saved Machine id', required: true },
        command: { type: 'string', description: 'Exact remote shell command; mutually exclusive with evidenceFiles' },
        evidenceFiles: { type: 'array', items: { type: 'string' }, description: 'One to six observed text files; an absolute shared reference must remain within this Machine declared roots. The discovery guard rejects unobserved, secret, licensed, and large-result files.' },
        evidenceTerms: { type: 'array', items: { type: 'string' }, description: 'Optional one to eight unique literal terms copied from earlier model-visible evidence; valid only with evidenceFiles and used to focus an exact-reference repair' },
        workdir: { type: 'string', description: 'Optional exact remote working directory; use the declared work/project root when known instead of probing parent directories' },
        timeoutMs: { type: 'integer', description: 'Optional end-to-end timeout in milliseconds covering connection acquisition and remote execution' },
        discovery: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              properties: {
                phase: { type: 'string', const: 'resolve-root', required: true },
                root: { type: 'string', description: 'Exact user-provided absolute path or ~/path. Read-only resolution; no inventory or Machine Info save.', required: true },
                purpose: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              properties: {
                phase: { type: 'string', const: 'census', required: true },
                root: { type: 'string', description: 'Exact Machine-declared root', required: true },
                purpose: { type: 'string', description: 'One concrete census question', required: true },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                phase: { type: 'string', const: 'project-read', required: true },
                projectPath: { type: 'string', description: 'Exact direct-child or declared project path', required: true },
                purpose: { type: 'string', description: 'One concrete project question', required: true },
                selectionPlan: { type: 'array', items: { type: 'string' }, required: true, description: 'Ordered set of 1-12 exact project paths, frozen on first use.' },
                focus: { type: 'string', description: 'Observed relative workstream for a host-generated focused candidate page; omit for the initial project page.' },
              },
              additionalProperties: false,
            },
          ],
          description: 'Required only while deep-discover (or legacy machine-discovery) is active in the current turn.',
        },
      }),
      output: jsonOutputDefinition(machineShellOutputSchema),
      presentCall: args => ({
        card: 'terminal',
        title: typeof args.command === 'string' ? args.command : 'read selected evidence files',
        description: shellTraceLabel(args),
        ...(typeof args.workdir === 'string' ? { cwd: args.workdir } : {}),
      }),
      presentResult: shellResultPresentation,
      async execute(args, execution) {
        const rawInput = z.object({
          machineId: z.string().uuid(),
          machineAlias: z.string().trim().min(1).max(256).optional(),
          command: z.string().min(1).max(256 * 1024).optional(),
          evidenceFiles: z.array(z.string()).optional(),
          evidenceTerms: z.array(z.string()).optional(),
          workdir: z.string().min(1).max(8_192).optional(),
          timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1_000).optional(),
          discovery: machineDiscoveryMetadataSchema.optional(),
        }).strict().parse(args)
        const resolvingRoot = rawInput.discovery?.phase === 'resolve-root'
        if (resolvingRoot && (rawInput.command !== undefined || rawInput.workdir !== undefined || rawInput.evidenceFiles !== undefined || rawInput.evidenceTerms !== undefined || rawInput.timeoutMs === undefined || rawInput.timeoutMs > 20000)) {
          throw new Error('resolve-root requires timeoutMs <= 20000 and omits command, workdir, evidenceFiles and evidenceTerms.')
        }
        if (rawInput.command === undefined && rawInput.evidenceFiles?.length === 0) {
          return canonicalOutput(machineShellOutputSchema, outputJson({
            ok: false,
            error: {
              code: 'DISCOVERY_EVIDENCE_REQUIRED',
              message: 'No evidence files were selected. Omit this project request and preserve its unresolved fields as unknown.',
              retryable: false,
            },
          }))
        }
        const evidenceFiles = parseDiscoveryEvidenceFiles(rawInput.evidenceFiles)
        const evidenceTerms = parseDiscoveryEvidenceTerms(rawInput.evidenceTerms)
        const hasEvidenceFiles = rawInput.evidenceFiles !== undefined
        const hasEvidenceTerms = rawInput.evidenceTerms !== undefined
        const generatedPage = rawInput.command === undefined && !hasEvidenceFiles
          && (rawInput.discovery?.phase === 'census' || rawInput.discovery?.phase === 'project-read')
        if (!resolvingRoot && !generatedPage && ((rawInput.command === undefined) === !hasEvidenceFiles || (hasEvidenceFiles && evidenceFiles === undefined))) {
          throw new Error('Provide exactly one of command or 1-6 unique relative evidenceFiles.')
        }
        if (rawInput.discovery?.phase === 'project-read' && rawInput.discovery.focus !== undefined && !generatedPage) {
          throw new Error('focus is valid only for a host-generated project page.')
        }
        if (evidenceFiles !== undefined && rawInput.discovery?.phase !== 'project-read') {
          throw new Error('evidenceFiles requires project-read discovery metadata.')
        }
        if (hasEvidenceTerms && (evidenceFiles === undefined || evidenceTerms === undefined)) {
          throw new Error('evidenceTerms requires evidenceFiles and 1-8 unique bounded literal terms.')
        }
        const input = {
          ...rawInput,
          command: rawInput.discovery?.phase === 'resolve-root' ? resolveDiscoveryRootCommand(rawInput.discovery.root)
            : generatedPage ? rawInput.discovery?.phase === 'census' ? DISCOVERY_CENSUS_COMMAND
              : compileDiscoveryProjectPage(rawInput.discovery?.phase === 'project-read' ? rawInput.discovery.focus : undefined)
              : rawInput.command ?? compileDiscoveryEvidenceCommand(evidenceFiles ?? [], evidenceTerms),
          ...(evidenceFiles === undefined ? {} : { evidenceFiles }),
          ...(evidenceTerms === undefined ? {} : { evidenceTerms }),
        }
        const callSignal = deadlineSignal(execution.signal, input.timeoutMs)
        const principal = principalFor(execution)
        const machine = machineProjectionSchema.parse(requireOk(
          await services.application.invoke('machine.get', { machineId: input.machineId }, principal, execution.signal),
        ))
        if (input.machineAlias !== undefined && input.machineAlias !== machine.name) {
          throw new Error(`Machine alias '${input.machineAlias}' does not match saved Machine '${machine.name}'.`)
        }
        const requestBoundary = services.discoveryGuard?.inspectShellRequest?.(execution)
        if (requestBoundary !== undefined && requestBoundary.kind !== 'execute') {
          const selectionComplete = requestBoundary.kind === 'project-selection-complete'
          const duplicateSuppressed = requestBoundary.kind === 'duplicate-suppressed'
          const evidenceNotObserved = requestBoundary.kind === 'evidence-not-observed'
          const focusedRecoveryRequired = requestBoundary.kind === 'focused-recovery-required'
          return canonicalOutput(machineShellOutputSchema, shellOutput({
            kind: 'completed',
            machineId: machineIdSchema.parse(machine.id),
            machineRevision: machine.revision,
            accessProfileRevision: machine.accessProfileRevision,
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: '',
            stderr: '',
          }, machine.name, input.discovery, requestBoundary.budget, {
            kind: requestBoundary.kind,
            message: selectionComplete
              ? 'Twelve project paths are already selected. No remote command ran and no shell-attempt budget was consumed. Continue only with already-selected paths, then preserve and report.'
              : duplicateSuppressed
                ? 'An identical project read was already accepted. No remote command ran and no shell-attempt budget was consumed. Reuse the earlier result and continue without retrying.'
                  : evidenceNotObserved
                  ? `The rejected paths (${requestBoundary.unobservedPaths.join(', ')}) were not emitted by this project's earlier results. No remote command ran and no shell-attempt budget was consumed. Use only this project's returned paths listed in observedPaths, or run the documented candidate recovery stage.`
                  : focusedRecoveryRequired
                    ? 'A project workstream was emitted but no candidate file was returned. No remote command ran and no shell-attempt budget was consumed. Run the documented focused-workstream recovery before the whole-project fallback.'
                    : 'This project is outside the frozen selection plan. No remote command ran and no shell-attempt budget was consumed. Continue with the planned project paths and do not substitute another root.',
            ...(evidenceNotObserved
              ? {
                  unobservedPaths: requestBoundary.unobservedPaths,
                  observedPaths: requestBoundary.observedPaths,
                }
              : {}),
          }))
        }
        const access = await services.application.invoke('connection.require', {
          machineId: input.machineId,
          purpose: 'remote-read',
          expectedMachineRevision: machine.revision,
          expectedAccessProfileRevision: machine.accessProfileRevision,
          toolCallId: String(execution.callId),
        }, principal, callSignal)
        if (!access.ok) {
          return canonicalOutput(machineShellOutputSchema, outputJson(access))
        }
        const result = await services.machineService.execute({
          machineId: machineIdSchema.parse(input.machineId),
          command: input.command,
          ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          signal: callSignal,
        })
        if (resolvingRoot && result.exitCode === 0 && !result.timedOut && resolvedDiscoveryRoot(result.stdout) === undefined) {
          return canonicalOutput(machineShellOutputSchema, outputJson({ ok: false, error: { code: 'INVALID_ROOT_RESULT', message: 'Remote root resolution did not return one absolute directory. Check login-shell output before continuing.', retryable: false } }))
        }
        const discoveryBoundary = services.discoveryGuard?.inspectShellOutput?.(
          execution,
          result.stdout,
          result.stderr,
        )
        if (discoveryBoundary?.kind === 'reject-diagnostic') {
          return canonicalOutput(machineShellOutputSchema, outputJson({
            ok: false,
            error: {
              code: 'DISCOVERY_REMOTE_DIAGNOSTIC',
              message: 'Deep Discovery detected a remote shell or parser error even though the pipeline exit code was zero. Stop discovery for this turn; do not retry the command.',
              details: { diagnostic: discoveryBoundary.diagnostic },
              retryable: false,
            },
          }))
        }
        if (discoveryBoundary?.kind === 'reject-bounds') {
          return canonicalOutput(machineShellOutputSchema, outputJson({
            ok: false,
            error: {
              code: 'DISCOVERY_RESULT_BOUNDS',
              message: 'Deep Discovery output exceeded its current model-context budget. Narrow the exact evidence; do not repeat or broaden the command.',
              details: {
                observedBytes: discoveryBoundary.observedBytes,
                perCallLimitBytes: discoveryBoundary.perCallLimitBytes,
                remainingTurnBytes: discoveryBoundary.remainingTurnBytes,
              },
              retryable: false,
            },
          }))
        }
        return canonicalOutput(
          machineShellOutputSchema,
          shellOutput(
            result,
            machine.name,
            input.discovery,
            discoveryBoundary?.kind === 'accept' ? discoveryBoundary.budget : undefined,
          ),
        )
      },
    })),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
