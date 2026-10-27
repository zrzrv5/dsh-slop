import type { Context } from '@deepseek-ai/cordis'
import {
  jsonSchemaToTs,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import type { SlopApplicationApi } from '@dsh-slop/core'
import type { MachineService, MachineTransferService } from '@dsh-slop/execution'
import { describe, expect, it, vi } from 'vitest'
import type { MachineDiscoveryGuard } from '../src/machine-discovery-guard.ts'
import { machineDiscoveryMetadataSchema, registerMachineTools } from '../src/machine-tools.ts'

const MACHINE_ID = '00000000-0000-7000-8000-000000000321'

interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly output: ToolDefinition['output']
  presentCall?(args: Record<string, unknown>): unknown
  presentResult?(args: Record<string, unknown>, result: unknown): unknown
  execute(args: Record<string, unknown>, execution: ReturnType<typeof execution>): Promise<unknown>
}

function execution(callId = 'call-machine') {
  return {
    agent: { id: 'agent-machine', session: { id: 'session-machine' } },
    callId,
    signal: new AbortController().signal,
  }
}

function machine() {
  return {
    id: MACHINE_ID,
    name: 'Research cluster',
    kind: 'ssh',
    state: 'ready',
    connectionState: 'stale',
    target: 'alice@nova.example.org',
    username: 'alice',
    host: 'nova.example.org',
    revision: 1,
    accessProfileRevision: 1,
    sshIdlePolicy: {
      kind: 'app-managed',
      configuredIdleSeconds: 600,
      minimumIdleSeconds: 43_200,
      effectiveIdleSeconds: 43_200,
    },
    baseConfiguration: {
      name: 'Research cluster',
      access: { authentication: { kind: 'interactive' } },
      declaredRoots: [],
      preferredExecutionProviderId: 'slurm',
    },
  }
}

function fixture(
  invoke: SlopApplicationApi['invoke'],
  execute = vi.fn(),
  discoveryGuard?: Partial<Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'>>,
  transfer = vi.fn(),
) {
  const tools: RegisteredTool[] = []
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tools.push(definition as unknown as RegisteredTool)
        return () => {}
      },
    },
  } as unknown as Context
  registerMachineTools(ctx, {
    application: { invoke } as SlopApplicationApi,
    machineService: { execute } as unknown as MachineService,
    machineTransferService: { transfer } as unknown as MachineTransferService,
    ...(discoveryGuard === undefined ? {} : { discoveryGuard }),
  })
  return { tools, execute, transfer }
}

