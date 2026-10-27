import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { registerOnboardingCommands } from '../src/onboarding-commands.ts'

describe('onboarding commands', () => {
  it('queues human requests on the receiving Agent and unregisters both commands', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const home = await mkdtemp(tmpdir() + '/slop-onboard-')
    onTestFinished(() => rm(home, { recursive: true, force: true }))
    const definitions: CommandDefinition[] = []
    const unregister = vi.fn()
    ctx.provide('commands', { register: (command: CommandDefinition) => { definitions.push(command); return unregister } })
    const dispose = registerOnboardingCommands(ctx, home)
    const followup = vi.fn()
    const inject = vi.fn()
    const agent = { followup, inject } as unknown as Agent
    for (const command of definitions) {
      await command.handler({ agent, rawInput: ' Research cluster', signal: new AbortController().signal, commandId: 'test' as never, attachments: [] })
    }
    expect(definitions.map(value => value.name)).toEqual(['onboard-slop', 'deep-discover'])
    expect(followup).toHaveBeenCalledTimes(2)
    expect(followup.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'user' }, content: [{ type: 'text', text: '/onboard-slop' }] })
    expect(inject.mock.calls[0]?.[0]).toMatchObject({ source: { kind: 'dsh-slop-onboarding', form: 'notice' }, content: [{ type: 'text', text: expect.stringContaining('"candidates":[]') }] })
    expect(followup.mock.calls[1]?.[0]).toMatchObject({ content: [{ text: expect.stringContaining('/deep-discover Research cluster') }] })
    dispose()
    expect(unregister).toHaveBeenCalledTimes(2)
  })
})
