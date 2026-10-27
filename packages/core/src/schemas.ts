import { z } from 'zod'
import type { JsonValue } from './canonical.ts'

/** JSON-compatible data accepted by authority records and tool results. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.string(),
  z.number().int().safe(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]))

/** Stable failures still reachable from Machine and its connection runtime. */
export const failureCodeSchema = z.enum([
  'INVALID_REQUEST',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'STATE_CONFLICT',
  'CAPABILITY_UNAVAILABLE',
  'HOST_KEY_REQUIRED',
  'HOST_KEY_CHANGED',
  'AUTH_REQUIRED',
  'CONNECTION_UNAVAILABLE',
  'CURSOR_EXPIRED',
  'RESYNC_REQUIRED',
  'STALE',
  'BOUNDS',
  'POLICY_DENIED',
  'CONNECTION_REQUIRED',
  'UNAVAILABLE',
  'CANCELLED',
  'INTERNAL',
])

export const failureSchema = z.object({
  code: failureCodeSchema,
  message: z.string().min(1).max(4_096),
  subject: z.string().min(1).max(512).optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), jsonValueSchema).optional(),
}).strict()

export const wireResultSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value }).strict(),
  z.object({ ok: z.literal(false), error: failureSchema }).strict(),
])

export type FailureCode = z.output<typeof failureCodeSchema>
export type Failure = z.output<typeof failureSchema>
export type WireResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure }
