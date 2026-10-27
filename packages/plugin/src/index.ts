import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { Config, validateConfig } from '@dsh-slop/runtime-base'
export { Config } from '@dsh-slop/runtime-base'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  asPrincipalId,
  InventoryService,
  MachineApplication,
  RelationalAuthority,
  type PrincipalContext,
  type SlopRemoteMethod,
} from '@dsh-slop/core'
import { createMachineHost } from '@dsh-slop/execution'
import { SlopApplicationService } from './application-service.ts'
import { MachineDiscoveryGuard } from './machine-discovery-guard.ts'
import { registerMachineTools } from './machine-tools.ts'
import { invokeBrowserRemote } from './remote-dispatch.ts'
import type { SlopRemoteRequest, SlopRemoteResult } from './remote-types.ts'
import { registerSetupMachineCommand, registerSetupMachineTool } from './setup-command.ts'
import { TransferProgressHub } from './transfer-progress.ts'
import { registerCapabilitySkills } from './capability-skills.ts'
import { registerOnboardingCommands } from './onboarding-commands.ts'
import { ProductWebSocketGateway, type ProductWebSocketRoute } from './websocket.ts'

export type { SlopJsonObject, SlopJsonValue, SlopRemoteFailure, SlopRemoteRequest, SlopRemoteResult } from './remote-types.ts'
export { SlopApplicationService, type SlopApplicationServiceConfig } from './application-service.ts'
export { registerSetupMachineCommand, registerSetupMachineTool } from './setup-command.ts'
export { MachineDiscoveryGuard, registerMachineDiscoveryGuard } from './machine-discovery-guard.ts'
export { registerMachineTools } from './machine-tools.ts'
export { DshQueueRuntime, queueSessionTargetForAgent } from './queue-runtime.ts'
export { DshQueueCommandRunner, DshQueueProbe } from './queue-probe.ts'
export { registerQueueTools } from './queue-tools.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    slopHostApi: SlopHostApi
    slopMachineExecution: Pick<import('@dsh-slop/execution').MachineService, 'execute'>
  }
}

export const name = 'slop-machine'
export const inject = ['slopRuntime', 'webServer', 'subprocess', 'agents', 'tools', 'systemPrompt', 'commands', 'skills']

interface SlopHostApiConfig {
  readonly trustedBrowserHosts: readonly string[]
  readonly transferProgress: TransferProgressHub
}

/** Browser transport for Machine settings, Knowledge settings, connection challenges, and protected 2FA. */
export class SlopHostApi extends TypertRemoteService {
  static inject = ['slopApplication', 'slopRuntime', 'webServer']

  private readonly nonce: string

  constructor(ctx: Context, private readonly config: SlopHostApiConfig) {
    super(ctx, 'slopHostApi', { namespace: 'slop' })
    this.nonce = ctx.slopRuntime.nonce

    const routes: readonly ProductWebSocketRoute[] = [
      {
        path: '/dsh-slop/events',
        auth: false,
        open: (principal, signal) => ctx.slopApplication.openFeed(principal, signal),
      },
      {
        path: '/dsh-slop/auth',
        auth: true,
        open: (principal, signal) => ctx.slopApplication.openAuthFlow(principal, signal),
      },
    ]
    const sockets = new ProductWebSocketGateway(
      this.nonce,
      this.localOwner(),
      routes,
      error => { ctx.logger.warn(error instanceof Error ? error : new Error(String(error))) },
      this.config.trustedBrowserHosts,
    )
    ctx.effect(() => () => sockets.close(), 'slop-host-api: Machine websocket sessions')
    for (const route of routes) {
      ctx.effect(() => ctx.webServer.registerUpgrade({
        path: route.path,
        handler: (request, socket, head) => { sockets.upgrade(route, request, socket, head) },
      }), `slop-host-api: ${route.path}`)
    }
  }

  private localOwner(): PrincipalContext {
    return { principalId: asPrincipalId('local-owner'), source: 'browser' }
  }

  private dispatch(
    method: SlopRemoteMethod,
    request: SlopRemoteRequest,
    signal: AbortSignal,
  ): Promise<SlopRemoteResult> {
    return invokeBrowserRemote(
      this.ctx.slopApplication,
      method,
      request,
      this.localOwner(),
      signal,
    ).then(result => structuredClone(result) as SlopRemoteResult)
  }

  @Remote('snapshot')
  snapshot(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('snapshot', request, signal)
  }

  @Remote('machine.list')
  machine_list(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('machine.list', request, signal)
  }

