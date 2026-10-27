import { z } from 'zod'

/** Version shared by persisted Machine authority records and projections. */
export const schemaVersionSchema = z.literal(1)

export type SchemaVersion = z.output<typeof schemaVersionSchema>
