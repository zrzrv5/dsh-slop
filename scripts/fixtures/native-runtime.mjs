import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DshQueueRuntime, queueSessionTargetForAgent } from '../../packages/plugin/lib/types/queue-runtime.js'

const pluginRequire = createRequire(new URL('../../packages/plugin/package.json', import.meta.url))
const { LlmAdapter } = await import(pathToFileURL(pluginRequire.resolve('@deepseek-ai/dsh-llm')).href)
const { STRUCTURED_OUTPUT_TOOL } = await import(pathToFileURL(pluginRequire.resolve('@deepseek-ai/dsh-subagent')).href)

class ObservationFixture extends LlmAdapter {
  calls = 0
  lastModel
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    this.calls++
    this.lastModel = { provider: options.provider, id: options.model }
    assert.equal(this.calls, 1, 'Only the query worker may call the fixture model')
    assert.deepEqual(options.tools.map(tool => tool.name).sort(), ['bash', STRUCTURED_OUTPUT_TOOL].sort())
    const args = JSON.stringify({ observations: [] })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'observation', name: STRUCTURED_OUTPUT_TOOL, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'observation', name: STRUCTURED_OUTPUT_TOOL, arguments: args } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Runs inside a temporary Host, using the shipped providers and public services. */
export async function verifyNativeRuntime(ctx, directory) {
  await mkdir(directory)
  const repository = await realpath(directory)
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: repository, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'DSH smoke')
  git('config', 'user.email', 'smoke@example.invalid')
  // Windows runners default to core.autocrlf=true; the checks compare exact bytes.
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(repository, 'tracked.txt'), 'committed\n')
  git('add', 'tracked.txt')
  git('commit', '-m', 'fixture')
  await writeFile(join(repository, 'tracked.txt'), 'dirty\n')
  const workspace = await ctx.workspaceRegistry.create(repository, 'Original project')
  const adapter = new ObservationFixture()
  const releaseAdapter = ctx.llm.registerAdapter(['queue-smoke', 'queue-smoke-fallback'], adapter)
  const owner = await ctx.agents.create({ sessionId: 'native-runtime-smoke', agentOptions: { provider: 'queue-smoke', model: 'fixture' }, meta: { cwd: repository, agentPreset: 'standard' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard') } })
  try {
    const before = queueSessionTargetForAgent(owner.agent)
    const worktree = await ctx.worktrees.create(owner.agent, { name: 'smoke' })
    assert.equal(ctx.workingDirectory.get(owner.agent.session), worktree.path)
    assert.equal(owner.agent.session.header.cwd, repository)
    assert.deepEqual(queueSessionTargetForAgent(owner.agent), before)
    assert.equal(await readFile(join(worktree.path, 'tracked.txt'), 'utf8'), 'committed\n')
    assert.equal(await readFile(join(repository, 'tracked.txt'), 'utf8'), 'dirty\n')
    const knowledge = await ctx.slopKnowledge.search({ query: 'smoke' }, owner.agent)
    assert.equal(knowledge.sources.find(source => source.kind === 'workspace')?.workspaceId, workspace.id)
    assert.equal(knowledge.sources.find(source => source.kind === 'workspace')?.workspacePath, repository)
    const messages = owner.agent.session.deriveMessages().length
    const queue = new DshQueueRuntime(ctx, { fallbackAgentOptions: () => ({ provider: 'queue-smoke-fallback', model: 'fallback-fixture' }) })
    try {
      const result = await queue.query({ batchId: 'smoke', parent: before, target: { kind: 'local' }, observerKind: 'process', items: [], prompt: 'Return an empty observation batch.' })
      assert.deepEqual(result, { observations: [] })
      assert.equal(adapter.calls, 1)
      assert.equal(adapter.lastModel.provider, 'queue-smoke-fallback')
      assert.equal(adapter.lastModel.id, 'fallback-fixture')
      assert.equal(owner.agent.options.provider, 'queue-smoke')
      assert.equal(owner.agent.options.model, 'fixture')
      assert.equal(owner.agent.session.deriveMessages().length, messages, 'Caller delivery must not notify or wake the parent')
    } finally { queue.close() }
  } finally { await owner.dispose(); releaseAdapter() }

  for (const target of ['local', 'machine']) {
    const worker = await ctx.agents.create({ sessionId: `queue-${target}-smoke`, meta: { cwd: repository, agentPreset: `slop-queue-query-${target}` }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, `slop-queue-query-${target}`) } })
    try {
      assert.deepEqual(ctx.tools.schemas(worker.agent).map(tool => tool.name).sort(), target === 'local' ? ['bash'] : ['slop_machine_shell'])
    } finally { await worker.dispose() }
  }

  const stateOwner = {}
  const run = (program, owner = stateOwner) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, bindings: [], stateOwner: owner, cwd: repository }))
  try {
    assert.equal((await run('let count: number = 40')).error, undefined)
    assert.equal((await run('count += 2; count')).value, 42)
    assert.equal((await run('typeof count', {})).value, 'undefined')
    await ctx.ptcRuntime.release(stateOwner)
    assert.equal((await run('typeof count')).value, 'undefined')
  } finally { await ctx.ptcRuntime.release(stateOwner) }
  return { worktree: 'passed', originalWorkspaceAndQueueOwner: 'preserved', queryWorkerTools: 'restricted', queueActivation: 'configured fallback route, structured result without parent notice', ptcMemory: 'retained, isolated and released' }
}