describe('Machine model tools', () => {
  it.each(['python3 script.py', 'cat huge.log'])('bounds canonical shell output for %s and preserves execution status', async command => {
    const invoke = vi.fn(async (method: string) => ({ ok: true, value: method === 'machine.get' ? machine() : { kind: 'ready' } })) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn(async () => ({ kind: 'completed', machineId: MACHINE_ID, machineRevision: 1, accessProfileRevision: 1, exitCode: 7, signal: null, timedOut: false, stdout: '科学\\\"\n'.repeat(20000), stderr: 'important diagnostic\n'.repeat(1000) }))
    const shell = fixture(invoke, execute).tools.find(tool => tool.name === 'slop_machine_shell')!
    const result = await shell.execute({ machineId: MACHINE_ID, command }, execution())
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(12 * 1024)
    expect(result).toMatchObject({ ok: true, value: { exitCode: 7, timedOut: false, outputTruncated: true, outputNotice: expect.stringContaining('already ran'), stderr: expect.stringContaining('important diagnostic') } })
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
    expect(execute).toHaveBeenCalledOnce()
  })
  it('registers the six Machine operations beside the separate setup Tool', () => {
    const { tools } = fixture(vi.fn())
    expect(tools.map(tool => tool.name)).toEqual([
      'slop_machine_list',
      'slop_machine_get',
      'slop_machine_connect',
      'slop_machine_info_set',
      'slop_machine_transfer',
      'slop_machine_shell',
    ])
    expect(tools.find(tool => tool.name === 'slop_machine_list')?.description).toContain('result.value')
    expect(tools.find(tool => tool.name === 'slop_machine_get')?.description).toContain('result.value.machine')
    expect(tools.find(tool => tool.name === 'slop_machine_connect')?.description).toContain('result.value.kind === "ready"')
    expect(tools.find(tool => tool.name === 'slop_machine_connect')?.description).toContain('machineId or machineName')
    expect(tools.find(tool => tool.name === 'slop_machine_connect')?.description).toContain('do not look for status or state fields')
    const shellParameters = JSON.stringify(tools.find(tool => tool.name === 'slop_machine_shell')?.parameters)
    expect(shellParameters).toContain('"selectionPlan"')
    expect(shellParameters).toContain('"required":["phase","projectPath","purpose","selectionPlan"]')
    expect(machineDiscoveryMetadataSchema.safeParse({
      phase: 'project-read',
      projectPath: '/work/alice/ProjectA',
      purpose: 'read project evidence',
    }).success).toBe(false)
  })

  it('projects canonical Machine result paths into the Code Mode TypeScript SDK', () => {
    const { tools } = fixture(vi.fn())
    const outputType = (name: string): string => {
      const tool = tools.find(candidate => candidate.name === name)
      if (tool === undefined) throw new Error(`missing tool ${name}`)
      return jsonSchemaToTs(tool.output.schema)
    }

    const list = outputType('slop_machine_list')
    expect(list).toContain('ok: true')
    expect(list).toContain('value:')
    expect(list).toContain('id: string')
    expect(list).toContain('name: string')
    expect(list).toContain('workPath?: string')
    expect(list).toContain('sshIdlePolicy?:')
    expect(list).toContain('effectiveIdleSeconds: number')
    expect(list).toContain('ok: false')

    const get = outputType('slop_machine_get')
    expect(get).toContain('machine:')
    expect(get).toContain('machineInfo?:')
    expect(get).toContain('minimumIdleSeconds: number')

    const connect = outputType('slop_machine_connect')
    expect(connect).toContain('kind: "ready"')
    expect(connect).toContain('readyAt: string')
    expect(connect).toContain('expiresAt: string')

    const shell = outputType('slop_machine_shell')
    expect(shell).toContain('exitCode: number | null')
    expect(shell).toContain('timedOut: boolean')
    expect(shell).toContain('stdout: string')
    expect(shell).toContain('discoveryBudget?:')
    expect(shell).toContain('shellAttemptsRemaining: number')
    expect(shell).toContain('selectedProjectPaths: number')
    expect(shell).toContain('discoveryControl:')
    expect(shell).toContain('| null')
    expect(shell).toContain('kind: "project-selection-complete"')
    expect(shell).toContain('kind: "duplicate-suppressed"')
    expect(shell).toContain('kind: "project-not-in-plan"')
    expect(shell).toContain('kind: "evidence-not-observed"')
    expect(shell).toContain('kind: "focused-recovery-required"')

    const transfer = outputType('slop_machine_transfer')
    expect(transfer).toContain('source:')
    expect(transfer).toContain('destination:')
    expect(transfer).toContain('relayedThroughHost: boolean')
    expect(transfer).toContain('terminalOutput: string')

    for (const tool of tools) expect(jsonSchemaToTs(tool.output.schema)).not.toBe('unknown')
  })

  it('transfers between two Machines only after both protected connection paths are ready', async () => {
    const secondMachineId = '00000000-0000-7000-8000-000000000322'
    const invoke = vi.fn(async (method: string, request: unknown) => {
      if (method === 'machine.get') {
        const machineId = (request as { machineId: string }).machineId
        return { ok: true as const, value: { ...machine(), id: machineId, name: machineId === MACHINE_ID ? 'Source' : 'Destination' } }
      }
      if (method === 'connection.require') return { ok: true as const, value: { kind: 'ready' } }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const transferRun = vi.fn(async () => ({
      kind: 'completed' as const,
      source: { kind: 'machine' as const, machineId: MACHINE_ID, path: '/work/result.tar' },
      destination: { kind: 'machine' as const, machineId: secondMachineId, path: '/scratch/result.tar' },
      entryKind: 'file' as const,
      relayedThroughHost: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      terminalOutput: 'result.tar  42%  4.2GB  80.1MB/s  00:52 ETA\r',
    }))
    const transfer = fixture(invoke, vi.fn(), undefined, transferRun).tools
      .find(tool => tool.name === 'slop_machine_transfer')!
    const args = {
      source: { kind: 'machine', machineId: MACHINE_ID, path: '/work/result.tar' },
      destination: { kind: 'machine', machineId: secondMachineId, path: '/scratch/result.tar' },
    }

    const result = await transfer.execute(args, execution('transfer-call'))

    expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual([
      'machine.get',
      'machine.get',
      'connection.require',
      'connection.require',
    ])
    expect(vi.mocked(invoke).mock.calls.filter(call => call[0] === 'connection.require').map(call => call[1])).toEqual([
      expect.objectContaining({ machineId: MACHINE_ID, purpose: 'file-transfer', toolCallId: 'transfer-call' }),
      expect.objectContaining({ machineId: secondMachineId, purpose: 'file-transfer', toolCallId: 'transfer-call' }),
    ])
    expect(transferRun).toHaveBeenCalledWith(expect.objectContaining({ source: args.source, destination: args.destination }))
    expect(validateJsonSchemaValue(transfer.output.schema, result)).toEqual([])
    const rendered = transfer.output.render(args, result as never)
    expect(rendered[0]).toMatchObject({ type: 'text' })
    expect((rendered[0] as { text: string }).text).not.toContain('terminalOutput')
    const meta = transfer.output.presentationMeta?.(args, result as never)
    expect(transfer.presentResult?.(args, { content: rendered, isError: false, meta })).toMatchObject({
      card: 'terminal',
      output: expect.stringContaining('42%'),
      exitCode: 0,
    })
  })

  it('returns a typed transfer failure while retaining native scp diagnostics for its terminal card', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') return { ok: true as const, value: { kind: 'ready' } }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const transferRun = vi.fn(async () => ({
      kind: 'completed' as const,
      source: { kind: 'local' as const, path: '/tmp/missing.bin' },
      destination: { kind: 'machine' as const, machineId: MACHINE_ID, path: '/scratch/missing.bin' },
      entryKind: 'file' as const,
      relayedThroughHost: false,
      exitCode: 1,
      signal: null,
      timedOut: false,
      terminalOutput: 'scp: stat local "/tmp/missing.bin": No such file or directory\r\n',
    }))
    const transfer = fixture(invoke, vi.fn(), undefined, transferRun).tools
      .find(tool => tool.name === 'slop_machine_transfer')!
    const args = {
      protocol: 'scp',
      source: { kind: 'local', path: '/tmp/missing.bin' },
      destination: { kind: 'machine', machineId: MACHINE_ID, path: '/scratch/missing.bin' },
    }

    const result = await transfer.execute(args, execution('transfer-failure'))
    expect(transferRun).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'scp' }))

    expect(result).toMatchObject({ ok: false, error: { code: 'TRANSFER_FAILED', retryable: false } })
    expect(JSON.stringify(transfer.output.render(args, result as never))).toContain('No such file or directory')
    expect(validateJsonSchemaValue(transfer.output.schema, result)).toEqual([])
    const rendered = transfer.output.render(args, result as never)
    const meta = transfer.output.presentationMeta?.(args, result as never)
    expect(transfer.presentResult?.(args, { content: rendered, isError: false, meta })).toMatchObject({
      card: 'terminal',
      output: expect.stringContaining('No such file'),
      exitCode: 1,
    })
  })

  it.each(['x', '汉字', '\u001b[1m\r'])('preserves timeout status with oversized %s progress', async (chunk) => {
    const invoke = vi.fn(async (method: string) => method === 'machine.get'
      ? { ok: true, value: machine() } : { ok: true, value: { kind: 'ready' } }) as unknown as SlopApplicationApi['invoke']
    const terminalOutput = chunk.repeat(140_000)
    const transfer = fixture(invoke, vi.fn(), undefined, vi.fn(async () => ({
      exitCode: null, signal: 'SIGTERM', timedOut: true, terminalOutput,
    }))).tools.find(tool => tool.name === 'slop_machine_transfer')!
    const args = { source: { kind: 'local', path: '/tmp/data' }, destination: { kind: 'machine', machineId: MACHINE_ID, path: '/work/data' } }
    const result = await transfer.execute(args, execution('large-timeout'))
    const rendered = transfer.output.render(args, result as never)
    expect(JSON.stringify(rendered)).toContain('TRANSFER_TIMEOUT')
    expect(JSON.stringify(rendered)).not.toContain('terminalOutput')
    expect(JSON.stringify(rendered)).toContain('partialDestinationPossible')
    expect(Buffer.byteLength(JSON.stringify(rendered))).toBeLessThan(4096)
    expect(transfer.output.presentationMeta?.(args, result as never)).toMatchObject({ terminalOutput, signal: 'SIGTERM' })
  })

  it('reports missing Machine Info fields without invoking the authority', async () => {
    const invoke = vi.fn()
    const tool = fixture(invoke).tools.find(tool => tool.name === 'slop_machine_info_set')!
    await expect(tool.execute({ mode: 'initial', candidate: { workPath: '~/Documents' }, userApprovedInCurrentChat: true }, execution())).rejects.toThrow('candidate.schemaVersion')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('resolves a home-relative root with only a quoted host-built lookup', async () => {
    const invoke = vi.fn(async (method: string) => method === 'machine.get'
      ? { ok: true, value: machine() } : { ok: true, value: { kind: 'ready' } }) as unknown as SlopApplicationApi['invoke']
    const run = vi.fn(async () => ({ kind: 'completed', machineId: MACHINE_ID, machineRevision: 1, accessProfileRevision: 1, exitCode: 0, signal: null, timedOut: false, stdout: '/home/alice/Documents\n', stderr: '' }))
    const tool = fixture(invoke, run).tools.find(tool => tool.name === 'slop_machine_shell')!
    const args = { machineId: MACHINE_ID, timeoutMs: 20000, discovery: { phase: 'resolve-root', root: '~/Documents', purpose: 'Resolve requested directory' } }
    const result = await tool.execute(args, execution())
    expect(result).toMatchObject({ ok: true, value: { stdout: '/home/alice/Documents\n' } })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ command: 'cd -- "$HOME"/\'Documents\' && pwd -P' }))
    await expect(tool.execute({ ...args, command: 'touch /tmp/wrong' }, execution())).rejects.toThrow('omits command')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('returns a typed transfer failure when endpoint validation fails before scp starts', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') return { ok: true as const, value: { kind: 'ready' } }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const transferRun = vi.fn(async () => {
      throw new Error('The local source must be a regular file or directory.')
    })
    const transfer = fixture(invoke, vi.fn(), undefined, transferRun).tools
      .find(tool => tool.name === 'slop_machine_transfer')!

    const result = await transfer.execute({
      source: { kind: 'local', path: '/tmp/not-a-regular-entry' },
      destination: { kind: 'machine', machineId: MACHINE_ID, path: '/scratch/result.bin' },
    }, execution('transfer-preflight-failure'))

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'TRANSFER_FAILED',
        message: 'The local source must be a regular file or directory.',
        retryable: false,
      },
    })
    expect(validateJsonSchemaValue(transfer.output.schema, result)).toEqual([])
  })

  it('turns one accepted setup into a saved Machine and an explicit protected connect continuation', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.list') return { ok: true as const, value: [] }
      if (method === 'machine.create') return { ok: true as const, value: machine() }
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') {
        return {
          ok: true as const,
          value: {
            kind: 'ready',
            machineId: MACHINE_ID,
            machineRevision: 1,
            accessProfileRevision: 1,
            readyAt: '2026-09-02T00:00:00.000Z',
            expiresAt: '2026-09-02T12:00:00.000Z',
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const connect = fixture(invoke).tools.find(tool => tool.name === 'slop_machine_connect')!
    const registered = await connect.execute({
      machineAlias: 'Research cluster',
      sshTarget: 'alice@nova.example.org',
      authentication: { kind: 'requires-2fa' },
      scheduler: 'slurm',
      paths: { work: '/work/alice' },
    }, execution('connect-register'))
    expect(registered).toMatchObject({
      schemaVersion: 1,
      ok: true,
      value: {
        phase: 'registered',
        machineId: MACHINE_ID,
        requiredNextAction: { tool: 'slop_machine_connect', arguments: { machineId: MACHINE_ID } },
      },
    })

    const connected = await connect.execute({ machineId: MACHINE_ID }, execution('connect-auth'))
    expect(connected).toMatchObject({ schemaVersion: 1, ok: true, value: { kind: 'ready' } })
    expect(validateJsonSchemaValue(connect.output.schema, registered)).toEqual([])
    expect(validateJsonSchemaValue(connect.output.schema, connected)).toEqual([])
    expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual([
      'machine.list',
      'machine.create',
      'machine.get',
      'connection.require',
    ])
    expect(vi.mocked(invoke).mock.calls[3]?.[1]).toMatchObject({
      machineId: MACHINE_ID,
      toolCallId: 'connect-auth',
    })
  })

  it('runs arbitrary remote shell only after the protected connection path and preserves raw output', async () => {
    const calls: string[] = []
    const invoke = vi.fn(async (method: string) => {
      calls.push(method)
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') {
        return {
          ok: true as const,
          value: {
            kind: 'ready',
            machineId: MACHINE_ID,
            machineRevision: 1,
            accessProfileRevision: 1,
            readyAt: '2026-09-02T00:00:00.000Z',
            expiresAt: '2026-09-02T12:00:00.000Z',
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn(async () => {
      calls.push('machine.execute')
      return {
        kind: 'completed',
        machineId: MACHINE_ID,
        machineRevision: 1,
        accessProfileRevision: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'export TOKEN=unredacted\nraw shell history\n',
        stderr: '',
      }
    })
    const shell = fixture(invoke, execute).tools.find(tool => tool.name === 'slop_machine_shell')!
    const result = await shell.execute({
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: 'history -10',
      workdir: '/work/alice',
    }, execution('shell-call'))
    expect(calls).toEqual(['machine.get', 'connection.require', 'machine.execute'])
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      machineId: MACHINE_ID,
      command: 'history -10',
      workdir: '/work/alice',
    }))
    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      value: { machineAlias: 'Research cluster', stdout: 'export TOKEN=unredacted\nraw shell history\n' },
    })
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
    expect(shell.presentCall?.({
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: 'history -10',
      workdir: '/work/alice',
    })).toMatchObject({
      card: 'terminal',
      title: 'history -10',
      description: 'Remote shell · Research cluster',
      cwd: '/work/alice',
    })
    expect(shell.presentResult?.({
      machineAlias: 'Research cluster',
      machineId: MACHINE_ID,
      command: 'history -10',
    }, {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, value: { stdout: 'raw shell history\n', stderr: '', exitCode: 0, signal: null } }),
      }],
      isError: false,
    })).toMatchObject({
      card: 'terminal',
      title: 'history -10',
      output: 'raw shell history\n',
      exitCode: 0,
    })
  })

  it('applies timeoutMs to protected connection acquisition before remote execution', async () => {
    const invoke = vi.fn(async (
      method: string,
      _request: unknown,
      _principal: unknown,
      signal?: AbortSignal,
    ) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method !== 'connection.require') throw new Error(`unexpected method ${method}`)
      if (signal === undefined) throw new Error('connection acquisition requires a deadline signal')
      return await new Promise((resolve) => {
        const timedOut = (): void => resolve({
          ok: false as const,
          error: {
            code: 'CONNECTION_TIMEOUT',
            message: 'Connection acquisition exceeded the shell deadline.',
            retryable: false,
          },
        })
        if (signal.aborted) timedOut()
        else signal.addEventListener('abort', timedOut, { once: true })
      })
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn()
    const shell = fixture(invoke, execute).tools.find(tool => tool.name === 'slop_machine_shell')!

    await expect(shell.execute({
      machineId: MACHINE_ID,
      command: 'hostname',
      timeoutMs: 20,
    }, execution('connection-deadline'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONNECTION_TIMEOUT' },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('compiles structured discovery evidence files into one bounded quoted command', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') return { ok: true as const, value: { kind: 'ready' } }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn(async () => ({
      kind: 'completed',
      machineId: MACHINE_ID,
      machineRevision: 1,
      accessProfileRevision: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'FILE|./note.md\n',
      stderr: '',
    }))
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'> = {
      inspectShellRequest: () => ({ kind: 'execute' }),
      inspectShellOutput: () => ({
        kind: 'accept',
        budget: {
          shellAttemptsUsed: 7,
          shellAttemptsRemaining: 25,
          selectedProjectPaths: 3,
          turnOutputBytesRemaining: 240_000,
        },
      }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools.find(tool => tool.name === 'slop_machine_shell')!
    const result = await shell.execute({
      machineId: MACHINE_ID,
      evidenceFiles: ['./note.md', "./branch/driver's.py"],
      evidenceTerms: ['submit_stage_batch', "worker's command"],
      workdir: '/work/alice/ProjectA',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'read selected evidence',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('structured-evidence'))

    expect(result).toMatchObject({
      ok: true,
      value: {
        discoveryBudget: {
          shellAttemptsUsed: 7,
          shellAttemptsRemaining: 25,
          selectedProjectPaths: 3,
          turnOutputBytesRemaining: 240_000,
        },
      },
    })
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])

    const command = vi.mocked(execute).mock.calls[0]?.[0].command
    expect(command).toContain("'./note.md'")
    expect(command).toContain("'./branch/driver'\"'\"'s.py'")
    expect(command).toContain('grep -Fin')
    expect(command).toContain("-e 'submit_stage_batch'")
    expect(command).toContain("-e 'worker'\"'\"'s command'")
    expect(command).toContain("printf 'FILE|%s\\n'")
    expect(command).toContain("printf 'EVIDENCE|%s\\n'")
    expect(command).toContain('head -n 64')
    await expect(shell.execute({
      machineId: MACHINE_ID,
      command: 'hostname',
      evidenceFiles: ['./note.md'],
      workdir: '/work/alice/ProjectA',
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'invalid mixed mode',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('mixed-evidence'))).rejects.toThrow(/exactly one/u)
    await expect(shell.execute({
      machineId: MACHINE_ID,
      evidenceFiles: ['./note.md'],
      evidenceTerms: ['bad\nterm'],
      workdir: '/work/alice/ProjectA',
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'invalid focused evidence',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('invalid-evidence-term'))).rejects.toThrow(/evidenceTerms/u)
  })

  it('returns a successful local control result for a thirteenth project without remote execution', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn()
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'> = {
      inspectShellRequest: () => ({
        kind: 'project-selection-complete',
        budget: {
          shellAttemptsUsed: 27,
          shellAttemptsRemaining: 5,
          selectedProjectPaths: 12,
          turnOutputBytesRemaining: 200_000,
        },
      }),
      inspectShellOutput: () => ({ kind: 'accept' }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools
      .find(tool => tool.name === 'slop_machine_shell')!

    const result = await shell.execute({
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: '/work/alice/Project13',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/Project13',
        purpose: 'select another project',
        selectionPlan: ['/work/alice/Project13'],
      },
    }, execution('selection-complete'))

    expect(result).toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        stdout: '',
        discoveryBudget: { shellAttemptsUsed: 27, selectedProjectPaths: 12 },
        discoveryControl: { kind: 'project-selection-complete' },
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
  })

  it('returns a successful local control result for a duplicate project read without remote execution', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn()
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'> = {
      inspectShellRequest: () => ({
        kind: 'duplicate-suppressed',
        budget: {
          shellAttemptsUsed: 8,
          shellAttemptsRemaining: 24,
          selectedProjectPaths: 4,
          turnOutputBytesRemaining: 220_000,
        },
      }),
      inspectShellOutput: () => ({ kind: 'accept' }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools
      .find(tool => tool.name === 'slop_machine_shell')!

    const result = await shell.execute({
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: '/work/alice/ProjectA',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'read selected project evidence',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('duplicate-suppressed'))

    expect(result).toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        stdout: '',
        discoveryBudget: { shellAttemptsUsed: 8, selectedProjectPaths: 4 },
        discoveryControl: { kind: 'duplicate-suppressed' },
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
  })

  it('returns a successful local control result for unobserved project evidence', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn()
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'> = {
      inspectShellRequest: () => ({
        kind: 'evidence-not-observed',
        unobservedPaths: ['./other-project/run.sh'],
        observedPaths: ['./run.sh', './run.py'],
        budget: {
          shellAttemptsUsed: 9,
          shellAttemptsRemaining: 23,
          selectedProjectPaths: 4,
          turnOutputBytesRemaining: 220_000,
        },
      }),
      inspectShellOutput: () => ({ kind: 'accept' }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools
      .find(tool => tool.name === 'slop_machine_shell')!

    const result = await shell.execute({
      machineId: MACHINE_ID,
      evidenceFiles: ['./other-project/run.sh'],
      workdir: '/work/alice/ProjectA',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'read selected project evidence',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('evidence-not-observed'))

    expect(result).toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        stdout: '',
        discoveryBudget: { shellAttemptsUsed: 9, selectedProjectPaths: 4 },
        discoveryControl: {
          kind: 'evidence-not-observed',
          unobservedPaths: ['./other-project/run.sh'],
          observedPaths: ['./run.sh', './run.py'],
        },
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
  })

  it('returns a successful local control result when focused recovery is required', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn()
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'> = {
      inspectShellRequest: () => ({
        kind: 'focused-recovery-required',
        budget: {
          shellAttemptsUsed: 9,
          shellAttemptsRemaining: 23,
          selectedProjectPaths: 4,
          turnOutputBytesRemaining: 220_000,
        },
      }),
      inspectShellOutput: () => ({ kind: 'accept' }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools
      .find(tool => tool.name === 'slop_machine_shell')!

    const result = await shell.execute({
      machineId: MACHINE_ID,
      command: "find . -mindepth 1 -maxdepth 3 -type f -printf 'FOCUSED|%p\\n' | head -n 40",
      workdir: '/work/alice/ProjectA',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'recover whole-project candidates',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('focused-recovery-required'))

    expect(result).toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        stdout: '',
        discoveryBudget: { shellAttemptsUsed: 9, selectedProjectPaths: 4 },
        discoveryControl: { kind: 'focused-recovery-required' },
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
  })

  it('returns a successful local control result for a project outside the frozen plan', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn()
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellRequest' | 'inspectShellOutput'> = {
      inspectShellRequest: () => ({
        kind: 'project-not-in-plan',
        budget: {
          shellAttemptsUsed: 6,
          shellAttemptsRemaining: 26,
          selectedProjectPaths: 3,
          turnOutputBytesRemaining: 220_000,
        },
      }),
      inspectShellOutput: () => ({ kind: 'accept' }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools
      .find(tool => tool.name === 'slop_machine_shell')!

    const result = await shell.execute({
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: '/work/alice/ProjectC',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectC',
        purpose: 'read an unplanned project',
        selectionPlan: ['/work/alice/ProjectA', '/work/alice/ProjectB'],
      },
    }, execution('outside-plan'))

    expect(result).toMatchObject({
      ok: true,
      value: {
        exitCode: 0,
        discoveryBudget: { shellAttemptsUsed: 6, selectedProjectPaths: 3 },
        discoveryControl: { kind: 'project-not-in-plan' },
      },
    })
    expect(execute).not.toHaveBeenCalled()
    expect(validateJsonSchemaValue(shell.output.schema, result)).toEqual([])
  })

  it('turns an empty discovery evidence selection into a non-retryable no-op', async () => {
    const invoke = vi.fn()
    const execute = vi.fn()
    const shell = fixture(invoke, execute).tools.find(tool => tool.name === 'slop_machine_shell')!

    await expect(shell.execute({
      machineId: MACHINE_ID,
      evidenceFiles: [],
      workdir: '/work/alice/ProjectA',
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: '/work/alice/ProjectA',
        purpose: 'read selected evidence',
        selectionPlan: ['/work/alice/ProjectA'],
      },
    }, execution('empty-evidence'))).resolves.toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: {
        code: 'DISCOVERY_EVIDENCE_REQUIRED',
        retryable: false,
      },
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('connects one uniquely named saved Machine without copying its opaque id', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.list') return { ok: true as const, value: [machine()] }
      if (method === 'connection.require') {
        return {
          ok: true as const,
          value: {
            kind: 'ready',
            machineId: MACHINE_ID,
            machineRevision: 1,
            accessProfileRevision: 1,
            readyAt: '2026-09-02T00:00:00.000Z',
            expiresAt: '2026-09-02T12:00:00.000Z',
          },
        }
      }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const connect = fixture(invoke).tools.find(tool => tool.name === 'slop_machine_connect')!

    const result = await connect.execute({ machineName: 'research CLUSTER' }, execution('connect-by-name'))

    expect(result).toMatchObject({ ok: true, value: { kind: 'ready', machineId: MACHINE_ID } })
    expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual(['machine.list', 'connection.require'])
    expect(vi.mocked(invoke).mock.calls[1]?.[1]).toMatchObject({ machineId: MACHINE_ID })
  })

  it('rejects ambiguous saved Machine names before opening a connection', async () => {
    const duplicate = { ...machine(), id: '00000000-0000-7000-8000-000000000322' }
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.list') return { ok: true as const, value: [machine(), duplicate] }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const connect = fixture(invoke).tools.find(tool => tool.name === 'slop_machine_connect')!

    const result = await connect.execute({ machineName: 'Research cluster' }, execution('connect-ambiguous'))

    expect(result).toMatchObject({ ok: false, error: { code: 'STATE_CONFLICT', retryable: false } })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects a display alias that does not match the selected Machine', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const shell = fixture(invoke).tools.find(tool => tool.name === 'slop_machine_shell')!

    await expect(shell.execute({
      machineId: MACHINE_ID,
      machineAlias: 'Wrong Machine',
      command: 'hostname',
    }, execution('wrong-alias'))).rejects.toThrow("does not match saved Machine 'Research cluster'")
  })

  it('keeps discovery metadata strict and replaces oversized output with a valid bounded result', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') return { ok: true as const, value: { kind: 'ready' } }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn(async () => ({
      kind: 'completed',
      machineId: MACHINE_ID,
      machineRevision: 1,
      accessProfileRevision: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'x'.repeat(13 * 1024),
      stderr: '',
    }))
    const shell = fixture(invoke, execute).tools.find(tool => tool.name === 'slop_machine_shell')!
    const input = {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: 'find . -mindepth 1 -maxdepth 1 -print | head -n 40',
      workdir: '/work/alice',
      timeoutMs: 10_000,
      discovery: { phase: 'census', root: '/work/alice', purpose: 'depth-one census' },
    }
    await expect(shell.execute({
      ...input,
      discovery: { ...input.discovery, unsupported: true },
    }, execution('strict-discovery'))).rejects.toThrow()
    await expect(shell.execute(input, execution('bounded-discovery'))).resolves.toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: 'DISCOVERY_RESULT_BOUNDS', retryable: false },
    })
  })

  it('returns a non-retryable discovery error for masked remote parser diagnostics', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'machine.get') return { ok: true as const, value: machine() }
      if (method === 'connection.require') return { ok: true as const, value: { kind: 'ready' } }
      throw new Error(`unexpected method ${method}`)
    }) as unknown as SlopApplicationApi['invoke']
    const execute = vi.fn(async () => ({
      kind: 'completed',
      machineId: MACHINE_ID,
      machineRevision: 1,
      accessProfileRevision: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'awk: cmd. line:1: unexpected newline or end of string',
    }))
    const discoveryGuard: Pick<MachineDiscoveryGuard, 'inspectShellOutput'> = {
      inspectShellOutput: () => ({
        kind: 'reject-diagnostic',
        diagnostic: 'awk: cmd. line:1: unexpected newline or end of string',
      }),
    }
    const shell = fixture(invoke, execute, discoveryGuard).tools
      .find(tool => tool.name === 'slop_machine_shell')!

    await expect(shell.execute({
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: 'broken pipeline | head -n 64',
      workdir: '/work/alice',
      timeoutMs: 10_000,
      discovery: { phase: 'census', root: '/work/alice', purpose: 'scheduler summary' },
    }, execution('masked-parser-failure'))).resolves.toMatchObject({
      schemaVersion: 1,
      ok: false,
      error: { code: 'DISCOVERY_REMOTE_DIAGNOSTIC', retryable: false },
    })
  })
})

