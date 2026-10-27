#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [caseInput, traceInput, stageInput, turnOverride] = process.argv.slice(2)
if (caseInput === undefined || traceInput === undefined) {
  process.stderr.write('usage: assert-case-trace.mjs <case-directory> <session.jsonl[.zstd]> [stage-id] [turn]\n')
  process.exit(1)
}

const directory = dirname(fileURLToPath(import.meta.url))
const caseDirectory = resolve(caseInput)
const manifest = JSON.parse(readFileSync(resolve(caseDirectory, 'case.json'), 'utf8'))
let policy = manifest
let stageId
let turn
if (manifest.schemaVersion === 2) {
  if (stageInput === undefined) {
    process.stderr.write(`case ${String(manifest.id)} requires a stage id\n`)
    process.exit(1)
  }
  policy = manifest.stages.find(stage => stage.id === stageInput)
  if (policy === undefined) {
    process.stderr.write(`unknown stage ${stageInput}; expected one of ${manifest.stages.map(stage => stage.id).join(', ')}\n`)
    process.exit(1)
  }
  stageId = policy.id
  turn = turnOverride ?? String(policy.turn)
} else {
  turn = stageInput
}
const analyzerArguments = [resolve(directory, 'analyze-dsh-trace.mjs'), resolve(traceInput)]
if (turn !== undefined) analyzerArguments.push(turn)
const analysis = spawnSync(process.execPath, analyzerArguments, {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
})

if (analysis.status !== 0) {
  process.stderr.write(analysis.stderr)
  process.exit(analysis.status ?? 1)
}

const report = JSON.parse(analysis.stdout)
const failures = []
const rules = policy.traceRules
const thresholds = policy.thresholds

const reasonKind = typeof report.reason === 'string' ? report.reason : report.reason?.kind
if (reasonKind !== 'completed') failures.push(`turn reason is ${String(reasonKind)}, expected completed`)
for (const tool of rules.requiredTools) {
  if ((report.toolCounts[tool] ?? 0) === 0) failures.push(`required Tool ${tool} was not called`)
}
for (const tool of rules.forbiddenTools) {
  if ((report.toolCounts[tool] ?? 0) !== 0) failures.push(`forbidden Tool ${tool} was called`)
}
if (report.toolErrors > rules.maxToolErrors) failures.push(`tool errors ${String(report.toolErrors)} exceed ${String(rules.maxToolErrors)}`)
if (report.compaction.pruneEvents > rules.maxPruneEvents) failures.push(`prune events ${String(report.compaction.pruneEvents)} exceed ${String(rules.maxPruneEvents)}`)
if (report.shell.duplicateCalls > rules.maxDuplicateShellCalls) failures.push(`duplicate shell calls ${String(report.shell.duplicateCalls)} exceed ${String(rules.maxDuplicateShellCalls)}`)
if (report.shell.projectReadsAfterFailure > 0) failures.push(`project reads after a failed project frontier: ${String(report.shell.projectReadsAfterFailure)}`)
if (report.wallTimeMs > thresholds.maxWallTimeMs) failures.push(`wall time ${String(report.wallTimeMs)} exceeds ${String(thresholds.maxWallTimeMs)}`)
if (report.modelCalls > thresholds.maxModelCalls) failures.push(`model calls ${String(report.modelCalls)} exceed ${String(thresholds.maxModelCalls)}`)
if (report.usage.totalPromptTokens > thresholds.maxPromptTokens) failures.push(`prompt tokens ${String(report.usage.totalPromptTokens)} exceed ${String(thresholds.maxPromptTokens)}`)
if (report.usage.uncachedInputTokens > thresholds.maxUncachedInputTokens) failures.push(`uncached input ${String(report.usage.uncachedInputTokens)} exceeds ${String(thresholds.maxUncachedInputTokens)}`)
if (report.usage.postFirstCacheHitRatio < thresholds.minPostFirstCacheHitRatio) failures.push(`post-first cache hit ${String(report.usage.postFirstCacheHitRatio)} is below ${String(thresholds.minPostFirstCacheHitRatio)}`)

if (typeof policy.validator === 'string') {
  const validatorPath = resolve(caseDirectory, policy.validator)
  const validation = spawnSync(process.execPath, [validatorPath, resolve(traceInput), stageId ?? '', String(turn)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (validation.status !== 0) {
    failures.push(validation.stderr.trim() || `semantic validator exited with status ${String(validation.status)}`)
  } else {
    try {
      const semantic = JSON.parse(validation.stdout)
      if (!Array.isArray(semantic.failures)) throw new Error('missing failures array')
      failures.push(...semantic.failures.map(failure => `semantic: ${String(failure)}`))
    } catch (error) {
      failures.push(`semantic validator returned invalid JSON: ${String(error)}`)
    }
  }
}

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  caseId: manifest.id,
  ...(stageId === undefined ? {} : { stageId }),
  passed: failures.length === 0,
  failures,
  report,
}, null, 2)}\n`)

if (failures.length > 0) process.exit(1)
