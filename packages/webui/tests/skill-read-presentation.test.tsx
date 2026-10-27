// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillReadBase, registerSkillReadPresentation } from '../src/skill-read-presentation.tsx'
import type { Context } from '@deepseek-ai/cordis'

afterEach(cleanup)
const root = '/opt/dsh/assets/skills'
describe('bundled Skill read presentation', () => {
  it('recognizes Windows paths while preserving the original display base', () => {
    const windowsRoot = 'C:\\User Files\\slop\\skills'
    expect(bundledSkillReadBase(JSON.stringify({ file_path: `${windowsRoot}\\project-work\\SKILL.md` }), windowsRoot)).toBe(windowsRoot)
    expect(bundledSkillReadBase(JSON.stringify({ file_path: `${windowsRoot}\\project-work\\..\\private` }), windowsRoot)).toBeUndefined()
  })
  it.each(['machine-discovery/references/root-census.md', 'project-work/references/transfer.md'])('shortens a known bundled resource %s', path => {
    expect(bundledSkillReadBase(JSON.stringify({ file_path: `${root}/${path}` }), root)).toBe(root)
  })
  it.each(['/opt/dsh/assets/skills-evil/machine-discovery/SKILL.md', '/work/SKILL.md', `${root}/other/SKILL.md`, `${root}/machine-discovery/../../private`])('keeps unrelated or escaping paths intact: %s', path => {
    expect(bundledSkillReadBase(JSON.stringify({ file_path: path }), root)).toBeUndefined()
  })
  it('delegates to the original read component without changing its args or file opener', () => {
    let wrapper: ((props: never) => unknown) | undefined
    const NativeRead = (props: { cwd?: string; block: { argsRaw?: string } }) => createElement('span', { 'data-testid': 'read', 'data-cwd': props.cwd }, props.block.argsRaw ?? '')
    const ctx = { slots: {
      entriesOfSlot: () => [{ options: { key: 'read' }, component: NativeRead }],
      inject: (_key: string, callback: () => unknown) => callback(),
      register: (_options: unknown, component: typeof wrapper) => { wrapper = component; return () => {} },
    } } as unknown as Context
    registerSkillReadPresentation(ctx)
    Object.assign(globalThis, { __DSH_SLOP_BOOT__: { csrfNonce: '0123456789abcdef', browserBootstrapPath: '/dsh-slop/browser-bootstrap', knowledgeSettingsBridgePath: '/dsh-slop/knowledge-settings', queueSettingsBridgePath: '/dsh-slop/queue-settings', bundledSkillRoot: root } })
    const argsRaw = JSON.stringify({ file_path: `${root}/machine-discovery/SKILL.md` })
    if (!wrapper) throw new Error('read adapter not registered')
    const Component = wrapper as typeof NativeRead
    render(createElement(Component, { cwd: '/workspace', block: { argsRaw } }))
    expect(screen.getByTestId('read').getAttribute('data-cwd')).toBe(root)
    cleanup()
    render(createElement(Component, { cwd: '/workspace', block: {} }))
    expect(screen.getByTestId('read').getAttribute('data-cwd')).toBe('/workspace')
  })
})