describe('post-connect session check', () => {
  const readyInvoke = () => vi.fn(async (method: string) => {
    if (method === 'machine.list') return { ok: true as const, value: [machine()] }
    if (method === 'machine.get') return { ok: true as const, value: machine() }
    if (method === 'connection.require') {
      return { ok: true as const, value: { kind: 'ready', machineId: MACHINE_ID, machineRevision: 1, accessProfileRevision: 1, readyAt: '2026-09-02T00:00:00.000Z', expiresAt: '2026-09-02T12:00:00.000Z' } }
    }
    throw new Error(`unexpected method ${method}`)
  }) as unknown as SlopApplicationApi['invoke']
  const shellResult = (stdout: string, stderr: string, exitCode: number) => ({ kind: 'completed', machineId: MACHINE_ID, machineRevision: 1, accessProfileRevision: 1, exitCode, signal: null, timedOut: false, stdout, stderr })

  it('runs one fixed marker command after the transport is ready and reports success', async () => {
    const execute = vi.fn(async () => shellResult('dsh-slop-session-ready\n', '', 0))
    const connect = fixture(readyInvoke(), execute).tools.find(tool => tool.name === 'slop_machine_connect')!
    const result = await connect.execute({ machineId: MACHINE_ID }, execution('connect-probe'))

    expect(result).toMatchObject({ ok: true, value: { kind: 'ready', sessionCheck: { ok: true } } })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ machineId: MACHINE_ID, command: "printf '%s\\n' dsh-slop-session-ready", timeoutMs: 15_000 }))
    expect(validateJsonSchemaValue(connect.output.schema, result)).toEqual([])
  })

  it('explains broken account startup when the marker never prints', async () => {
    const execute = vi.fn(async () => shellResult('', "stty: 'standard input': Inappropriate ioctl for device\n", 1))
    const connect = fixture(readyInvoke(), execute).tools.find(tool => tool.name === 'slop_machine_connect')!
    const result = await connect.execute({ machineId: MACHINE_ID }, execution('connect-broken'))

    expect(result).toMatchObject({ ok: true, value: { kind: 'ready', sessionCheck: {
      ok: false, exitCode: 1, timedOut: false,
      message: expect.stringContaining("non-interactive shell startup stops before commands execute"),
      startupStderr: expect.stringContaining('stty'),
    } } })
    expect(validateJsonSchemaValue(connect.output.schema, result)).toEqual([])
  })

  it('marks harmless startup stderr as noise when the command still runs', async () => {
    const execute = vi.fn(async () => shellResult('dsh-slop-session-ready\n', "stty: 'standard input': Inappropriate ioctl for device\n", 0))
    const connect = fixture(readyInvoke(), execute).tools.find(tool => tool.name === 'slop_machine_connect')!
    const result = await connect.execute({ machineId: MACHINE_ID }, execution('connect-noise'))

    expect(result).toMatchObject({ ok: true, value: { sessionCheck: { ok: true, message: expect.stringContaining('treat this text as noise') } } })
  })

  it('reports a test command that cannot start without failing the connection', async () => {
    const execute = vi.fn(async () => { throw new Error('channel open failure') })
    const connect = fixture(readyInvoke(), execute).tools.find(tool => tool.name === 'slop_machine_connect')!
    const result = await connect.execute({ machineId: MACHINE_ID }, execution('connect-nochannel'))

    expect(result).toMatchObject({ ok: true, value: { kind: 'ready', sessionCheck: { ok: false, message: expect.stringContaining('channel open failure') } } })
  })

  it('runs no test command when the connection is not ready', async () => {
    const execute = vi.fn()
    const invoke = vi.fn(async (method: string) => method === 'machine.get' || method === 'machine.list'
      ? { ok: true as const, value: method === 'machine.list' ? [machine()] : machine() }
      : { ok: false as const, error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.', retryable: true } }) as unknown as SlopApplicationApi['invoke']
    const connect = fixture(invoke, execute).tools.find(tool => tool.name === 'slop_machine_connect')!
    const result = await connect.execute({ machineId: MACHINE_ID }, execution('connect-auth-needed'))

    expect(result).toMatchObject({ ok: false })
    expect(execute).not.toHaveBeenCalled()
  })
})
