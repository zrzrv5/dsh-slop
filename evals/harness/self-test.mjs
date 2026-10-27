#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const analyzer = resolve(directory, 'analyze-dsh-trace.mjs')
const fixture = resolve(directory, 'fixtures/code-mode.jsonl')
const run = spawnSync(process.execPath, [analyzer, fixture], { encoding: 'utf8' })

if (run.status !== 0) {
  process.stderr.write(run.stderr)
  process.exit(run.status ?? 1)
}

const report = JSON.parse(run.stdout)
const reportReasonKind = typeof report.reason === 'string' ? report.reason : report.reason?.kind
const assertions = [
  [report.agentPreset === 'code', 'agentPreset'],
  [reportReasonKind === 'completed', 'reason.kind'],
  [report.modelCalls === 1, 'modelCalls'],
  [report.runCode.calls === 1, 'runCode.calls'],
  [report.runCode.innerDispatches === 1, 'runCode.innerDispatches'],
  [report.shell.calls === 1, 'shell.calls'],
  [report.shell.projectReadCalls === 1, 'shell.projectReadCalls'],
  [report.shell.projectReadsAfterFailure === 0, 'shell.projectReadsAfterFailure'],
  [report.shell.nonzeroExits.length === 0, 'shell.nonzeroExits'],
  [report.usage.totalPromptTokens === 400, 'usage.totalPromptTokens'],
  [report.usage.cacheHitRatio === 0.75, 'usage.cacheHitRatio'],
]

const failures = assertions.filter(([passed]) => !passed).map(([, label]) => label)
if (failures.length > 0) {
  process.stderr.write(`analyzer self-test failed: ${failures.join(', ')}\n`)
  process.exit(1)
}

process.stdout.write('trace analyzer self-test passed\n')

const failedFrontierFixture = resolve(directory, 'fixtures/project-retry-after-failure.jsonl')
const failedFrontierRun = spawnSync(process.execPath, [analyzer, failedFrontierFixture], { encoding: 'utf8' })
if (failedFrontierRun.status !== 0) {
  process.stderr.write(failedFrontierRun.stderr)
  process.exit(failedFrontierRun.status ?? 1)
}
const failedFrontierReport = JSON.parse(failedFrontierRun.stdout)
if (failedFrontierReport.shell.projectReadsAfterFailure !== 1) {
  process.stderr.write('analyzer self-test did not detect a project read after failure\n')
  process.exit(1)
}

process.stdout.write('failed project frontier self-test passed\n')

const gate = spawnSync(process.execPath, [
  resolve(directory, 'assert-case-trace.mjs'),
  resolve(directory, '../cases/cross-machine-project-reuse'),
  fixture,
], { encoding: 'utf8' })

if (gate.status === 0) {
  process.stderr.write('case gate self-test expected the incomplete fixture to fail\n')
  process.exit(1)
}

const gateReport = JSON.parse(gate.stdout)
if (gateReport.passed !== false || !gateReport.failures.some(failure => failure.includes('slop_queue_list'))) {
  process.stderr.write('case gate self-test did not report the missing Queue call\n')
  process.exit(1)
}
if (gateReport.failures.some(failure => failure.includes('turn reason'))) {
  process.stderr.write('case gate self-test misclassified a completed turn\n')
  process.exit(1)
}

process.stdout.write('case trace gate self-test passed\n')

const stagedGate = spawnSync(process.execPath, [
  resolve(directory, 'assert-case-trace.mjs'),
  resolve(directory, 'fixtures/staged-knowledge-recall'),
  fixture,
  'recall',
], { encoding: 'utf8' })

if (stagedGate.status === 0) {
  process.stderr.write('staged case gate self-test expected the incomplete fixture to fail\n')
  process.exit(1)
}

const stagedGateReport = JSON.parse(stagedGate.stdout)
if (stagedGateReport.stageId !== 'recall' || !stagedGateReport.failures.some(failure => failure.includes('slop_knowledge_search'))) {
  process.stderr.write('staged case gate self-test did not select the recall policy\n')
  process.exit(1)
}

process.stdout.write('staged case trace gate self-test passed\n')
