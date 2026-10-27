import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerSetupMachineCommand, registerSetupMachineTool } from '../src/setup-command.ts'

interface RegisteredCommand {
  name: string
  description: string
  input?: unknown
  handler(invocation: unknown): unknown
}

interface RegisteredTool {
  name: string
  description: string
  parameters: Readonly<Record<string, unknown>>
  execute(args: unknown, execution: unknown): Promise<unknown>
}

describe('Setup Machine Chat entry points', () => {
  it('starts an ordinary human turn so a setup session is not reused as blank', async () => {
    let definition: RegisteredCommand | undefined
    const dispose = vi.fn()
    const ctx = { commands: { register(value: RegisteredCommand) { definition = value; return dispose } } } as unknown as Context

    expect(registerSetupMachineCommand(ctx)).toBe(dispose)
    expect(definition).toMatchObject({
      name: 'setupmachine',
      description: 'Set up a compute machine in this Chat',
    })
    expect(definition?.input).toBeUndefined()
    const followup = vi.fn()
    expect(await definition?.handler({ agent: { followup } })).toEqual({ kind: 'success', text: 'Machine setup requested in this Chat.' })
    expect(followup).toHaveBeenCalledOnce()
    expect(followup.mock.calls[0]?.[0]).toMatchObject({ role: 'user', source: { kind: 'user' } })
  })

  it('registers one presentation-only Tool so the current model can show the same card', async () => {
    let definition: RegisteredTool | undefined
    const dispose = vi.fn()
    const ctx = {
      tools: {
        register(value: RegisteredTool) {
          definition = value
          return dispose
        },
      },
    } as unknown as Context

    expect(registerSetupMachineTool(ctx)).toBe(dispose)
    expect(definition).toMatchObject({
      name: 'slop_setup_machine',
      parameters: {
        type: 'object',
        properties: {
          machineAlias: expect.any(Object),
          sshTarget: expect.any(Object),
          authentication: expect.objectContaining({ enum: ['requires-2fa', 'passwordless-key'] }),
          scheduler: expect.objectContaining({ enum: ['slurm', 'pbs', 'none', 'unknown'] }),
          deepDiscovery: expect.any(Object),
        },
      },
    })
    expect(await definition?.execute({}, {})).toEqual({ schemaVersion: 1, awaitingUser: true })
  })

})
