import { normalizeBehaviorLevels, type BehaviorPromptOverrides } from '@dsh-slop/runtime-base/behavior-catalog'
import type { BehaviorSettingsSource, BehaviorSettingsView } from '../BehaviorSettings.tsx'
import { describeNamespace, isRecord, updateNamespace, type NamespaceView, type SettingsRemote } from './settings-remote.ts'

export type { SettingsRemote } from './settings-remote.ts'

/** Profile entry id of the SLOP runtime, which owns the Agent behavior settings. */
export const BEHAVIOR_SETTINGS_NAMESPACE = 'slop-runtime'

function overridesOf(value: unknown): BehaviorPromptOverrides {
  if (!isRecord(value) || !Object.values(value).every(text => typeof text === 'string')) return {}
  return value as Record<string, string>
}

function viewOf(namespace: NamespaceView | undefined, writable: boolean): BehaviorSettingsView {
  if (namespace === undefined || !isRecord(namespace.value) || typeof namespace.revision !== 'number') {
    throw new Error('The SLOP runtime is not enabled, so its behavior settings are unavailable.')
  }
  const value = namespace.value
  return {
    // Unknown or missing levels show as the trait default, which is what the Host applies.
    levels: normalizeBehaviorLevels(value),
    overrides: overridesOf(value.promptOverrides),
    revision: namespace.revision,
    writable,
  }
}

/** Read and write the behavior traits and prompt overrides through DSH's own settings Remote. */
export function createBehaviorSettingsSource(remote: SettingsRemote): BehaviorSettingsSource {
  return {
    async load() {
      const { namespace, writable } = await describeNamespace(remote, BEHAVIOR_SETTINGS_NAMESPACE)
      return viewOf(namespace, writable)
    },
    async save(patch, expectedRevision) {
      return viewOf(await updateNamespace(remote, BEHAVIOR_SETTINGS_NAMESPACE, patch, expectedRevision), true)
    },
  }
}
