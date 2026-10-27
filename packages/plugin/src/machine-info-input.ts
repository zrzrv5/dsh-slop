import type { ParameterPropertySpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

const text = { type: 'string' } as const
const requiredText = { ...text, required: true } as const
const authentication = {
  oneOf: [
    { type: 'object', properties: { kind: { type: 'string', const: 'requires-2fa', required: true } }, additionalProperties: false },
    { type: 'object', properties: { kind: { type: 'string', const: 'passwordless-key', required: true }, localKeyFilePath: requiredText }, additionalProperties: false },
  ],
} satisfies ValueSchemaSpec
const scheduler = { type: 'string', enum: ['slurm', 'pbs', 'none', 'unknown'] } satisfies ValueSchemaSpec
const paths = { type: 'object', properties: { home: text, work: text, scratch: text }, additionalProperties: false } satisfies ValueSchemaSpec
const sectionFields = {
  kind: { type: 'string', enum: ['scheduler', 'paths', 'accounts', 'software', 'environment', 'workflow', 'other'], required: true },
  title: requiredText,
  content: requiredText,
} satisfies Record<string, ParameterPropertySpec>
const section = { type: 'object', properties: { id: requiredText, ...sectionFields }, additionalProperties: false } satisfies ValueSchemaSpec
const discovery = {
  type: 'object', properties: {
    summary: requiredText,
    operatingDefaults: { type: 'object', properties: { account: text, allocation: text, partition: text, queue: text }, additionalProperties: false, required: true },
    sections: { type: 'array', items: section, required: true },
  }, additionalProperties: false,
} satisfies ValueSchemaSpec

export const machineInfoCandidateInput = {
  type: 'object',
  description: 'Complete initial proposal shown to and approved by the user. Paths must be resolved absolute remote paths; use resolve-root before proposing a home-relative path.',
  properties: {
    schemaVersion: { type: 'integer', const: 1, required: true },
    machineId: requiredText,
    setup: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        machineAlias: text, sshTarget: requiredText,
        authentication: { ...authentication, required: true },
        scheduler: { ...scheduler, required: true },
        paths: { ...paths, required: true },
        discoveryProfile: { type: 'string', enum: ['ordinary', 'deep'], required: true },
      },
    },
    customNotes: requiredText,
    approvedDiscovery: { ...discovery, required: true },
  },
  additionalProperties: false,
} satisfies ParameterPropertySpec

function change(kind: string, properties: Record<string, ParameterPropertySpec>): ValueSchemaSpec {
  return { type: 'object', properties: { kind: { type: 'string', const: kind, required: true }, ...properties }, additionalProperties: false }
}

export const machineInfoChangesInput = {
  type: 'array', description: 'Typed updates to the observed revision. Omit an optional value to clear that field.',
  items: { oneOf: [
    change('set-machine-alias', { machineAlias: text }),
    change('append-custom-notes', { addition: requiredText }),
    change('add-discovery-section', { section: { ...section, required: true } }),
    change('correct-stale-discovery-section', { sectionId: requiredText, evidence: requiredText, replacement: { type: 'object', properties: sectionFields, additionalProperties: false, required: true } }),
    change('remove-stale-discovery-section', { sectionId: requiredText, evidence: requiredText }),
    change('set-ssh-target', { sshTarget: requiredText }),
    change('set-authentication', { authentication: { ...authentication, required: true } }),
    change('set-scheduler', { scheduler: { ...scheduler, required: true } }),
    change('set-execution-path', { role: { type: 'string', enum: ['home', 'work', 'scratch'], required: true }, path: { ...text, description: 'Resolved absolute remote path, or omit to clear.' } }),
    change('set-operating-default', { field: { type: 'string', enum: ['account', 'allocation', 'partition', 'queue'], required: true }, value: text }),
    change('replace-custom-notes', { customNotes: requiredText }),
    change('replace-approved-discovery', { approvedDiscovery: { ...discovery, required: true } }),
  ] },
} satisfies ParameterPropertySpec
