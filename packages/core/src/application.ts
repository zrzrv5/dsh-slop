import type { PrincipalId } from './primitives.ts'
import type { WireResult } from './schemas.ts'

/** Transport-owned identity for one browser, Agent, or host-system call. */
export interface PrincipalContext {
  readonly principalId: PrincipalId
  readonly source: 'browser' | 'agent' | 'system'
  readonly sessionId?: string
  readonly agentId?: string
  readonly presetId?: string
}

/** Uniform bidirectional adapter for a host WebSocket route. */
export interface SlopWebSocketSession<TFrame> {
  receive(frame: unknown): Promise<void>
  readonly frames: AsyncIterable<TFrame>
  close(): Promise<void>
}

/** Auth sessions carry opaque PTY bytes without storing them in Core. */
export interface SlopAuthWebSocketSession extends SlopWebSocketSession<unknown | Uint8Array> {
  receiveBinary(bytes: Uint8Array): Promise<void>
}

/** Closed Machine browser/tool vocabulary. Queue has its own package and tools. */
export const SLOP_REMOTE_METHODS = [
  'snapshot',
  'machine.list',
  'machine.get',
  'machine.create',
  'machine.update',
  'machine.archive',
  'machineInfo.get',
  'machineInfo.save',
  'machineInfo.update',
  'connection.require',
  'hostTrust.decide',
  'authFlow.start',
  'authFlow.status',
  'authFlow.cancel',
] as const

export type SlopRemoteMethod = (typeof SLOP_REMOTE_METHODS)[number]

/** Framework-independent host boundary for Machine browser, tool, and socket calls. */
export interface SlopApplicationApi {
  invoke(
    method: SlopRemoteMethod,
    request: unknown,
    principal: PrincipalContext,
    signal?: AbortSignal,
  ): Promise<WireResult<unknown>>
  openFeed(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopWebSocketSession<unknown>>
  openAuthFlow(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopAuthWebSocketSession>
  close(): Promise<void>
}
