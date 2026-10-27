import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolExecutionResult, ToolGuard } from '@deepseek-ai/dsh-tools'
import { DISCOVERY_CENSUS_COMMAND, compileDiscoveryProjectPage } from '../src/discovery-pages.ts'
import { describe, expect, it, vi } from 'vitest'
import { MachineDiscoveryGuard } from '../src/machine-discovery-guard.ts'

const MACHINE_ID = '00000000-0000-7000-8000-000000000321'
const ROOT = '/projects/research'
const PROJECT = `${ROOT}/ProjectA`

function success(value: unknown): ToolExecutionResult {
  return {
    isError: false,
    value: value as never,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function execution(agent: Agent, name: string, argumentsValue: unknown, callId: string): ToolExecution {
  return {
    agent,
    name,
    arguments: argumentsValue,
    callId: callId as never,
    signal: new AbortController().signal,
    token: Symbol(callId) as never,
  }
}

function fixture(activeFromInvocation = false) {
  const events: unknown[] = [
    { type: 'turn/start', data: { turn: 1 } },
    ...(activeFromInvocation
      ? [{ type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'deep-discover' } } }]
      : []),
  ]
  const agent = {
    id: 'agent-discovery',
    status: 'running',
    session: { get seq() { return events.length }, eventAt: (seq: number) => events[seq] },
  } as unknown as Agent
  let guard: ToolGuard | undefined
  let resultListener: ((exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => void) | undefined
  const offGuard = vi.fn()
  const offResult = vi.fn()
  const ctx = {
    agents: {
      get: (id: unknown) => id === agent.id ? agent : undefined,
      currentInitiator: () => agent,
    },
    tools: {
      guard(callback: ToolGuard) {
        guard = callback
        return offGuard
      },
    },
    on(event: string, callback: typeof resultListener) {
      if (event !== 'tools/result') throw new Error(`unexpected event ${event}`)
      resultListener = callback
      return offResult
    },
  } as unknown as Context
  const runtime = new MachineDiscoveryGuard()
  const dispose = runtime.register(ctx)
  return {
    agent,
    events,
    runtime,
    dispose,
    guard: (exec: ToolExecution) => guard?.(exec),
    result: (exec: ToolExecution, result: ToolExecutionResult) => resultListener?.(exec, result),
    offGuard,
    offResult,
  }
}

function activateAndLoadMachine(target: ReturnType<typeof fixture>): void {
  const skill = execution(target.agent, 'skill', { name: 'deep-discover' }, 'skill-call')
  target.result(skill, success('<skill_content name="deep-discover">instructions</skill_content>'))
  const get = execution(target.agent, 'slop_machine_get', { machineId: MACHINE_ID }, 'machine-get')
  target.result(get, success({
    ok: true,
    value: {
      machine: {
        id: MACHINE_ID,
        target: 'research-login.example.org',
        host: 'research-login.example.org',
        username: 'researcher',
        connectionState: 'ready',
        baseConfiguration: {
          declaredRoots: [{ role: 'work', path: { kind: 'remote', path: ROOT } }],
        },
      },
    },
  }))
}

function census(
  target: ReturnType<typeof fixture>,
  callId = 'census',
  command = "find . -mindepth 1 -maxdepth 1 -print | head -n 64",
): ToolExecution {
  return execution(target.agent, 'slop_machine_shell', {
    machineId: MACHINE_ID,
    machineAlias: 'Research cluster',
    command,
    workdir: ROOT,
    timeoutMs: 10_000,
    discovery: { phase: 'census', root: ROOT, purpose: 'bounded depth-one project page' },
  }, callId)
}

function projectRead(
  target: ReturnType<typeof fixture>,
  callId: string,
  command = "find . -mindepth 1 -maxdepth 2 -type f -print | head -n 40",
): ToolExecution {
  return execution(target.agent, 'slop_machine_shell', {
    machineId: MACHINE_ID,
    machineAlias: 'Research cluster',
    command,
    workdir: PROJECT,
    timeoutMs: 10_000,
    discovery: {
      phase: 'project-read',
      projectPath: PROJECT,
      purpose: 'identify workflow evidence',
      selectionPlan: [PROJECT, `${ROOT}/ProjectB`],
    },
  }, callId)
}

function evidenceRead(target: ReturnType<typeof fixture>, callId: string, files: readonly string[]): ToolExecution {
  return execution(target.agent, 'slop_machine_shell', {
    machineId: MACHINE_ID,
    machineAlias: 'Research cluster',
    evidenceFiles: files,
    workdir: PROJECT,
    timeoutMs: 10_000,
    discovery: {
      phase: 'project-read',
      projectPath: PROJECT,
      purpose: 'read selected evidence files',
      selectionPlan: [PROJECT, `${ROOT}/ProjectB`],
    },
  }, callId)
}

function settle(target: ReturnType<typeof fixture>, call: ToolExecution, stdout = ''): void {
  target.result(call, success({ ok: true, value: { exitCode: 0, timedOut: false, stdout } }))
}

describe('Machine Deep Discovery guard', () => {
  it('admits only fixed root resolution, then scopes census to its successful result', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    target.result(execution(target.agent, 'slop_machine_get', {}, 'empty-roots'), success({ ok: true, value: { machine: { id: MACHINE_ID, connectionState: 'ready', baseConfiguration: { declaredRoots: [] } } } }))
    const args = { machineId: MACHINE_ID, timeoutMs: 20000, discovery: { phase: 'resolve-root', root: '~/Documents', purpose: 'Resolve user root' } }
    expect(target.guard(execution(target.agent, 'slop_machine_shell', { ...args, command: 'touch /tmp/wrong' }, 'bad-root'))).toMatch(/documented fields/)
    const lookup = execution(target.agent, 'slop_machine_shell', args, 'resolve-root')
    expect(target.guard(lookup)).toBeUndefined()
    settle(target, lookup, '/home/alice/Documents\n')
    const inspect = (root: string) => execution(target.agent, 'slop_machine_shell', { machineId: MACHINE_ID, timeoutMs: 20000, command: 'find . -mindepth 1 -maxdepth 1 -print | head -n 64', workdir: root, discovery: { phase: 'census', root, purpose: 'Read selected root' } }, root)
    expect(target.guard(inspect('/home/alice'))).toMatch(/same exact/)
    expect(target.guard(inspect('/home/alice/Documents'))).toBeUndefined()
  })

  it('activates from a successful Code Mode Skill result without assuming its value shape', () => {
    const target = fixture()
    const skill = execution(target.agent, 'skill', { name: 'deep-discover' }, 'skill-call')
    target.result(skill, success('<skill_content name="deep-discover">instructions</skill_content>'))

    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'raw-root.md',
      content: 'Prior work used /work/qan/researcher/ProjectA/run.sh.',
    }, 'raw-root'))).toMatch(/identity-bearing absolute/u)
  })

  it('leaves general Machine shell and Knowledge writes unchanged outside discovery', () => {
    const target = fixture()
    expect(target.guard(execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: 'hostname',
    }, 'generic'))).toBeUndefined()
    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'workflow.md',
      content: 'Prior work used /projects/research/ProjectA/run.sh.',
    }, 'knowledge'))).toBeUndefined()
  })

  it('keeps discovery Knowledge portable, concise, and sequential', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const portable = execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'workflow.md',
      content: 'Prior work used <work-root>/ProjectA/run.sh on Research cluster.',
    }, 'portable-knowledge')
    expect(target.guard(portable)).toBeUndefined()

    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'workspace',
      path: 'other.md',
      content: 'Another write.',
    }, 'overlapping-knowledge'))).toMatch(/awaited sequentially/u)
    target.result(portable, success({ mode: 'create', created: true, digest: 'receipt' }))

    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'raw-root.md',
      content: 'Prior work used /projects/research/ProjectA/run.sh.',
    }, 'raw-root'))).toMatch(/stable anchors/u)
    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'update',
      scope: 'workspace',
      path: 'endpoint.md',
      operation: 'replace-sections',
      expectedDigest: 'receipt',
      sectionReplacements: [{ headingPath: ['Machine'], body: 'Connect to research-login.example.org as researcher.' }],
    }, 'raw-endpoint'))).toMatch(/roots.*endpoints.*usernames/u)
    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'oversized.md',
      content: 'x'.repeat(4 * 1024 + 1),
    }, 'oversized-home'))).toMatch(/Home at most 4096 bytes/u)
    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'machine-proposal.md',
      content: '## Machine Info proposal\n\nConnection: Research cluster; ready.',
    }, 'machine-proposal'))).toMatch(/Chat-only Machine Info proposal/u)
  })

  it('requires Workspace discovery Knowledge to preserve evidence structure and unread roots', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\nProjectB\n')
    const selected = projectRead(target, 'selected-project')
    expect(target.guard(selected)).toBeUndefined()
    settle(target, selected, [
      'FILE|./run.sh',
      'FILE|./resource.json',
      'FILE|./driver.py',
      'EVIDENCE|./run.sh',
      '10:python run.py',
      'EVIDENCE|./resource.json',
      '3:    "cpu_per_node": 64,',
      'EVIDENCE|./driver.py',
      '10:runtime_path = "/projects/research/app/gamess/rungms"',
      '',
    ].join('\n'))

    const workspaceWrite = (content: string, callId: string) => execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'workspace',
      path: 'project-map.md',
      content,
    }, callId)
    expect(target.guard(workspaceWrite('# Project map\n\nProse only.', 'missing-tables')))
      .toMatch(/classification table/u)
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | inferred-scientific | name-only |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | wrapper to driver | `run.sh` | `python run.py` | direct |',
    ].join('\n'), 'inferred-unread'))).toMatch(/cannot classify unread root ProjectB/u)
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | driver to config | `run.py` | `import dpdispatcher` | direct |',
    ].join('\n'), 'import-as-edge'))).toMatch(/cannot use an import as a direct execution edge/u)
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      "| ProjectA | driver to worker | `run.py` | `Machine.load_from_json('./machine.json')` | direct |",
    ].join('\n'), 'config-as-worker'))).toMatch(/must contain an active worker command/u)
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | driver to worker | `run.py` | `command=cmd,` | direct |',
    ].join('\n'), 'opaque-command-variable'))).toMatch(/must contain an active worker command/u)
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | driver to worker | `run.sh` | `python run.py` | direct |',
    ].join('\n'), 'python-worker-source'))).toBeUndefined()
    settle(target, workspaceWrite('', 'python-worker-source'), '')
    const validWorkspace = workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | wrapper to driver | `run.sh` | `python run.py` | direct |',
    ].join('\n'), 'valid-workspace')
    expect(target.guard(validWorkspace)).toBeUndefined()
    settle(target, validWorkspace, '')
    const exactWhitespaceWorkspace = workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | resources | `<work-root>/ProjectA/resource.json` | `"cpu_per_node": 64,` | direct |',
      '| ProjectA | runtime path | `<work-root>/ProjectA/driver.py` | `runtime_path = "<work-root>/app/gamess/rungms"` | direct |',
    ].join('\n'), 'canonical-whitespace-and-root-anchor')
    expect(target.guard(exactWhitespaceWorkspace)).toBeUndefined()
    settle(target, exactWhitespaceWorkspace, '')
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | wrapper to driver | `other.sh` | `python run.py` | direct |',
    ].join('\n'), 'unobserved-direct-source'))).toMatch(/must cite a FILE returned.*this turn/u)
    expect(target.guard(workspaceWrite([
      '| Entry | Category | Evidence tier |',
      '| --- | --- | --- |',
      '| ProjectA | confirmed-project | direct |',
      '| ProjectB | unclassified | census |',
      '',
      '| Project | Edge | Source file | Active line | Status |',
      '| --- | --- | --- | --- | --- |',
      '| ProjectA | wrapper to driver | `<work-root>/ProjectA/run.sh` | `python run.py; queue nova` | direct |',
    ].join('\n'), 'summarized-direct-line'))).toMatch(/quote one active line.*verbatim/u)
    expect(target.guard(execution(target.agent, 'slop_knowledge_write', {
      mode: 'update',
      scope: 'workspace',
      path: 'project-map.md',
      expectedDigest: 'digest',
      operation: 'replace-sections',
      sectionReplacements: [{
        headingPath: ['Project map'],
        body: [
          '| Entry | Category | Evidence tier |',
          '| --- | --- | --- |',
          '| ProjectA | confirmed-project | direct |',
          '| ProjectB | unclassified | census |',
          '',
          '| Project | Edge | Source file | Active line | Status |',
          '| --- | --- | --- | --- | --- |',
          '| ProjectA | wrapper to driver | `other.sh` | `python run.py` | direct |',
        ].join('\n'),
      }],
    }, 'unobserved-update-source'))).toMatch(/must cite a FILE returned.*this turn/u)
  })

  it('keeps a thirteenth project outside a frozen twelve-project plan without remote work', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')

    const selectionPlan = Array.from({ length: 12 }, (_, index) => `${ROOT}/Project${String(index)}`)
    for (let index = 0; index < 12; index += 1) {
      const projectPath = `${ROOT}/Project${String(index)}`
      const call = execution(target.agent, 'slop_machine_shell', {
        machineId: MACHINE_ID,
        command: `sed -n '${String(index + 1)}p' note.md | head -n 1`,
        workdir: projectPath,
        timeoutMs: 10_000,
        discovery: {
          phase: 'project-read',
          projectPath,
          purpose: 'read selected project evidence',
          selectionPlan,
        },
      }, `project-root-${String(index)}`)
      expect(target.guard(call)).toBeUndefined()
      settle(target, call, 'evidence\n')
    }
    const thirteenthProjectPath = `${ROOT}/Project12`
    const thirteenthProject = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: thirteenthProjectPath,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: thirteenthProjectPath,
        purpose: 'read another project',
        selectionPlan,
      },
    }, 'project-root-thirteen')
    expect(target.guard(thirteenthProject)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(thirteenthProject)).toEqual({
      kind: 'project-not-in-plan',
      budget: {
        shellAttemptsUsed: 13,
        shellAttemptsRemaining: 19,
        selectedProjectPaths: 12,
        turnOutputBytesRemaining: 256 * 1024,
      },
    })
  })

  it('freezes a supplied selection plan and suppresses out-of-plan project reads locally', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\nProjectB\nProjectC\n')

    const plan = [`${ROOT}/ProjectA`, `${ROOT}/ProjectB`]
    const first = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: plan[0],
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: plan[0],
        purpose: 'read first planned project',
        selectionPlan: plan,
      },
    }, 'planned-first')
    expect(target.guard(first)).toBeUndefined()
    settle(target, first, 'evidence\n')

    const outside = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '2p' note.md | head -n 1",
      workdir: `${ROOT}/ProjectC`,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: `${ROOT}/ProjectC`,
        purpose: 'read an unplanned project',
        selectionPlan: plan,
      },
    }, 'outside-plan')
    expect(target.guard(outside)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(outside)).toMatchObject({
      kind: 'project-not-in-plan',
      budget: { shellAttemptsUsed: 2, selectedProjectPaths: 1 },
    })

    const changedPlan = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '3p' note.md | head -n 1",
      workdir: plan[1],
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: plan[1],
        purpose: 'change the frozen plan',
        selectionPlan: [...plan].reverse(),
      },
    }, 'changed-plan')
    expect(target.guard(changedPlan)).toMatch(/selectionPlan is frozen/u)
  })

  it('rejects a missing project selection plan before reserving the project', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')

    const missingPlan = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: PROJECT,
      timeoutMs: 10_000,
      discovery: { phase: 'project-read', projectPath: PROJECT, purpose: 'read project evidence' },
    }, 'missing-plan')
    expect(target.guard(missingPlan)).toMatch(/requires the complete ordered discovery\.selectionPlan/u)

    const corrected = projectRead(target, 'corrected-plan')
    expect(target.guard(corrected)).toBeUndefined()
  })

  it('does not reserve or fail a project for local argument-shape errors', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')

    const malformed = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      evidenceFiles: ['./run.sh'],
      workdir: PROJECT,
      timeoutMs: 10_000,
      projectPath: PROJECT,
      purpose: 'stray top-level fields',
      discovery: {
        phase: 'project-read',
        projectPath: PROJECT,
        purpose: 'read selected evidence',
        selectionPlan: [PROJECT],
      },
    }, 'malformed-local-shape')
    expect(target.guard(malformed)).toMatch(/only the documented fields/u)
    target.result(malformed, {
      isError: true,
      value: null,
      content: [{ type: 'text', text: 'local schema rejection' }],
    } as unknown as ToolExecutionResult)

    const role = projectRead(target, 'corrected-local-shape')
    expect(target.guard(role)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(role)).toEqual({ kind: 'execute' })
  })

  it('requires structured metadata, a Machine read, and a bounded root page before project reads', () => {
    const target = fixture()
    const skill = execution(target.agent, 'skill', { name: 'deep-discover' }, 'skill-call')
    target.result(skill, success({ name: 'deep-discover' }))
    expect(target.guard(execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: 'hostname',
    }, 'untagged'))).toMatch(/structured discovery phase/u)
    expect(target.guard(census(target))).toMatch(/slop_machine_get/u)

    activateAndLoadMachine(target)
    expect(target.guard(projectRead(target, 'early'))).toMatch(/bounded depth-one census/u)

    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\nProjectB\n')
    const read = projectRead(target, 'project-read')
    expect(target.guard(read)).toBeUndefined()
  })

  it('rejects remote discovery until the Machine is ready in the current turn', () => {
    const target = fixture()
    const skill = execution(target.agent, 'skill', { name: 'deep-discover' }, 'skill-call')
    target.result(skill, success({ name: 'deep-discover' }))
    const get = execution(target.agent, 'slop_machine_get', { machineId: MACHINE_ID }, 'machine-get')
    target.result(get, success({
      ok: true,
      value: {
        machine: {
          id: MACHINE_ID,
          connectionState: 'disconnected',
          baseConfiguration: {
            declaredRoots: [{ role: 'work', path: { kind: 'remote', path: ROOT } }],
          },
        },
      },
    }))
    expect(target.guard(census(target))).toMatch(/requires a ready Machine connection/u)

    const connect = execution(target.agent, 'slop_machine_connect', { machineId: MACHINE_ID }, 'machine-connect')
    target.result(connect, success({ ok: true, value: { kind: 'ready', machineId: MACHINE_ID } }))
    expect(target.guard(census(target, 'after-connect'))).toBeUndefined()
  })

  it('accepts more than one safe depth-one enumeration shape', () => {
    for (const [index, command] of [
      "find . -mindepth 1 -maxdepth 1 -printf '%f|%y\\n' | head -n 64",
      "find . -mindepth 1 -maxdepth 1 -printf '%f|%y\\n' | head -n 64 | awk '{print} END {print \"CENSUS|emitted=\" NR \"|cap=64\"}'",
      "find . -mindepth 1 -maxdepth 1 -print0 | tr '\\0' '\\n' | head -n 32",
      'ls -1A . | head -n 50',
    ].entries()) {
      const target = fixture()
      activateAndLoadMachine(target)
      const page = census(target, `page-${String(index)}`, command)
      expect(target.guard(page)).toBeUndefined()
      settle(target, page, 'ProjectA\n')
      expect(target.guard(projectRead(target, `read-${String(index)}`))).toBeUndefined()
    }
  })

  it('requires both per-find traversal limits and one final project output limit', () => {
    const valid = fixture()
    activateAndLoadMachine(valid)
    const validPage = census(valid)
    expect(valid.guard(validPage)).toBeUndefined()
    settle(valid, validPage, 'ProjectA\n')
    expect(valid.guard(projectRead(
      valid,
      'bounded-multi-find',
      "{ find . -mindepth 1 -maxdepth 1 -type d -print | head -n 8; find . -mindepth 1 -maxdepth 2 -type f -print | head -n 8; } | head -n 16",
    ))).toBeUndefined()

    const unboundedTraversal = fixture()
    activateAndLoadMachine(unboundedTraversal)
    const unboundedPage = census(unboundedTraversal)
    expect(unboundedTraversal.guard(unboundedPage)).toBeUndefined()
    settle(unboundedTraversal, unboundedPage, 'ProjectA\n')
    expect(unboundedTraversal.guard(projectRead(
      unboundedTraversal,
      'outer-only-limit',
      "{ find . -mindepth 1 -maxdepth 1 -type d -print; find . -mindepth 1 -maxdepth 2 -type f -print; } | head -n 16",
    ))).toMatch(/Each find must stop/u)
  })

  it('suppresses a duplicate accepted project read locally without spending shell budget', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    const role = projectRead(target, 'role-page')
    expect(target.guard(role)).toBeUndefined()
    settle(target, role, 'CANDIDATE|./note.md\nCANDIDATE|./branch/driver\'s.py\n')
    const selected = evidenceRead(target, 'combined-evidence', ['./note.md', "./branch/driver's.py"])
    expect(target.guard(selected)).toBeUndefined()
    settle(target, selected, 'FILE|./note.md\n')
    const duplicate = evidenceRead(target, 'duplicate-evidence', ['./note.md', "./branch/driver's.py"])
    expect(target.guard(duplicate)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(duplicate)).toEqual({
      kind: 'duplicate-suppressed',
      budget: {
        shellAttemptsUsed: 3,
        shellAttemptsRemaining: 29,
        selectedProjectPaths: 1,
        turnOutputBytesRemaining: 256 * 1024,
      },
    })
  })

  it('suppresses cross-project evidence and focused paths before remote execution', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\nProjectB\n')

    const firstRole = projectRead(target, 'project-a-role')
    expect(target.guard(firstRole)).toBeUndefined()
    settle(target, firstRole, 'WORKSTREAM|./alpha\nCANDIDATE|./alpha/run.sh\n')

    const projectB = `${ROOT}/ProjectB`
    const secondRole = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: "find . -mindepth 1 -maxdepth 1 -type d -print | head -n 20",
      workdir: projectB,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: projectB,
        purpose: 'identify second project workflow evidence',
        selectionPlan: [PROJECT, projectB],
      },
    }, 'project-b-role')
    expect(target.guard(secondRole)).toBeUndefined()
    settle(target, secondRole, 'WORKSTREAM|./apptainer\n')

    const wrongFile = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      evidenceFiles: ['./alpha/run.sh'],
      workdir: projectB,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: projectB,
        purpose: 'read selected second project evidence',
        selectionPlan: [PROJECT, projectB],
      },
    }, 'cross-project-file')
    expect(target.guard(wrongFile)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(wrongFile)).toMatchObject({
      kind: 'evidence-not-observed',
      unobservedPaths: ['./alpha/run.sh'],
      observedPaths: ['./apptainer'],
    })

    const wrongFocused = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: "find './alpha' -mindepth 1 -maxdepth 2 -type f -printf 'FOCUSED|%p\\n' | head -n 24",
      workdir: projectB,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: projectB,
        purpose: 'recover second project candidate',
        selectionPlan: [PROJECT, projectB],
      },
    }, 'cross-project-focused')
    expect(target.guard(wrongFocused)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(wrongFocused)).toMatchObject({
      kind: 'evidence-not-observed',
      unobservedPaths: ['./alpha'],
      observedPaths: ['./apptainer'],
    })
  })

  it('accepts the shipped role-aware project page', () => {
    const command = compileDiscoveryProjectPage()

    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    expect(target.guard(projectRead(target, 'shipped-role-page', command))).toBeUndefined()
  })

  it('accepts the shipped focused-workstream candidate recovery page', () => {
    const command = compileDiscoveryProjectPage('./apptainer')

    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    expect(target.guard(projectRead(target, 'focused-workstream', command))).toBeUndefined()
  })

  it('accepts the shipped whole-project candidate recovery fallback', () => {
    const command = 'find . -mindepth 1 -maxdepth 3 -type f -printf \'FOCUSED|%p\\n\' | head -n 40 | LC_ALL=C cut -b 1-160 | head -n 40'

    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    expect(target.guard(projectRead(target, 'whole-project-fallback', command))).toBeUndefined()
  })

  it('requires focused recovery before the whole-project fallback when a workstream was emitted', () => {
    const focusedCommand = compileDiscoveryProjectPage('./apptainer')
    const wholeProjectCommand = 'find . -mindepth 1 -maxdepth 3 -type f -printf \'FOCUSED|%p\\n\' | head -n 40 | LC_ALL=C cut -b 1-160 | head -n 40'

    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')

    const role = projectRead(target, 'role-with-workstream')
    expect(target.guard(role)).toBeUndefined()
    settle(target, role, 'WORKSTREAM|./apptainer\n')

    const prematureFallback = projectRead(target, 'premature-whole-project', wholeProjectCommand)
    expect(target.guard(prematureFallback)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(prematureFallback)).toMatchObject({
      kind: 'focused-recovery-required',
      budget: { shellAttemptsUsed: 2, selectedProjectPaths: 1 },
    })

    const focused = projectRead(target, 'focused-recovery', focusedCommand)
    expect(target.guard(focused)).toBeUndefined()
    settle(target, focused)

    const fallback = projectRead(target, 'whole-project-after-focused', wholeProjectCommand)
    expect(target.guard(fallback)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(fallback)).toEqual({ kind: 'execute' })
  })

  it('rejects invalid or protected structured evidence paths before remote execution', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    expect(target.guard(evidenceRead(target, 'traversal', ['../secret.md']))).toMatch(/structured discovery phase/u)
    const role = projectRead(target, 'licensed-role')
    expect(target.guard(role)).toBeUndefined()
    settle(target, role, 'CANDIDATE|./relax/POTCAR\n')
    expect(target.guard(evidenceRead(target, 'licensed', ['./relax/POTCAR']))).toMatch(/licensed inputs/u)
  })

  it('passes a well-formed empty evidence selection without reserving remote work', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const empty = evidenceRead(target, 'empty-evidence', [])

    expect(target.guard(empty)).toBeUndefined()
    expect(target.guard(empty)).toBeUndefined()
    expect(target.guard(execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      evidenceFiles: [],
      workdir: PROJECT,
      timeoutMs: 10_000,
    }, 'malformed-empty'))).toMatch(/structured discovery phase/u)
  })

  it('enforces scope, sequential execution, duplicate rejection, and per-project budgets', () => {
    const target = fixture(true)
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    expect(target.guard(census(target, 'parallel'))).toMatch(/one Deep Discovery shell call at a time/u)
    settle(target, page, 'ProjectA\n')
    expect(target.guard(census(target, 'duplicate'))).toMatch(/repeat an identical/u)

    for (let index = 0; index < 5; index += 1) {
      const read = projectRead(target, `project-${String(index)}`, `sed -n '${String(index + 1)},${String(index + 4)}p' run.sh | head -n 4`)
      expect(target.guard(read)).toBeUndefined()
      settle(target, read, 'evidence\n')
    }
    expect(target.guard(projectRead(target, 'project-6', "sed -n '20,24p' run.sh | head -n 5"))).toMatch(/at most 5/u)

    const escape = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '1,20p' /projects/other/secret.md",
      workdir: `${ROOT}/ProjectB`,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: `${ROOT}/ProjectB`,
        purpose: 'escape attempt',
        selectionPlan: [PROJECT, `${ROOT}/ProjectB`],
      },
    }, 'escape')
    expect(target.guard(escape)).toMatch(/outside the active phase scope/u)
  })

  it('accepts only project-prefixed structured evidence from the parent census root', () => {
    const target = fixture(true)
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\nProjectB\n')

    const role = projectRead(target, 'project-a-prefixed-role')
    expect(target.guard(role)).toBeUndefined()
    settle(target, role, 'CANDIDATE|./run.sh\nCANDIDATE|./driver.py\n')

    const prefixed = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      evidenceFiles: ['./ProjectA/run.sh', './ProjectA/driver.py'],
      evidenceTerms: ['submit_stage_batch', 'worker_command'],
      workdir: ROOT,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: PROJECT,
        purpose: 'read selected project evidence',
        selectionPlan: [PROJECT, `${ROOT}/ProjectB`],
      },
    }, 'prefixed-evidence')
    expect(target.guard(prefixed)).toBeUndefined()
    settle(target, prefixed, 'FILE|./ProjectA/run.sh\nFILE|./ProjectA/driver.py\n')

    const sibling = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      evidenceFiles: ['./ProjectB/run.sh'],
      workdir: ROOT,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: PROJECT,
        purpose: 'cross-project evidence attempt',
        selectionPlan: [PROJECT, `${ROOT}/ProjectB`],
      },
    }, 'sibling-evidence')
    expect(target.guard(sibling)).toMatch(/every file starts with that project directory/u)

    const commandFromParent = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      machineAlias: 'Research cluster',
      command: "sed -n '1,10p' ./ProjectA/run.sh | head -n 10",
      workdir: ROOT,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: PROJECT,
        purpose: 'parent command attempt',
        selectionPlan: [PROJECT, `${ROOT}/ProjectB`],
      },
    }, 'parent-command')
    expect(target.guard(commandFromParent)).toMatch(/workdir must exactly match/u)
  })

  it('uses scheduler safety constraints without requiring one eval command template', () => {
    const target = fixture()
    activateAndLoadMachine(target)

    const accounting = census(
      target,
      'accounting',
      'sacct -u "$USER" -S now-30days -o WorkDir,State -n -P | awk -F\'|\' \'{count[$1 FS $2]++} END {for (k in count) print k, count[k]}\' | head -n 40',
    )
    expect(target.guard(accounting)).toBeUndefined()
    settle(target, accounting)

    const otherAccounting = census(
      target,
      'accounting-again',
      'sacct -u "$USER" -S now-7days -o State -n | sort | uniq -c | head -n 20',
    )
    expect(target.guard(otherAccounting)).toMatch(/only one/u)

    const unsafeTarget = fixture()
    activateAndLoadMachine(unsafeTarget)
    const allUsers = census(unsafeTarget, 'all-users', 'sacct -a -S now-7days -o State | head -n 20')
    expect(unsafeTarget.guard(allUsers)).toMatch(/only \$USER/u)

    const queue = census(target, 'queue', 'squeue -u "$USER" -h -o "%j|%T|%P" | head -n 32')
    expect(target.guard(queue)).toBeUndefined()
    settle(target, queue)
    const queueIdTarget = fixture()
    activateAndLoadMachine(queueIdTarget)
    expect(queueIdTarget.guard(census(queueIdTarget, 'queue-id', 'squeue -u "$USER" -h -o "%i|%T" | head -n 10')))
      .toMatch(/omit job ids/u)
  })

  it('accepts the shipped pipefail scheduler-history command', () => {
    const command = 'sacct -u "$USER" -S now-7days -n -X -o JobName,Partition,State | head -n 64'

    const target = fixture()
    activateAndLoadMachine(target)
    expect(target.guard(census(target, 'shipped-scheduler-history', command))).toBeUndefined()
  })

  it.each([
    ['parent traversal', 'find .. -maxdepth 1 -print | head -n 10'],
    ['unbounded find', 'find . -maxdepth 2 -type f -print'],
    ['deep find', 'find . -maxdepth 4 -type f -print | head -n 10'],
    ['remote write', 'touch marker'],
    ['redirect', "printf x > 'marker'"],
    ['history', 'history -10'],
    ['credential', "sed -n '1,4p' ~/.ssh/config"],
    ['licensed input', "sed -n '1,4p' POTCAR"],
    ['nested shell mutation', "bash -c 'rm marker'"],
    ['find action', 'find . -mindepth 1 -maxdepth 1 -delete | head -n 1'],
    ['awk system', "awk 'BEGIN { system(\"rm marker\") }' input.txt | head -n 1"],
  ])('rejects %s during active discovery', (_label, command) => {
    const target = fixture()
    activateAndLoadMachine(target)
    expect(target.guard(census(target, `unsafe-${_label}`, command))).toBeTypeOf('string')
  })

  it('enforces per-call and cumulative discovery output budgets', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    for (let index = 0; index < 22; index += 1) {
      const call = census(target, `output-${String(index)}`, `printf '${String(index)}\\n' | head -n 1`)
      expect(target.guard(call)).toBeUndefined()
      const decision = target.runtime.inspectShellOutput(call, 'x'.repeat(12 * 1024), '')
      if (index < 21) expect(decision.kind).toBe('accept')
      else expect(decision.kind).toBe('reject-bounds')
      settle(target, call)
    }

    const oversized = census(target, 'oversized-output', "printf 'oversized\\n' | head -n 1")
    expect(target.guard(oversized)).toBeUndefined()
    expect(target.runtime.inspectShellOutput(oversized, 'x'.repeat(12 * 1024 + 1), ''))
      .toMatchObject({ kind: 'reject-bounds' })
  })

  it('allows one bounded correction when a pipeline masks a remote parser failure', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const call = census(target, 'masked-parser-failure')
    expect(target.guard(call)).toBeUndefined()
    expect(target.runtime.inspectShellOutput(
      call,
      '',
      "stty: 'standard input': Inappropriate ioctl for device\nawk: cmd. line:1: ^ unexpected newline or end of string\n",
    )).toEqual({
      kind: 'reject-diagnostic',
      diagnostic: 'awk: cmd. line:1: ^ unexpected newline or end of string',
    })
    expect(target.guard(execution(target.agent, 'read', { path: 'next-stage.md' }, 'after-diagnostic')))
      .toBeUndefined()

    const benign = fixture()
    activateAndLoadMachine(benign)
    const benignCall = census(benign, 'benign-stty')
    expect(benign.guard(benignCall)).toBeUndefined()
    expect(benign.runtime.inspectShellOutput(
      benignCall,
      'ProjectA\n',
      "stty: 'standard input': Inappropriate ioctl for device\n",
    )).toMatchObject({
      kind: 'accept',
      budget: { shellAttemptsUsed: 1, shellAttemptsRemaining: 31, selectedProjectPaths: 0 },
    })
  })

  it('ends a project frontier after an unsafe shape, remote failure, or output overflow', () => {
    const unsafe = fixture()
    activateAndLoadMachine(unsafe)
    const unsafePage = census(unsafe)
    expect(unsafe.guard(unsafePage)).toBeUndefined()
    settle(unsafe, unsafePage, 'ProjectA\n')
    expect(unsafe.guard(projectRead(
      unsafe,
      'unbounded-bundle',
      "for f in run.sh driver.py; do sed -n '1,120p' \"$f\"; done | cut -b 1-220",
    ))).toMatch(/output-wide head/u)
    expect(unsafe.guard(projectRead(unsafe, 'after-unsafe'))).toMatch(/previous .* failed/iu)

    const remoteFailure = fixture()
    activateAndLoadMachine(remoteFailure)
    const failurePage = census(remoteFailure)
    expect(remoteFailure.guard(failurePage)).toBeUndefined()
    settle(remoteFailure, failurePage, 'ProjectA\n')
    const failedRead = projectRead(remoteFailure, 'remote-failure')
    expect(remoteFailure.guard(failedRead)).toBeUndefined()
    remoteFailure.result(failedRead, success({ ok: true, value: { exitCode: 2, timedOut: false } }))
    expect(remoteFailure.guard(projectRead(remoteFailure, 'after-remote-failure'))).toMatch(/previous .* failed/iu)

    const overflow = fixture()
    activateAndLoadMachine(overflow)
    const overflowPage = census(overflow)
    expect(overflow.guard(overflowPage)).toBeUndefined()
    settle(overflow, overflowPage, 'ProjectA\n')
    const oversizedRead = projectRead(overflow, 'oversized-project')
    expect(overflow.guard(oversizedRead)).toBeUndefined()
    expect(overflow.runtime.inspectShellOutput(oversizedRead, 'x'.repeat(12 * 1024 + 1), ''))
      .toMatchObject({ kind: 'reject-bounds' })
    overflow.result(oversizedRead, success({ ok: false, error: { code: 'DISCOVERY_RESULT_BOUNDS' } }))
    expect(overflow.guard(projectRead(overflow, 'after-overflow'))).toMatch(/previous .* failed/iu)
  })

  it('contains a project-scoped policy denial without discarding other accepted evidence', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\nProjectB\n')

    const role = projectRead(target, 'repair-role')
    expect(target.guard(role)).toBeUndefined()
    settle(target, role, 'CANDIDATE|./POTCAR\n')

    const denied = evidenceRead(target, 'repair-root:code:1', ['./POTCAR'])
    expect(target.guard(denied)).toMatch(/licensed inputs/u)
    const outer = execution(target.agent, 'run_code', {}, 'repair-root')
    target.result(outer, {
      isError: true,
      value: null,
      content: [{ type: 'text', text: 'inner Tool denial' }],
    } as unknown as ToolExecutionResult)

    const otherPath = `${ROOT}/ProjectB`
    const other = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID,
      command: "sed -n '1p' note.md | head -n 1",
      workdir: otherPath,
      timeoutMs: 10_000,
      discovery: {
        phase: 'project-read',
        projectPath: otherPath,
        purpose: 'read another selected project',
        selectionPlan: [PROJECT, otherPath],
      },
    }, 'other-project')
    expect(target.guard(other)).toBeUndefined()
  })

  it('allows recovery from a local-only outer run_code failure', () => {
    const target = fixture()
    activateAndLoadMachine(target)

    const failedProgram = execution(target.agent, 'run_code', { code: 'return result' }, 'program-failure')
    target.result(failedProgram, {
      isError: true,
      error: { code: 'CODE_RUN_FAILED', message: 'program completion must be lossless JSON' },
      content: [{ type: 'text', text: 'program completion must be lossless JSON' }],
    })

    expect(target.guard(execution(target.agent, 'read', { path: 'README.md' }, 'recovery-read')))
      .toBeUndefined()
    expect(target.guard(execution(target.agent, 'slop_machine_get', { machineId: MACHINE_ID }, 'recovery-machine')))
      .toBeUndefined()
  })

  it('stops after the single local Code Mode correction also fails', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const failedResult = {
      isError: true,
      error: { code: 'CODE_RUN_FAILED', message: 'local render failed' },
      content: [{ type: 'text', text: 'local render failed' }],
    } as ToolExecutionResult

    target.result(execution(target.agent, 'run_code', {}, 'local-failure-1'), failedResult)
    expect(target.guard(execution(target.agent, 'run_code', {}, 'local-correction'))).toBeUndefined()
    target.result(execution(target.agent, 'run_code', {}, 'local-failure-2'), failedResult)

    expect(target.guard(execution(target.agent, 'run_code', {}, 'debug-loop')))
      .toMatch(/single allowed local Code Mode correction also failed/u)
  })

  it('stops after an outer failure when its nested Knowledge write may have committed', () => {
    const target = fixture()
    activateAndLoadMachine(target)

    const write = execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'workflow.md',
      content: 'Prior work used <work-root>/ProjectA/run.sh.',
    }, 'write-program:code:1')
    expect(target.guard(write)).toBeUndefined()
    target.result(write, success({ mode: 'create', created: true, digest: 'receipt' }))
    target.result(execution(target.agent, 'run_code', {}, 'write-program'), {
      isError: true,
      error: { code: 'CODE_RUN_FAILED', message: 'program completion must be lossless JSON' },
      content: [{ type: 'text', text: 'program completion must be lossless JSON' }],
    })

    expect(target.guard(execution(target.agent, 'run_code', { code: 'return retry' }, 'blocked-retry')))
      .toMatch(/stopped after a Knowledge write failure/u)

    target.events.push({ type: 'turn/end', data: { turn: 1 } })
    target.events.push({ type: 'turn/start', data: { turn: 2 } })
    expect(target.guard(execution(target.agent, 'read', { path: 'README.md' }, 'next-turn'))).toBeUndefined()
  })

  it('stops preservation immediately after a Knowledge write failure', () => {
    const target = fixture()
    activateAndLoadMachine(target)

    const homeWrite = execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'home',
      path: 'workflow.md',
      content: 'Prior work used <work-root>/ProjectA/run.sh.',
    }, 'home-write')
    expect(target.guard(homeWrite)).toBeUndefined()
    target.result(homeWrite, success({ mode: 'create', created: true, digest: 'home-receipt' }))

    const workspaceWrite = execution(target.agent, 'slop_knowledge_write', {
      mode: 'create',
      scope: 'workspace',
      path: 'project-map.md',
      content: 'A generated row accidentally retained /projects/research/ProjectA/run.sh.',
    }, 'workspace-write')
    expect(target.guard(workspaceWrite)).toMatch(/stable anchors/u)
    target.result(workspaceWrite, {
      isError: true,
      error: { code: 'TOOL_GUARD_DENIED', message: 'Knowledge must use stable anchors.' },
      content: [{ type: 'text', text: 'Knowledge must use stable anchors.' }],
    })

    for (const [name, argumentsValue] of [
      ['slop_knowledge_write', {
        mode: 'create',
        scope: 'workspace',
        path: 'project-map.md',
        content: 'Retried with <work-root>/ProjectA/run.sh.',
      }],
      ['run_code', { code: 'return retry' }],
      ['slop_knowledge_search', { query: 'ProjectA' }],
    ] as const) {
      expect(target.guard(execution(target.agent, name, argumentsValue, `blocked-${name}`)))
        .toMatch(/stopped after a Knowledge write failure/u)
    }
  })

  it('admits host-generated pages and rejects a guessed focused workstream without remote work', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target, 'compiled-census', DISCOVERY_CENSUS_COMMAND)
    const automatic = execution(target.agent, 'slop_machine_shell', {
      machineId: MACHINE_ID, workdir: ROOT, timeoutMs: 20000,
      discovery: { phase: 'census', root: ROOT, purpose: 'select projects' },
    }, 'automatic-census')
    expect(target.guard(automatic)).toBeUndefined()
    settle(target, automatic, 'ProjectA|d\nCENSUS|emitted=1|cap=64\n')
    const input = { machineId: MACHINE_ID, workdir: PROJECT, timeoutMs: 20000,
      discovery: { phase: 'project-read', projectPath: PROJECT, purpose: 'select files', selectionPlan: [PROJECT] } }
    const project = execution(target.agent, 'slop_machine_shell', input, 'automatic-project')
    expect(target.guard(project)).toBeUndefined()
    settle(target, project, 'WORKSTREAM|./stage\n')
    const guessed = execution(target.agent, 'slop_machine_shell', { ...input, discovery: { ...input.discovery, focus: './guessed' } }, 'guessed-focus')
    expect(target.guard(guessed)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(guessed)).toMatchObject({ kind: 'evidence-not-observed' })
    expect(page.arguments).toHaveProperty('command', DISCOVERY_CENSUS_COMMAND)
  })

  it('admits an exact shared-file reference only inside this Machine declared roots', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    const selected = projectRead(target, 'shared-source')
    expect(target.guard(selected)).toBeUndefined()
    settle(target, selected, `FILE|./run.sh\nEVIDENCE|./run.sh\nbash ${ROOT}/shared/worker.sh\nbash /outside/private.sh\n`)
    const allowed = evidenceRead(target, 'shared-file', [`${ROOT}/shared/worker.sh`])
    expect(target.guard(allowed)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(allowed)).toEqual({ kind: 'execute' })
    settle(target, allowed, `FILE|${ROOT}/shared/worker.sh\n`)
    const outside = evidenceRead(target, 'outside-file', ['/outside/private.sh'])
    expect(target.guard(outside)).toBeUndefined()
    expect(target.runtime.inspectShellRequest(outside)).toMatchObject({ kind: 'evidence-not-observed' })
  })

  it('validates Host-rendered evidence tables and accepts changed sections without unchanged tables', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const page = census(target)
    expect(target.guard(page)).toBeUndefined()
    settle(target, page, 'ProjectA\n')
    const selected = projectRead(target, 'table-source')
    expect(target.guard(selected)).toBeUndefined()
    settle(target, selected, 'FILE|./run.sh\nEVIDENCE|./run.sh\n#SBATCH --partition=short\nprintf "a | b"\n')
    const write = execution(target.agent, 'slop_knowledge_write', {
      mode: 'create', scope: 'workspace', path: 'map.md', content: '# Inventory',
      contentTables: [
        { columns: ['Entry','Category','Evidence tier'], rows: [['ProjectA','confirmed-project','direct']] },
        { columns: ['Project','Edge','Source file','Active line','Status'], rows: [
          ['ProjectA','scheduler config','run.sh','#SBATCH --partition=short','direct'],
          ['ProjectA','worker command','run.sh','printf "a | b"','direct'],
        ] },
      ],
    }, 'tables')
    expect(target.guard(write)).toBeUndefined()
    target.result(write, success({ digest: 'saved', mode: 'create', created: true }))
    const update = execution(target.agent, 'slop_knowledge_write', { mode: 'update', scope: 'workspace', path: 'map.md', operation: 'replace-sections', expectedDigest: 'saved', sectionReplacements: [{ headingPath: ['Inventory'], body: 'A new supported method fact.' }] }, 'delta')
    expect(target.guard(update)).toBeUndefined()
  })

  it('allows one known rejected-write correction but preserves successful sibling receipts', () => {
    const target = fixture()
    activateAndLoadMachine(target)
    const args = { mode: 'update', scope: 'home', path: 'method.md', content: 'Reusable method', expectedDigest: 'stale' }
    const failed = execution(target.agent, 'slop_knowledge_write', args, 'failed-program:code:1')
    expect(target.guard(failed)).toBeUndefined()
    target.result(failed, { isError: true, error: { message: 'stale digest', info: { name: 'HarnessError', code: 'KNOWLEDGE_CONFLICT' } }, content: [] })
    target.result(execution(target.agent, 'run_code', {}, 'failed-program'), { isError: true, error: { message: 'nested write rejected' }, content: [] })
    const corrected = execution(target.agent, 'slop_knowledge_write', { ...args, expectedDigest: 'current' }, 'mixed-program:code:1')
    expect(target.guard(corrected)).toBeUndefined()
    target.result(corrected, success({ digest: 'saved', mode: 'update', created: false }))
    const sibling = execution(target.agent, 'slop_knowledge_write', { ...args, path: 'other.md' }, 'mixed-program:code:2')
    expect(target.guard(sibling)).toBeUndefined()
    target.result(sibling, { isError: true, error: { message: 'stale digest', info: { name: 'HarnessError', code: 'KNOWLEDGE_CONFLICT' } }, content: [] })
    target.result(execution(target.agent, 'run_code', {}, 'mixed-program'), { isError: true, error: { message: 'outer failure' }, content: [] })
    expect(target.guard(execution(target.agent, 'slop_knowledge_write', args, 'unsafe-replay'))).toMatch(/stopped after a Knowledge write failure/u)
  })

  it('releases both owned hooks', () => {
    const target = fixture()
    target.dispose()
    expect(target.offGuard).toHaveBeenCalledOnce()
    expect(target.offResult).toHaveBeenCalledOnce()
  })
})
