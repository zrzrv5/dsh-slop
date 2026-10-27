import type {} from '@deepseek-ai/dsh-tools'
import type { ConversationMatch, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { parseMachineInfoCardData, type MachineInfoCardData } from './MachineInfoCard.tsx'
import { parseSetupMachineChatSubmission, setupMachineSubmissionCallId } from './machine-setup-draft.ts'
import type { SetupMachineCardValues } from './machine-setup-types.ts'

/** Agent-provided prefill for one Setup Machine card in the current Chat. */
export interface SetupMachineChatData {
  readonly input: string
  readonly toolCallId: string
}

/** Invisible transcript marker for the user's structured Setup submission. */
export interface SetupMachineSubmissionChatData {
  readonly values: SetupMachineCardValues
  readonly messageId: string
}

/** Complete saved operational context emitted only after persistence. */
export interface MachineInfoChatData {
  readonly machineInfo: MachineInfoCardData
  readonly toolCallId: string
}

export type MachineConnectionTarget =
  | { readonly machineId: string; readonly machineName?: never }
  | { readonly machineId?: never; readonly machineName: string }

/** Exact Machine id or unique saved name requested by one protected Machine Tool call. */
export type MachineConnectionChatData = MachineConnectionTarget & {
  readonly toolCallId: string
  readonly settled: boolean
}

export interface MachineTransferProgressChatData {
  readonly toolCallId: string
  readonly machineIds: readonly string[]
  readonly settled: boolean
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'slop-setup-machine': SetupMachineChatData
    'slop-setup-machine-submission': SetupMachineSubmissionChatData
    'slop-machine-info': MachineInfoChatData
    'slop-machine-connection': MachineConnectionChatData
    'slop-machine-transfer-progress': MachineTransferProgressChatData
  }
}

interface SetupMachineState extends SetupMachineChatData {
  readonly anchorSeq: number
}

interface SetupMachineSubmissionState extends SetupMachineSubmissionChatData {
  readonly anchorSeq: number
}

type MachineInfoToolName = 'slop_machine_info_set'

interface MachineInfoState {
  readonly toolCallId: string
  readonly toolName: MachineInfoToolName
  readonly anchorSeq: number
  readonly resultSeq?: number
  readonly machineInfo?: MachineInfoCardData
}

type MachineConnectionState = MachineConnectionChatData & {
  readonly anchorSeq: number
}

type MachineTransferProgressState = MachineTransferProgressChatData & {
  readonly anchorSeq: number
}

const MACHINE_INFO_TOOLS: ReadonlySet<string> = new Set(['slop_machine_info_set'])
const MACHINE_CONNECTION_TOOLS: ReadonlySet<string> = new Set(['slop_machine_connect', 'slop_machine_shell'])
const MAX_SETUP_MACHINE_ARGUMENT_BYTES = 32 * 1_024

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

/** Keep only one bounded object-shaped prefill from the setup Tool call. */
export function setupMachineInputFromToolArguments(argumentsJson: string): string | undefined {
  if (new TextEncoder().encode(argumentsJson).byteLength > MAX_SETUP_MACHINE_ARGUMENT_BYTES) return undefined
  return asRecord(parseJson(argumentsJson)) === undefined ? undefined : argumentsJson
}

/** Decode only the exact top-level Machine id in protected Machine Tool arguments. */
export function machineIdFromConnectionArguments(argumentsJson: string): string | undefined {
  return boundedIdentity(asRecord(parseJson(argumentsJson))?.['machineId'])
}

/** Decode one exact top-level saved-Machine selector without accepting setup aliases. */
export function machineConnectionTargetFromArguments(argumentsJson: string): MachineConnectionTarget | undefined {
  const input = asRecord(parseJson(argumentsJson))
  const machineId = boundedIdentity(input?.['machineId'])
  const machineName = boundedIdentity(input?.['machineName'])
  if ((machineId === undefined) === (machineName === undefined)) return undefined
  if (machineId !== undefined) return { machineId }
  if (machineName !== undefined) return { machineName }
  return undefined
}

function toolCall(event: ConversationMatch['event']): { name: string; arguments: string; callId: string } | undefined {
  if (event.type === 'tool/call') return { ...event.data, callId: String(event.data.callId) }
  if (event.type === 'tool/ptc-dispatch-start') return {
    name: event.data.name,
    arguments: JSON.stringify(event.data.arguments),
    callId: String(event.data.subCallId),
  }
  return undefined
}

function toolResultWire(match: ConversationMatch): Readonly<Record<string, unknown>> | undefined {
  const event = match.event
  // Alpha.1 stores tool results as the ToolResultMessage's content directly;
  // the old nested `tool-result` block was removed from dsh-llm.
  const directContents = event.type === 'tool/ptc-dispatch' ? event.data.content
    : event.type === 'tool/result' ? event.data.message.content : undefined
  const legacyBlock = event.type === 'tool/result' ? event.data.message.content[0] as unknown as {
    type?: unknown
    content?: unknown
  } : undefined
  const contents = legacyBlock?.type === 'tool-result' && Array.isArray(legacyBlock.content)
    ? legacyBlock.content
    : directContents
  if (contents?.length !== 1) return undefined
  const content = contents[0]
  if (content?.type !== 'text') return undefined
  return asRecord(parseJson(content.text))
}

