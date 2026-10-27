import { z } from 'zod'

const base = {
  runId: z.string().uuid(),
  jobId: z.string().regex(/^[A-Za-z0-9_.+\-[\]]{1,256}$/u),
  attempt: z.number().int().min(0).max(10_000),
  sequence: z.number().int().min(0).max(1_000_000),
  occurredAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }),
}

/** A bounded report about one explicitly registered execution, never a command. */
export const queueCallbackEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('started') }).strict(),
  z.object({ ...base, kind: z.literal('phase'), phase: z.string().regex(/^[A-Za-z0-9 _.:-]{1,128}$/u) }).strict(),
  z.object({ ...base, kind: z.literal('exited'), exitCode: z.number().int().min(0).max(255) }).strict(),
])
export type QueueCallbackEvent = z.output<typeof queueCallbackEventSchema>
