/** JSON-only request admitted by a host Remote before domain schema validation. */
export type SlopJsonValue = null | boolean | number | string | readonly SlopJsonValue[] | SlopJsonObject

/** JSON object boundary used by every method-specific core validator. */
export interface SlopJsonObject {
  readonly [key: string]: SlopJsonValue
}

/** Stable failure envelope exposed to the generated browser client. */
export interface SlopRemoteFailure {
  readonly code: string
  readonly message: string
  readonly subject?: string
  readonly details?: SlopJsonObject
  readonly retryable: boolean
}

/** JSON-safe mirror of core's canonical WireResult envelope. */
export type SlopRemoteResult =
  | { readonly ok: true; readonly value: SlopJsonValue }
  | { readonly ok: false; readonly error: SlopRemoteFailure }

/** Object-only request envelope; the core method schema remains authoritative. */
export type SlopRemoteRequest = SlopJsonObject
