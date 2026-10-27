#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function traceText(path) {
  if (!path.endsWith('.zstd')) return readFileSync(path, 'utf8')
  const result = spawnSync('zstdcat', [path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) fail(result.stderr || `zstdcat failed with status ${String(result.status)}`)
  return result.stdout
}

function parseJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function resultBlocks(event) {
  const messageContent = event.data?.message?.content
  if (!Array.isArray(messageContent)) return []
  return messageContent.filter(block => block?.type === 'tool-result')
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('')
}

function resultText(block) {
  return contentText(block?.content)
}

function countTools(calls) {
  return Object.fromEntries([...new Set(calls.map(call => call.name))]
    .sort()
    .map(name => [name, calls.filter(call => call.name === name).length]))
}

function percentile95(values) {
  if (values.length === 0) return undefined
  return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]
}

function finalAssistantText(events) {
  const messages = events.filter(event => event.type === 'assistant/message')
  const content = messages.at(-1)?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

const [path, turnInput] = process.argv.slice(2)
if (path === undefined) fail('usage: analyze-dsh-trace.mjs <session.jsonl[.zstd]> [turn]')

const allEvents = traceText(path)
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line)
    } catch {
      fail(`invalid JSON on line ${String(index + 1)}`)
    }
  })

const turns = allEvents
  .filter(event => event.type === 'turn/start' && Number.isInteger(event.data?.turn))
  .map(event => event.data.turn)
const turn = turnInput === undefined ? turns.at(-1) : Number(turnInput)
if (!Number.isInteger(turn)) fail('trace has no numeric turn to analyze')

const start = allEvents.find(event => event.type === 'turn/start' && event.data?.turn === turn)
const end = allEvents.find(event => event.type === 'turn/end' && event.data?.turn === turn)
if (start === undefined) fail(`turn ${String(turn)} does not exist`)
const endSeq = end?.seq ?? Number.POSITIVE_INFINITY
const events = allEvents.filter(event => {
  if (event.seq < start.seq || event.seq > endSeq) return false
  return event.data?.turn === undefined || event.data.turn === turn
})

const sessionHeader = allEvents.find(event => event.type === 'session')
let agentPreset = typeof sessionHeader?.agentPreset === 'string' ? sessionHeader.agentPreset : undefined
for (const event of allEvents) {
  if (typeof event.seq === 'number' && event.seq > endSeq) continue
  if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
    agentPreset = event.data.agentPreset
  }
}

const directCalls = events
  .filter(event => event.type === 'tool/call')
  .map(event => ({
    seq: event.seq,
    time: event.time,
    callId: event.data.callId,
    name: event.data.name,
    arguments: parseJson(event.data.arguments),
  }))
const directCallsById = new Map(directCalls.map(call => [call.callId, call]))
const runCodeCalls = directCalls.filter(call => call.name === 'run_code')
const runCodeCallIds = new Set(runCodeCalls.map(call => call.callId))

const codeDispatchCallsById = new Map()
for (const event of events.filter(candidate => candidate.type === 'tool/code-dispatch-start')) {
  if (!runCodeCallIds.has(event.data?.parentCallId)) continue
  const callId = event.data?.subCallId
  if (typeof callId !== 'string' || codeDispatchCallsById.has(callId)) continue
  codeDispatchCallsById.set(callId, {
    seq: event.seq,
    time: event.time,
    callId,
    parentCallId: event.data.parentCallId,
    name: event.data.name,
    arguments: parseJson(event.data.arguments),
  })
}
for (const event of events.filter(candidate => candidate.type === 'tool/code-dispatch')) {
  if (!runCodeCallIds.has(event.data?.parentCallId)) continue
  const callId = event.data?.subCallId
  if (typeof callId !== 'string' || codeDispatchCallsById.has(callId)) continue
  codeDispatchCallsById.set(callId, {
    seq: event.seq,
    time: undefined,
    callId,
    parentCallId: event.data.parentCallId,
    name: event.data.name,
    arguments: parseJson(event.data.arguments),
  })
}