/** Decode only successful persisted values that require a Machine Info card. */
export function machineInfoFromToolResult(match: ConversationMatch, _toolName: MachineInfoToolName): MachineInfoCardData | undefined {
  const wire = toolResultWire(match)
  if (wire?.['schemaVersion'] !== 1 || wire['ok'] !== true) return undefined
  const value = asRecord(wire['value'])
  if (value === undefined) return undefined
  const card = asRecord(value['card'])
  if (card?.['kind'] !== 'emit-new-card') return undefined
  return parseMachineInfoCardData(value['machineInfo'])
}

function toolResultCallId(match: ConversationMatch): string | undefined {
  if (match.event.type === 'tool/ptc-dispatch') return boundedIdentity(match.event.data.subCallId)
  return match.event.type === 'tool/result' ? boundedIdentity(match.event.data.message.source.callId) : undefined
}

function transferMachineIds(argumentsJson: string): readonly string[] | undefined {
  const input = asRecord(parseJson(argumentsJson))
  if (input === undefined) return undefined
  const ids = new Set<string>()
  for (const endpoint of [asRecord(input['source']), asRecord(input['destination'])]) {
    if (endpoint?.['kind'] !== 'machine') continue
    const machineId = boundedIdentity(endpoint['machineId'])
    if (machineId === undefined) return undefined
    ids.add(machineId)
  }
  return [...ids]
}

function setupMachineSubmissionValues(event: ConversationMatch['event']): SetupMachineCardValues | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append' || event.data.source.kind !== 'user') return undefined
  if (event.data.content.length !== 1) return undefined
  const content = event.data.content[0]
  return content?.type === 'text' ? parseSetupMachineChatSubmission(content.text) : undefined
}

function setupSubmission(event: ConversationMatch['event']): { id: string; input: string } | undefined {
  if (setupMachineSubmissionValues(event) === undefined || event.type !== 'user/message') return undefined
  const block = event.data.content[0]
  if (block?.type !== 'text') return undefined
  const id = setupMachineSubmissionCallId(block.text)
  return id === undefined ? undefined : { id, input: block.text }
}

export const setupMachineChatDefinition: ConversationNodeDefinition<SetupMachineState> = {
  kind: 'slop-setup-machine',
  target: 'chat',
  match: event => {
    const submitted = setupSubmission(event)
    if (submitted !== undefined) return { id: submitted.id, role: 'update' }
    const call = toolCall(event)
    if (call?.name !== 'slop_setup_machine') return null
    return setupMachineInputFromToolArguments(call.arguments) === undefined
      ? null
      : { id: call.callId, role: 'start' }
  },
  start: (_context, match) => {
    const submitted = setupSubmission(match.event)
    if (submitted !== undefined) return { input: submitted.input, toolCallId: submitted.id, anchorSeq: match.event.seq }
    const call = toolCall(match.event)
    if (call === undefined) throw new Error('slop-setup-machine start requires a Tool call')
    const input = setupMachineInputFromToolArguments(call.arguments)
    if (input === undefined) throw new Error('slop-setup-machine requires bounded object arguments')
    return {
      input,
      toolCallId: call.callId,
      anchorSeq: match.event.seq,
    }
  },
  update: (context, match) => {
    const submitted = setupSubmission(match.event)
    return context.state === undefined || submitted === undefined ? context.state : { ...context.state, input: submitted.input }
  },
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'slop-setup-machine',
    id: context.state.toolCallId,
    target: 'chat',
    anchorSeq: context.state.anchorSeq + 0.01,
    // An actionable form must remain outside upstream's collapsed Tool steps.
    // The native call remains at its original location in the activity trace.
    location: { kind: 'session' },
    visibility: 'visible',
    data: {
      input: context.state.input,
      toolCallId: context.state.toolCallId,
    },
  }),
}

/**
 * Transcript-only projection for the tagged ordinary user message emitted by
 * Connect. The underlying user/message remains the model-visible Chat input.
 */
