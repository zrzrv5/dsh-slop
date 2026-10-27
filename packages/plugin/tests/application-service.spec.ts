import { Context } from '@deepseek-ai/cordis'
import type { PrincipalContext, SlopApplicationApi } from '@dsh-slop/core'
import { describe, expect, it, vi } from 'vitest'
import { SlopApplicationService } from '../src/application-service.ts'

describe('SlopApplicationService', () => {
  it('publishes the injected facade and owns its exact close lifecycle', async () => {
    const principal = {
      principalId: 'local-owner' as PrincipalContext['principalId'],
      source: 'system' as const,
    }
    const invoke = vi.fn(async () => ({ ok: true as const, value: { source: 'core' } }))
    const application = {
      invoke,
      openFeed: vi.fn(),
      openAuthFlow: vi.fn(),
      close: vi.fn(),
    } as unknown as SlopApplicationApi
    const close = vi.fn(async () => undefined)
    const ctx = new Context()
    const fiber = await ctx.plugin(SlopApplicationService, { application, close })

    await expect(ctx.slopApplication.invoke('machine.list', { limit: 5 }, principal)).resolves.toEqual({
      ok: true,
      value: { source: 'core' },
    })
    expect(invoke).toHaveBeenCalledWith('machine.list', { limit: 5 }, principal, undefined)

    await fiber.dispose()
    expect(close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
