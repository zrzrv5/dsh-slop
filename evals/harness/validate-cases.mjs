#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const casesRoot = join(root, 'evals/cases')
const errors = []
const knownComponents = new Set(['machine', 'queue', 'knowledge'])
const thresholdFields = [
  'maxWallTimeMs',
  'maxModelCalls',
  'maxPromptTokens',
  'maxUncachedInputTokens',
  'minPostFirstCacheHitRatio',
]

function assert(condition, message) {
  if (!condition) errors.push(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function repositoryFile(caseDirectory, path, label) {
  assert(typeof path === 'string' && path.length > 0, `${label} must be a non-empty string`)
  if (typeof path !== 'string') return undefined
  const absolute = resolve(caseDirectory, path)
  const local = relative(caseDirectory, absolute)
  assert(local !== '..' && !local.startsWith('../') && !local.startsWith('..\\'), `${label} escapes its case directory`)
  return absolute
}

async function assertRepositoryFile(caseDirectory, path, label) {
  const absolute = repositoryFile(caseDirectory, path, label)
  if (absolute === undefined) return
  try {
    await access(absolute)
  } catch {
    errors.push(`${label} names a missing file`)
  }
}

function validatePolicy(policy, label, aggregateComponents) {
  assert(Array.isArray(policy.requiredComponents), `${label}.requiredComponents must be an array`)
  if (Array.isArray(policy.requiredComponents)) {
    assert(policy.requiredComponents.length > 0, `${label}.requiredComponents must not be empty`)
    for (const component of policy.requiredComponents) {
      assert(knownComponents.has(component), `${label}.requiredComponents contains unknown component ${String(component)}`)
      aggregateComponents.add(component)
    }
  }

  assert(isRecord(policy.traceRules), `${label}.traceRules must be an object`)
  assert(Array.isArray(policy.traceRules?.requiredTools), `${label}.traceRules.requiredTools must be an array`)
  assert(Array.isArray(policy.traceRules?.forbiddenTools), `${label}.traceRules.forbiddenTools must be an array`)
  for (const field of ['maxToolErrors', 'maxPruneEvents', 'maxDuplicateShellCalls']) {
    assert(Number.isInteger(policy.traceRules?.[field]), `${label}.traceRules.${field} must be an integer`)
  }

  assert(isRecord(policy.thresholds), `${label}.thresholds must be an object`)
  for (const field of thresholdFields) {
    assert(typeof policy.thresholds?.[field] === 'number', `${label}.thresholds.${field} must be numeric`)
  }
}

const entries = await readdir(casesRoot, { withFileTypes: true })
const caseDirectories = entries.filter(entry => entry.isDirectory()).map(entry => join(casesRoot, entry.name))
assert(caseDirectories.length > 0, 'evals/cases must contain at least one case')

for (const caseDirectory of caseDirectories) {
  const label = relative(root, caseDirectory)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(caseDirectory, 'case.json'), 'utf8'))
  } catch (error) {
    errors.push(`${label}/case.json is not valid JSON: ${String(error)}`)
    continue
  }

  assert(isRecord(manifest), `${label}/case.json must contain an object`)
  if (!isRecord(manifest)) continue
  assert([1, 2].includes(manifest.schemaVersion), `${label}.schemaVersion must equal 1 or 2`)
  assert(typeof manifest.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id), `${label}.id must be a lowercase slug`)
  assert(['live', 'synthetic'].includes(manifest.mode), `${label}.mode must be live or synthetic`)

  await assertRepositoryFile(caseDirectory, manifest.rubric, `${label}.rubric`)
  await assertRepositoryFile(caseDirectory, manifest.reference, `${label}.reference`)

  const aggregateComponents = new Set()
  if (manifest.schemaVersion === 1) {
    await assertRepositoryFile(caseDirectory, manifest.prompt, `${label}.prompt`)
    validatePolicy(manifest, label, aggregateComponents)
  } else if (manifest.schemaVersion === 2) {
    assert(Array.isArray(manifest.stages) && manifest.stages.length > 0, `${label}.stages must be a non-empty array`)
    const stageIds = new Set()
    if (Array.isArray(manifest.stages)) {
      for (const [index, stage] of manifest.stages.entries()) {
        const stageLabel = `${label}.stages[${String(index)}]`
        assert(isRecord(stage), `${stageLabel} must be an object`)
        if (!isRecord(stage)) continue
        assert(typeof stage.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stage.id), `${stageLabel}.id must be a lowercase slug`)
        assert(!stageIds.has(stage.id), `${stageLabel}.id must be unique`)
        stageIds.add(stage.id)
        assert(typeof stage.session === 'string' && stage.session.length > 0, `${stageLabel}.session must be a non-empty string`)
        assert(Number.isInteger(stage.turn) && stage.turn > 0, `${stageLabel}.turn must be a positive integer`)
        await assertRepositoryFile(caseDirectory, stage.prompt, `${stageLabel}.prompt`)
        if (stage.validator !== undefined) {
          await assertRepositoryFile(caseDirectory, stage.validator, `${stageLabel}.validator`)
        }
        validatePolicy(stage, stageLabel, aggregateComponents)
      }
    }
  }

  for (const component of knownComponents) {
    assert(aggregateComponents.has(component), `${label} must exercise ${component} in at least one stage`)
  }
}

const runtimeRoots = ['packages', 'skills']
for (const runtimeRoot of runtimeRoots) {
  const pending = [join(root, runtimeRoot)]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!['dist', 'lib', 'node_modules'].includes(entry.name)) pending.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const source = await readFile(absolute, 'utf8').catch(() => '')
      assert(!source.includes('evals/cases/'), `${relative(root, absolute)} must not import or load eval cases`)
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.map(error => `- ${error}`).join('\n')}\n`)
  process.exit(1)
}

process.stdout.write(`validated ${String(caseDirectories.length)} independent eval cases\n`)