export const setupMachineSubmissionChatDefinition: ConversationNodeDefinition<SetupMachineSubmissionState> = {
  kind: 'slop-setup-machine-submission',
  target: 'chat',
  match: event => {
    if (setupMachineSubmissionValues(event) === undefined || event.type !== 'user/message') return null
    return { id: String(event.data.id), role: 'start' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw new Error('slop-setup-machine-submission start requires user/message')
    const values = setupMachineSubmissionValues(match.event)
    if (values === undefined) throw new Error('slop-setup-machine-submission requires a valid tagged submission')
    return {
      values,
      messageId: String(match.event.data.id),
      anchorSeq: match.event.seq,
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'slop-setup-machine-submission',
    id: context.state.messageId,
    target: 'chat',
    anchorSeq: context.state.anchorSeq + 0.001,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: {
      values: context.state.values,
      messageId: context.state.messageId,
    },
  }),
}

/** Saved Machine Info projection; small updates deliberately produce no card. */
export const machineInfoChatDefinition: ConversationNodeDefinition<MachineInfoState> = {
  kind: 'slop-machine-info',
  target: 'chat',
  match: event => {
    const call = toolCall(event)
    if (call !== undefined && MACHINE_INFO_TOOLS.has(call.name)) {
      return { id: call.callId, role: 'start' }
    }
    if (event.type === 'tool/ptc-dispatch') return { id: String(event.data.subCallId), role: 'update' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const call = toolCall(match.event)
    if (call === undefined || !MACHINE_INFO_TOOLS.has(call.name)) {
      throw new Error('slop-machine-info start requires a Machine Info Tool call')
    }
    const toolName = call.name
    if (toolName !== 'slop_machine_info_set') {
      throw new Error('slop-machine-info received an unknown Tool name')
    }
    return {
      toolCallId: call.callId,
      toolName,
      anchorSeq: match.event.seq,
    }
  },
  update: (context, match) => {
    if (toolResultCallId(match) !== context.state.toolCallId) return context.state
    const machineInfo = machineInfoFromToolResult(match, context.state.toolName)
    return {
      ...context.state,
      ...(machineInfo === undefined ? {} : { machineInfo }),
      resultSeq: match.event.seq,
    }
  },
  buildViewNode: context => context.state?.machineInfo === undefined ? null : ({
    key: context.key,
    kind: 'slop-machine-info',
    id: context.state.machineInfo.machineId,
    target: 'chat',
    anchorSeq: (context.state.resultSeq ?? context.state.anchorSeq) + 0.01,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data: {
      machineInfo: context.state.machineInfo,
      toolCallId: context.state.toolCallId,
    },
  }),
}

/**
 * Machine access presentation anchor. The call remains DSH-owned ordinary
 * Tool trace; the renderer independently follows the global projection.
 */
export const machineConnectionChatDefinition: ConversationNodeDefinition<MachineConnectionState> = {
  kind: 'slop-machine-connection',
  target: 'chat',
  match: event => {
    const call = toolCall(event)
    if (call !== undefined && MACHINE_CONNECTION_TOOLS.has(call.name)) {
      const target = machineConnectionTargetFromArguments(call.arguments)
      return target === undefined ? null : { id: call.callId, role: 'start' }
    }
    if (event.type === 'tool/ptc-dispatch') return { id: String(event.data.subCallId), role: 'update' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const call = toolCall(match.event)
    if (call === undefined) throw new Error('slop-machine-connection start requires a Tool call')
    const target = machineConnectionTargetFromArguments(call.arguments)
    if (target === undefined) throw new Error('slop-machine-connection requires exactly one saved Machine selector')
    return {
      ...target,
      toolCallId: call.callId,
      settled: false,
      anchorSeq: match.event.seq,
    }
  },
  update: (context, match) => toolResultCallId(match) === context.state.toolCallId
    ? { ...context.state, settled: true }
    : context.state,
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'slop-machine-connection',
    id: context.state.machineId ?? context.state.machineName,
    target: 'chat',
    anchorSeq: context.state.anchorSeq + 0.01,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: context.state.settled ? 'hidden' : 'visible',
    data: {
      ...(context.state.machineId === undefined
        ? { machineName: context.state.machineName }
        : { machineId: context.state.machineId }),
      toolCallId: context.state.toolCallId,
      settled: context.state.settled,
    },
  }),
}

/** Ephemeral native scp PTY viewport shown only while the Tool is running. */
export const machineTransferProgressChatDefinition: ConversationNodeDefinition<MachineTransferProgressState> = {
  kind: 'slop-machine-transfer-progress',
  target: 'chat',
  match: event => {
    const call = toolCall(event)
    if (call?.name === 'slop_machine_transfer') {
      return transferMachineIds(call.arguments) === undefined
        ? null
        : { id: call.callId, role: 'start' }
    }
    if (event.type === 'tool/ptc-dispatch') return { id: String(event.data.subCallId), role: 'update' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    const call = toolCall(match.event)
    if (call?.name !== 'slop_machine_transfer') {
      throw new Error('slop-machine-transfer-progress start requires a transfer Tool call')
    }
    const machineIds = transferMachineIds(call.arguments)
    if (machineIds === undefined) throw new Error('slop-machine-transfer-progress requires valid endpoints')
    return {
      toolCallId: call.callId,
      machineIds,
      settled: false,
      anchorSeq: match.event.seq,
    }
  },
  update: (context, match) => toolResultCallId(match) === context.state.toolCallId
    ? { ...context.state, settled: true }
    : context.state,
  buildViewNode: context => context.state === undefined ? null : ({
    key: context.key,
    kind: 'slop-machine-transfer-progress',
    id: context.state.toolCallId,
    target: 'chat',
    anchorSeq: context.state.anchorSeq + 0.005,
    location: context.start?.location ?? { kind: 'unresolved' },
    visibility: context.state.settled ? 'hidden' : 'visible',
    data: {
      toolCallId: context.state.toolCallId,
      machineIds: context.state.machineIds,
      settled: context.state.settled,
    },
  }),
}
