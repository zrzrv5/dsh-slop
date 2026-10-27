import { createElement, type ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { browserBoot } from './browser-boot.ts'
import { displayHostPath } from './host-path.ts'

const BUNDLED_SKILLS = new Set(['onboard-slop', 'deep-discover', 'machine-onboarding', 'machine-discovery', 'project-work', 'queue-tracking'])

/** Change only the native row's display base; arguments and open-file paths stay exact. */
export function bundledSkillReadBase(argsRaw: string, root: string | undefined): string | undefined {
  const normalized = root === undefined ? undefined : displayHostPath(root)
  if (normalized === undefined) return undefined
  let args: unknown
  try { args = JSON.parse(argsRaw) } catch { return undefined }
  if (args === null || typeof args !== 'object' || !('file_path' in args) || typeof args.file_path !== 'string') return undefined
  const prefix = `${normalized}/`
  const path = displayHostPath(args.file_path)
  if (path === undefined || !path.startsWith(prefix)) return undefined
  const parts = path.slice(prefix.length).split('/')
  if (!BUNDLED_SKILLS.has(parts[0] ?? '') || parts.length < 2 || parts.some(part => part === '..' || part === '.' || part === '')) return undefined
  return root
}

/** Decorate the public native read seat without replacing its expansion or file actions. */
export function registerSkillReadPresentation(ctx: Context): void {
  ctx.slots.inject('tool.call.toolview', () => {
    const native = ctx.slots.entriesOfSlot('tool.call.toolview').find(entry => entry.options.key === 'read')
    if (native === undefined || typeof native.component !== 'function') throw new Error('The native DSH read view must be mounted before the Skill display adapter.')
    const NativeRead = native.component as ComponentType<ToolCallViewProps>
    return ctx.slots.register({ name: 'tool.call.toolview', key: 'read', priority: -10, locale: 'conversation' }, props => {
      const call = 'kind' in props.block ? props.block.call : props.block
      const base = call != null && 'argsRaw' in call ? bundledSkillReadBase(call.argsRaw, browserBoot()?.bundledSkillRoot) : undefined
      return createElement(NativeRead, base === undefined ? props : { ...props, cwd: base })
    })
  })
}
