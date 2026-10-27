import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  PrincipalContext,
  SlopApplicationApi,
  SlopAuthWebSocketSession,
  SlopRemoteMethod,
  SlopWebSocketSession,
  WireResult,
} from '@dsh-slop/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    slopApplication: SlopApplicationApi
  }
}

export interface SlopApplicationServiceConfig {
  readonly application: SlopApplicationApi
  readonly close: () => Promise<void>
}

/** Plugin-owned Cordis service wrapper around the framework-independent core. */
export class SlopApplicationService extends Service implements SlopApplicationApi {
  constructor(ctx: Context, private readonly config: SlopApplicationServiceConfig) {
    super(ctx, 'slopApplication')
    ctx.effect(() => () => config.close(), 'slopApplication.close')
  }

  invoke(method: SlopRemoteMethod, request: unknown, principal: PrincipalContext, signal?: AbortSignal): Promise<WireResult<unknown>> {
    return this.config.application.invoke(method, request, principal, signal)
  }

  openFeed(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopWebSocketSession<unknown>> {
    return this.config.application.openFeed(principal, signal)
  }

  openAuthFlow(principal: PrincipalContext, signal?: AbortSignal): Promise<SlopAuthWebSocketSession> {
    return this.config.application.openAuthFlow(principal, signal)
  }

  close(): Promise<void> {
    return this.config.close()
  }
}