// run_code is transport for the nested dispatches, not another domain-tool call.
const logicalDirectCalls = directCalls.filter(call => call.name !== 'run_code')
const logicalDirectCallIds = new Set(logicalDirectCalls.map(call => call.callId))
const codeDispatchCalls = [...codeDispatchCallsById.values()]
  .filter(call => !logicalDirectCallIds.has(call.callId))
  .sort((left, right) => left.seq - right.seq)
const calls = [...logicalDirectCalls, ...codeDispatchCalls]
const toolCounts = countTools(calls)

const directResultsByCallId = new Map()
for (const event of events.filter(candidate => candidate.type === 'tool/result')) {
  for (const block of resultBlocks(event)) {
    if (directResultsByCallId.has(block.toolCallId)) continue
    const text = resultText(block)
    const bytes = Buffer.byteLength(text, 'utf8')
    const call = directCallsById.get(block.toolCallId)
    const parsed = parseJson(text)
    directResultsByCallId.set(block.toolCallId, {
      callId: block.toolCallId,
      toolName: call?.name,
      isError: block.isError === true,
      ok: parsed?.ok,
      resultBytes: bytes,
      durationMs: typeof call.time === 'number' && typeof event.time === 'number'
        ? Math.max(0, event.time - call.time)
        : undefined,
      errorCode: parsed?.error?.code,
      exitCode: parsed?.value?.exitCode,
    })
  }
}

const codeDispatchResultsByCallId = new Map()
for (const event of events.filter(candidate => candidate.type === 'tool/code-dispatch')) {
  if (!runCodeCallIds.has(event.data?.parentCallId)) continue
  const callId = event.data?.subCallId
  if (typeof callId !== 'string' || codeDispatchResultsByCallId.has(callId)) continue
  const text = contentText(event.data?.content)
  const call = codeDispatchCallsById.get(callId)
  const parsed = parseJson(text)
  codeDispatchResultsByCallId.set(callId, {
    callId,
    toolName: call?.name ?? event.data?.name,
    isError: event.data?.isError === true,
    ok: parsed?.ok,
    resultBytes: Buffer.byteLength(text, 'utf8'),
    durationMs: typeof call?.time === 'number' && typeof event.time === 'number'
      ? Math.max(0, event.time - call.time)
      : undefined,
    errorCode: parsed?.error?.code,
    exitCode: parsed?.value?.exitCode,
  })
}

const directOutcomes = [...directResultsByCallId.values()]
const logicalDirectOutcomes = directOutcomes.filter(outcome => outcome.toolName !== 'run_code')
const logicalDirectOutcomeIds = new Set(logicalDirectOutcomes.map(outcome => outcome.callId))
const codeDispatchOutcomes = [...codeDispatchResultsByCallId.values()]
  .filter(outcome => !logicalDirectOutcomeIds.has(outcome.callId))
const outcomes = [...logicalDirectOutcomes, ...codeDispatchOutcomes]
const outcomesByCallId = new Map(outcomes.map(outcome => [outcome.callId, outcome]))
const toolResultBytes = directOutcomes.reduce((sum, outcome) => sum + outcome.resultBytes, 0)
const innerToolResultBytes = codeDispatchOutcomes.reduce((sum, outcome) => sum + outcome.resultBytes, 0)
const toolErrors = outcomes.filter(outcome => outcome.isError).length
const shellOutcomes = outcomes.filter(outcome => outcome.toolName === 'slop_machine_shell')
const directShellResultBytes = logicalDirectOutcomes
  .filter(outcome => outcome.toolName === 'slop_machine_shell')
  .reduce((sum, outcome) => sum + outcome.resultBytes, 0)
const nonzeroShellExits = shellOutcomes
  .filter(outcome => Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0)
  .map(outcome => ({ callId: outcome.callId, exitCode: outcome.exitCode }))

