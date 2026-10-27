import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function text(path: string): Promise<string> {
  return (await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n')
}

async function yaml(path: string): Promise<unknown> {
  return parse(await text(path))
}

async function skillNames(): Promise<string[]> {
  const candidates = await readdir(join(root, 'skills'))
  const names = await Promise.all(candidates.map(async candidate => {
    try {
      await access(join(root, 'skills', candidate, 'SKILL.md'))
      return candidate
    } catch {
      return undefined
    }
  }))
  return names.filter((candidate): candidate is string => candidate !== undefined).sort()
}

async function skillFrontmatter(name: string): Promise<Record<string, unknown>> {
  const source = await text(`skills/${name}/SKILL.md`)
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source)
  if (match?.[1] === undefined) throw new Error(`missing frontmatter for ${name}`)
  return parse(match[1]) as Record<string, unknown>
}

describe('product composition contract', () => {
  it('adds Machine, Knowledge, and Queue to upstream Standard and Code instead of replacing DSH', async () => {
    const patch = await yaml('packages/bundle/cordis.patch.yml') as Array<Record<string, unknown>>
    expect(patch).toContainEqual(expect.objectContaining({
      id: 'agent-presets',
      disabled: false,
      config: { default: 'standard' },
    }))
    for (const id of ['jobs', 'tool-jobs', 'ui-jobs']) {
      expect(patch).toContainEqual(expect.objectContaining({ id, disabled: false }))
    }
    const insertion = patch.find(row => Array.isArray(row.insert))?.insert as Array<Record<string, unknown>>
    expect(insertion).toContainEqual(expect.objectContaining({ id: 'slop-knowledge', name: '@dsh-slop/knowledge' }))
    expect(insertion).toContainEqual(expect.objectContaining({ id: 'slop-machine', name: '@dsh-slop/machine' }))
    expect(insertion.some(row => row.id === 'slop-agent-presets')).toBe(false)
    expect((await text('packages/bundle/package.json'))).not.toContain('@deepseek-ai/dsh-agent-presets')
  })

  it('ships no product persona and exposes exactly fourteen SLOP model tools', async () => {
    const presetFiles = await readdir(join(root, 'presets'), { recursive: true }).catch(() => [] as string[])
    expect(presetFiles.filter(entry => entry.endsWith('.yml'))).toEqual([])
    const pluginPackage = JSON.parse(await text('packages/plugin/package.json')) as { exports: Record<string, unknown> }
    expect(pluginPackage.exports['./tools']).toBeUndefined()

    const sources = await Promise.all([
      text('packages/plugin/src/setup-command.ts'),
      text('packages/plugin/src/machine-tools.ts'),
      text('packages/plugin/src/queue-tools.ts'),
      text('packages/knowledge/src/tools.ts'),
    ])
    const names = sources.flatMap(source => [
      ...source.matchAll(/name: '(slop_[a-z_]+)'/gu),
      ...source.matchAll(/\bSLOP_[A-Z_]+_TOOL_NAME\s*=\s*'(slop_[a-z_]+)'/gu),
    ].map(match => match[1]))
    expect([...new Set(names)].sort()).toEqual([
      'slop_machine_connect',
      'slop_machine_get',
      'slop_machine_info_set',
      'slop_machine_list',
      'slop_machine_transfer',
      'slop_machine_shell',
      'slop_knowledge_read',
      'slop_knowledge_search',
      'slop_knowledge_write',
      'slop_queue_get',
      'slop_queue_list',
      'slop_queue_track',
      'slop_queue_update',
      'slop_setup_machine',
    ].sort())

    const knowledgeSources = await Promise.all([
      text('packages/knowledge/src/index.ts'),
      text('packages/knowledge/src/service.ts'),
      text('packages/knowledge/src/tools.ts'),
    ])
    expect(knowledgeSources.join('\n')).not.toMatch(/systemPrompt|deferContext/u)
  })

  it('does not ship the retired workflow, analysis, artifact, or job subsystems', async () => {
    const retiredPaths = [
      'packages/core/src/domain/jobs.ts',
      'packages/core/src/domain/knowledge.ts',
      'packages/core/src/domain/artifact.ts',
      'packages/core/src/continuation-policy-service.ts',
      'packages/core/src/work-handoff-service.ts',
      'packages/execution/src/analysis-runner.ts',
      'packages/execution/src/artifact-store.ts',
      'packages/execution/src/schedulers.ts',
      'packages/plugin/src/tool-catalog.ts',
      'packages/plugin/src/workspace-extension.ts',
      'packages/webui/src/ArtifactBrowser.tsx',
      'packages/webui/src/JobsCenter.tsx',
      'packages/webui/src/OnboardingSetup.tsx',
    ] as const

    for (const path of retiredPaths) {
      await expect(access(join(root, path))).rejects.toThrow()
    }
  })

  it('keeps Machine setup and protected authentication in ordinary Chat', async () => {
    const client = await text('packages/webui/src/client/index.tsx')
    for (const key of [
      'setupmachine',
      'slop-setup-machine',
      'slop-setup-machine-submission',
      'slop-machine-info',
      'slop-machine-connection',
    ]) expect(client).toContain(key)
    for (const removed of ['slop-job', 'slop-handoff', 'slop-skill-proposal', 'slop-continuation-policy']) {
      expect(client).not.toContain(removed)
    }
    const setupCard = await text('packages/webui/src/SetupConversationCard.tsx')
    expect(setupCard).toContain('inputActions.setDraft(formatSetupMachineChatSubmission(values, cardId))')
    expect(setupCard).toContain('inputActions.submit()')
    expect(client).toContain('SetupMachineSubmissionMarker')
    expect(client).not.toContain('SetupMachineSubmissionCard')
    expect(await readdir(join(root, 'packages/webui/src'))).not.toContain('SetupMachineRecoveryCard.tsx')
  })

  it('ships generic prompts for onboarding, discovery, project work, and Queue tracking', async () => {
    const expectedSkillNames = [
      'deep-discover',
      'machine-discovery',
      'machine-onboarding',
      'onboard-slop',
      'project-work',
      'queue-tracking',
    ]
    expect(await skillNames()).toEqual(expectedSkillNames)
    const frontmatters = await Promise.all(expectedSkillNames.map(async name => await skillFrontmatter(name)))
    expect(frontmatters).toEqual(expectedSkillNames.map(name => expect.objectContaining({ name })))

    const roots = await Promise.all(expectedSkillNames.map(name => text(`skills/${name}/SKILL.md`)))
    expect(roots.reduce((bytes, root) => bytes + Buffer.byteLength(root, 'utf8'), 0)).toBeLessThanOrEqual(12 * 1024)
    for (const root of roots) {
      expect(Buffer.byteLength(root, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    }
    // Validate routed resources, without requiring a particular recipe or wording.
    for (const [index, root] of roots.entries()) {
      const name = expectedSkillNames[index]
      const references = [...root.matchAll(/references\/([a-z-]+[.]md)/gu)].map(match => match[1])
      for (const reference of new Set(references)) {
        expect((await text(`skills/${name}/references/${reference}`)).trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('boots after DSH base/web and leaves model routing to deployment configuration', async () => {
    const launcher = await text('packages/launcher/src/index.ts')
    const manifest = await text('packages/launcher/src/profile-manifest.ts')
    const bundle = await text('packages/bundle/cordis.patch.yml')
    expect(`${bundle}\n${launcher}\n${manifest}`).not.toMatch(/theseus|mlx-local|baseURL|agent-default-model|llm-pi-ai/iu)
  })
})
