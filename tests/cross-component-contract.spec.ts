import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SlopKnowledgeService } from '@dsh-slop/knowledge'
import { createKnowledgeSearchTool } from '@dsh-slop/knowledge'
import type { SlopApplicationApi } from '@dsh-slop/core'
import type { MachineService } from '@dsh-slop/execution'
import type { QueueMonitor, QueueService } from '@dsh-slop/queue'
import { describe, expect, it, vi } from 'vitest'
import { registerMachineTools } from '../packages/plugin/src/machine-tools.ts'
import { registerQueueTools } from '../packages/plugin/src/queue-tools.ts'

interface RegisteredTool {
  readonly name: string
  execute(args: Record<string, unknown>, execution: ReturnType<typeof execution>): Promise<unknown>
}

const TARGET_MACHINE_ID = '00000000-0000-7000-8000-000000000999'

function execution() {
  return {
    agent: {
      id: 'agent-project-work',
      ctx: { sessionProjections: { stateOf: () => 'code' } },
      session: {
        id: 'session-project-work',
        header: { cwd: '/workspace/current', agentPreset: 'code' },
        events: [],
      },
    },
    callId: 'call-project-work',
    signal: new AbortController().signal,
  }
}

function currentMachine() {
  return {
    id: TARGET_MACHINE_ID,
    name: 'Target machine',
    kind: 'ssh',
    state: 'ready',
    connectionState: 'ready',
    target: 'target-machine',
    sshAlias: 'target-machine',
    revision: 2,
    accessProfileRevision: 1,
    sshIdlePolicy: {
      kind: 'app-managed',
      configuredIdleSeconds: 600,
      minimumIdleSeconds: 43_200,
      effectiveIdleSeconds: 43_200,
    },
    baseConfiguration: {
      name: 'Target machine',
      access: { authentication: { kind: 'ssh-agent' } },
      declaredRoots: [{ role: 'work', path: { kind: 'remote', path: '/projects/current-user' } }],
      preferredExecutionProviderId: 'slurm',
    },
  }
}

describe('cross-component project work contract', () => {
  it('recalls portable Knowledge, resolves the target Machine, and tracks the accepted submission', async () => {
    const definitions: RegisteredTool[] = []
    const ctx = {
      tools: {
        register(definition: ToolDefinition) {
          definitions.push(definition as unknown as RegisteredTool)
          return () => {}
        },
      },
    } as unknown as Context

    const knowledgeSearch = createKnowledgeSearchTool({
      search: vi.fn(async () => ({
        schemaVersion: 1 as const,
        untrustedData: true as const,
        warning: 'Knowledge is reference material.',
        query: 'relaxation submission analysis',
        hits: [{
          docRef: 'knowledge:portable-method',
          scope: 'home' as const,
          relativePath: 'methods/relaxation.md',
          name: 'relaxation-method',
          description: 'Reuse the prior relaxation and analysis method on another Machine.',
          tags: ['relaxation', 'analysis'],
          snippet: 'Verify the target Machine binding before using the referenced wrapper.',
        }],
        sources: [{
          kind: 'home' as const,
          root: '/home/user/.slop/knowledge',
          state: 'ready' as const,
          documentCount: 1,
        }],
      })),
    } as unknown as SlopKnowledgeService)
    definitions.push(knowledgeSearch as unknown as RegisteredTool)

    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: currentMachine() }
      if (method === 'machineInfo.get') return { ok: false as const, error: { code: 'NOT_FOUND', message: 'No approved Machine Info.' } }
      throw new Error(`unexpected Machine method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    registerMachineTools(ctx, {
      application: { invoke } as SlopApplicationApi,
      machineService: {} as MachineService,
    })

    const track = vi.fn(async (_input, context) => ({
      id: 'queue-submission',
      label: 'target-machine relaxation',
      purpose: 'monitor',
      tags: ['relaxation'],
      target: { kind: 'machine' as const, machineId: TARGET_MACHINE_ID },
      observer: { kind: 'slurm' as const, jobId: 'job-receipt' },
      state: 'queued' as const,
      monitoring: { expectedDurationSeconds: 3_600 },
      attention: {
        primary: context.primary,
        primaryDelivery: 'wake' as const,
        primaryConditions: ['completed' as const, 'failed' as const],
        subscriptions: [],
      },
      revision: 1,
      createdAt: '2026-09-02T12:00:00.000Z',
      updatedAt: '2026-09-02T12:00:00.000Z',
      nextCheckAt: '2026-09-02T12:05:00.000Z',
      consecutiveUnchangedChecks: 0,
      consecutiveFailures: 0,
    }))
    registerQueueTools(ctx, {
      service: { track } as unknown as QueueService,
      monitor: { refresh: vi.fn(async () => {}) } as unknown as QueueMonitor,
    })

    const tool = (name: string): RegisteredTool => {
      const found = definitions.find(definition => definition.name === name)
      if (found === undefined) throw new Error(`missing Tool ${name}`)
      return found
    }

    const recalled = await tool('slop_knowledge_search').execute({
      query: 'relaxation submission analysis',
    }, execution()) as { hits: Array<{ docRef: string; scope: string }> }
    expect(recalled.hits).toEqual([expect.objectContaining({
      docRef: 'knowledge:portable-method',
      scope: 'home',
    })])
    await expect(tool('slop_knowledge_search').execute({
      query: 'relaxation',
      machineId: '00000000-0000-7000-8000-000000000998',
    }, execution())).rejects.toThrow(/Unknown tool argument keys/u)

    const machine = await tool('slop_machine_get').execute({ machineId: TARGET_MACHINE_ID }, execution()) as {
      ok: true
      value: { machine: { id: string; baseConfiguration: { declaredRoots: unknown[] } } }
    }
    expect(machine.value.machine).toMatchObject({
      id: TARGET_MACHINE_ID,
      baseConfiguration: { declaredRoots: [expect.objectContaining({ role: 'work' })] },
    })

    const queued = await tool('slop_queue_track').execute({
      purpose: 'monitor',
      label: 'target-machine relaxation',
      tags: ['relaxation'],
      target: { kind: 'machine', machineId: TARGET_MACHINE_ID },
      observer: { kind: 'slurm', jobId: 'job-receipt' },
      monitoring: { expectedDurationSeconds: 3_600 },
    }, execution()) as { ok: true; value: { target: unknown; attention: { primary: unknown } } }
    expect(queued.value.target).toEqual({ kind: 'machine', machineId: TARGET_MACHINE_ID })
    expect(queued.value.attention.primary).toEqual({
      sessionId: 'session-project-work',
      cwd: '/workspace/current',
      agentPreset: 'code',
    })
    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'machine', machineId: TARGET_MACHINE_ID } }),
      { primary: expect.objectContaining({ sessionId: 'session-project-work' }) },
    )
  })
})