const usages = events
  .filter(event => event.type === 'assistant/message' && event.data?.usage !== undefined)
  .map(event => event.data.usage)
const uncachedInputTokens = usages.reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0)
const cacheReadTokens = usages.reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0)
const outputTokens = usages.reduce((sum, usage) => sum + (usage.outputTokens ?? 0), 0)
const totalPromptTokens = uncachedInputTokens + cacheReadTokens
const postFirstUsages = usages.slice(1)
const postFirstUncachedInputTokens = postFirstUsages
  .reduce((sum, usage) => sum + (usage.inputTokens ?? 0), 0)
const postFirstCacheReadTokens = postFirstUsages
  .reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0)
const postFirstTotalPromptTokens = postFirstUncachedInputTokens + postFirstCacheReadTokens

const shellCalls = calls.filter(call => call.name === 'slop_machine_shell')
const projectReadCalls = shellCalls.filter(call => call.arguments?.discovery?.phase === 'project-read')
const projectCallCounts = new Map()
for (const call of projectReadCalls) {
  const projectPath = call.arguments?.discovery?.projectPath
  if (typeof projectPath !== 'string') continue
  projectCallCounts.set(projectPath, (projectCallCounts.get(projectPath) ?? 0) + 1)
}
const failedProjectPaths = new Set()
let projectReadsAfterFailure = 0
for (const call of projectReadCalls) {
  const projectPath = call.arguments?.discovery?.projectPath
  if (typeof projectPath !== 'string') continue
  if (failedProjectPaths.has(projectPath)) projectReadsAfterFailure += 1
  const outcome = outcomesByCallId.get(call.callId)
  if (outcome === undefined) continue
  const failed = outcome.isError
    || outcome.ok === false
    || (Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0)
  if (failed) failedProjectPaths.add(projectPath)
}
const duplicateKeys = new Map()
for (const call of shellCalls) {
  const args = call.arguments ?? {}
  const operation = typeof args.command === 'string'
    ? ['command', args.command]
    : ['evidenceFiles', args.evidenceFiles, args.evidenceTerms]
  const key = JSON.stringify([args.machineId, args.workdir, operation])
  duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1)
}
const duplicateShellCalls = [...duplicateKeys.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
const dangerousPattern = /(?:\b(?:du|tree|ls)\s+-[^\n]*[Rr]|\b(?:grep|rg)\s+-(?:[^\n ]*r|[^\n ]*R)|\bfind\b(?![^\n]*-maxdepth)|\bsort\b[^|\n]*\|[^\n]*\bhead\b)/u

const prunes = events.filter(event => event.type === 'compaction/prune')
const finalText = finalAssistantText(events)
const completedShellDurations = shellOutcomes
  .map(outcome => outcome.durationMs)
  .filter(duration => typeof duration === 'number')
  .sort((left, right) => left - right)
const completedInnerDurations = codeDispatchOutcomes
  .map(outcome => outcome.durationMs)
  .filter(duration => typeof duration === 'number')
  .sort((left, right) => left - right)
const runCodeOutcomes = directOutcomes.filter(outcome => outcome.toolName === 'run_code')
const report = {
  schemaVersion: 1,
  turn,
  agentPreset: agentPreset ?? null,
  reason: end?.data?.reason,
  wallTimeMs: end === undefined ? undefined : end.time - start.time,
  steps: events.filter(event => event.type === 'step/end').length,
  modelCalls: usages.length,
  toolCounts,
  toolCallSources: {
    direct: countTools(logicalDirectCalls),
    codeDispatch: countTools(codeDispatchCalls),
  },
  toolErrors,
  runCode: {
    calls: runCodeCalls.length,
    failed: runCodeOutcomes.filter(outcome => outcome.isError).length,
    programBytes: runCodeCalls.reduce((sum, call) => sum + (
      typeof call.arguments?.code === 'string' ? Buffer.byteLength(call.arguments.code, 'utf8') : 0
    ), 0),
    modelVisibleResultBytes: runCodeOutcomes.reduce((sum, outcome) => sum + outcome.resultBytes, 0),
    innerDispatches: codeDispatchCalls.length,
    innerSettled: codeDispatchOutcomes.length,
    innerToolErrors: codeDispatchOutcomes.filter(outcome => outcome.isError).length,
    innerCanonicalErrors: codeDispatchOutcomes.filter(outcome => outcome.ok === false).length,
    innerLoggedResultBytes: innerToolResultBytes,
    innerSummedCallDurationMs: completedInnerDurations.reduce((sum, duration) => sum + duration, 0),
    innerP95CallDurationMs: percentile95(completedInnerDurations),
    innerMaxCallDurationMs: completedInnerDurations.at(-1),
  },
  shell: {
    calls: shellCalls.length,
    accepted: shellOutcomes.filter(outcome => !outcome.isError).length,
    deniedOrFailedByTool: shellOutcomes.filter(outcome => outcome.isError).length,
    censusCalls: shellCalls.filter(call => call.arguments?.discovery?.phase === 'census').length,
    projectReadCalls: projectReadCalls.length,
    distinctProjectPaths: projectCallCounts.size,
    maxCallsForOneProject: Math.max(0, ...projectCallCounts.values()),
    missingWorkdir: shellCalls.filter(call => typeof call.arguments?.workdir !== 'string').length,
    missingDiscoveryMetadata: shellCalls.filter(call => call.arguments?.discovery === undefined).length,
    timeoutOver20Seconds: shellCalls.filter(call => (call.arguments?.timeoutMs ?? Number.POSITIVE_INFINITY) > 20_000).length,
    duplicateCalls: duplicateShellCalls,
    projectReadsAfterFailure,
    commandsMatchingCoarseHazardPattern: shellCalls.filter(call => dangerousPattern.test(call.arguments?.command ?? '')).length,
    nonzeroExits: nonzeroShellExits,
    boundsErrors: shellOutcomes.filter(outcome => outcome.errorCode === 'DISCOVERY_RESULT_BOUNDS').length,
    modelVisibleResultBytes: directShellResultBytes,
    innerLoggedResultBytes: codeDispatchOutcomes
      .filter(outcome => outcome.toolName === 'slop_machine_shell')
      .reduce((sum, outcome) => sum + outcome.resultBytes, 0),
    summedCallDurationMs: completedShellDurations.reduce((sum, duration) => sum + duration, 0),
    p95CallDurationMs: percentile95(completedShellDurations),
    maxCallDurationMs: completedShellDurations.at(-1),
  },
  knowledge: {
    searches: toolCounts.slop_knowledge_search ?? 0,
    reads: toolCounts.slop_knowledge_read ?? 0,
    writes: toolCounts.slop_knowledge_write ?? 0,
  },
  machineInfoWrites: toolCounts.slop_machine_info_set ?? 0,
  usage: {
    uncachedInputTokens,
    cacheReadTokens,
    totalPromptTokens,
    outputTokens,
    cacheHitRatio: totalPromptTokens === 0 ? 0 : cacheReadTokens / totalPromptTokens,
    postFirstUncachedInputTokens,
    postFirstCacheReadTokens,
    postFirstTotalPromptTokens,
    postFirstCacheHitRatio: postFirstTotalPromptTokens === 0
      ? 0
      : postFirstCacheReadTokens / postFirstTotalPromptTokens,
  },
  compaction: {
    pruneEvents: prunes.length,
    prunedTokens: prunes.reduce((sum, event) => sum + (event.data?.shadowedTokenCount ?? 0), 0),
  },
  allToolResultBytes: toolResultBytes,
  innerLoggedToolResultBytes: innerToolResultBytes,
  finalResponseBytes: Buffer.byteLength(finalText, 'utf8'),
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