  @Remote('machine.get')
  machine_get(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('machine.get', request, signal)
  }

  @Remote('machine.archive')
  machine_archive(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('machine.archive', request, signal)
  }

  @Remote('hostTrust.decide')
  hostTrust_decide(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('hostTrust.decide', request, signal)
  }

  @Remote('authFlow.start')
  authFlow_start(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('authFlow.start', request, signal)
  }

  @Remote('authFlow.status')
  authFlow_status(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('authFlow.status', request, signal)
  }

  @Remote('authFlow.cancel')
  authFlow_cancel(request: SlopRemoteRequest, signal: AbortSignal): Promise<SlopRemoteResult> {
    return this.dispatch('authFlow.cancel', request, signal)
  }

  @Remote('transferProgress.get')
  transferProgress_get(request: SlopRemoteRequest): SlopRemoteResult {
    const callId = typeof request['callId'] === 'string' ? request['callId'] : ''
    if (callId.length === 0 || callId.length > 512) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'A valid transfer call id is required.', retryable: false } }
    }
    const snapshot = this.config.transferProgress.get(callId)
    return snapshot === undefined
      ? { ok: false, error: { code: 'NOT_FOUND', message: 'Transfer progress is not available.', retryable: true } }
      : { ok: true, value: { callId: snapshot.callId, status: snapshot.status, output: snapshot.output } }
  }
}

/** Install Machine operations and their scoped execution port. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const productHome = validateConfig(config)
  registerCapabilitySkills(ctx, 'machine')
  ctx.effect(() => registerSetupMachineCommand(ctx))
  ctx.effect(() => registerSetupMachineTool(ctx))
  ctx.effect(() => registerOnboardingCommands(ctx))
  ctx.systemPrompt.section({ name: 'slop:machine', order: 510, text: [
    'Machine setup is opt-in. Never open a Setup Machine card just because a session starts or the user greets you. Use existing saved Machines for ordinary work.',
    'For files that exist only on a remote Machine, write the filename or remote path in inline code. Do not make Markdown links, file: links, or local-open buttons for remote paths. Link a local copy only after verifying it was transferred to the Host.',
    'After a timed-out or interrupted remote command, its effects are uncertain. Inspect process/output state before retrying any mutation. Use a background process or scheduler plus Queue tracking for long-running work; choose timeoutMs to fit bounded foreground work.',
  ].join('\n') })
  const authority = await RelationalAuthority.open(resolve(config.dataRoot, 'authority'))
  const hostContext = ctx as Context & { subprocess: Parameters<typeof createMachineHost>[0]['subprocess'] }
  let machineHost: Awaited<ReturnType<typeof createMachineHost>> | undefined
  let machineApplication: MachineApplication | undefined
  const transferProgress = new TransferProgressHub()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await machineApplication?.close()
    await machineHost?.close()
    await authority.close()
  }

  try {
    machineHost = await createMachineHost({
      dataRoot: resolve(config.dataRoot, 'execution'),
      cwd: productHome,
      authority,
      subprocess: hostContext.subprocess,
    })
    const inventory = new InventoryService(authority)
    machineApplication = new MachineApplication({
      authority,
      inventory,
      connectionRuntime: machineHost.connectionRuntime,
      openAuthFlow: async (principal, signal) => await machineHost!.openAuthFlow(principal, signal),
    })
    await ctx.plugin(SlopApplicationService, { application: machineApplication, close })
    const discoveryGuard = new MachineDiscoveryGuard()
    ctx.effect(() => discoveryGuard.register(ctx), 'slop-host: Deep Discovery runtime guard')
    ctx.effect(() => registerMachineTools(ctx, {
      application: machineApplication!,
      machineService: machineHost!.machineService,
      machineTransferService: machineHost!.machineTransferService,
      transferProgress,
      discoveryGuard,
    }), 'slop-host: dsh-slop-machine tools')

    new MachineExecution(ctx, machineHost.machineService)
  } catch (error) {
    await close()
    throw error
  }

  await ctx.plugin(SlopHostApi, {
    trustedBrowserHosts: ctx.slopRuntime.trustedHosts,
    transferProgress,
  })
}

class MachineExecution extends Service {
  readonly execute: import('@dsh-slop/execution').MachineService['execute']
  constructor(ctx: Context, service: import('@dsh-slop/execution').MachineService) {
    super(ctx, 'slopMachineExecution')
    this.execute = service.execute.bind(service)
  }
}
