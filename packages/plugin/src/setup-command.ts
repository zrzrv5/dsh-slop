import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Register the guided setup entry in DSH's own slash-command catalog. */
export function registerSetupMachineCommand(ctx: Context): () => void {
  return ctx.commands.register({
    name: 'setupmachine',
    description: 'Set up a compute machine in this Chat',
    handler: ({ agent }) => {
      // Use an ordinary turn: RC.2 reuses command-only sessions as blank.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: '/setupmachine' }], source: { kind: 'user' },
      }))
      return { kind: 'success', text: 'Machine setup requested in this Chat.' }
    },
  })
}

/**
 * Give the current Chat's model the same Chat-native setup entry point.
 * The Tool call is presentation-only: its durable call arguments prefill the
 * card, and the user must still select Connect before ordinary Chat work starts.
 */
export function registerSetupMachineTool(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'slop_setup_machine',
    description: 'Show the interactive Setup Machine card only when the user asks to add or configure a Machine. Never show it automatically for a new session, greeting, or existing Machine. Prefill only facts already established in the conversation. The user must select Connect; never claim that this Tool connects or saves a Machine.',
    parameters: {
      machineAlias: { type: 'string', description: 'Optional user-facing Machine alias' },
      sshTarget: { type: 'string', description: 'Optional SSH target in user@host or SSH config Host-alias form' },
      authentication: { type: 'string', enum: ['requires-2fa', 'passwordless-key'], description: 'Optional known authentication mode' },
      keyPath: { type: 'string', description: 'Optional local key path, only with passwordless-key authentication' },
      scheduler: { type: 'string', enum: ['slurm', 'pbs', 'none', 'unknown'], description: 'Optional known scheduler choice' },
      homePath: { type: 'string', description: 'Optional Home path' },
      workPath: { type: 'string', description: 'Optional Work path' },
      scratchPath: { type: 'string', description: 'Optional Scratch path' },
      customNotes: { type: 'string', description: 'Optional setup context already provided by the user' },
      deepDiscovery: { type: 'boolean', description: 'Optional Deep Discovery preference; omit unless the user requested it' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          schemaVersion: { type: 'integer', const: 1, required: true },
          awaitingUser: { type: 'boolean', const: true, required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    execute: async (): Promise<{ readonly schemaVersion: 1; readonly awaitingUser: true }> => ({
      schemaVersion: 1,
      awaitingUser: true,
    }),
  }))
}
