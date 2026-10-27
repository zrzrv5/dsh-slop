import type { ProviderOption, QueueFallbackModelSource, QueueFallbackModelView } from '../QueueFallbackModel.tsx'
import { describeNamespace, isRecord, unwrap, updateNamespace, type NamespaceView, type SettingsRemote } from './settings-remote.ts'

/** Profile entry id of the Queue component, which owns the fallback worker settings. */
export const QUEUE_SETTINGS_NAMESPACE = 'slop-queue'

/** The generated `ctx.remote.llm` call used for provider suggestions. */
export interface LlmRemote { listProviders(): Promise<unknown> }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function viewOf(namespace: NamespaceView | undefined, writable: boolean): QueueFallbackModelView {
  if (namespace === undefined || !isRecord(namespace.value) || typeof namespace.revision !== 'number') {
    throw new Error('Queue is not enabled, so its fallback worker settings are unavailable.')
  }
  const value = namespace.value
  return {
    provider: text(value.fallbackProvider),
    model: text(value.fallbackModel),
    reasoningEffort: text(value.fallbackReasoningEffort),
    revision: namespace.revision,
    writable,
  }
}

function providersOf(value: unknown): readonly ProviderOption[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is ProviderOption => isRecord(item) && typeof item.id === 'string' && item.id !== '' && typeof item.name === 'string')
    .map(item => ({ id: item.id, name: item.name }))
}

/** Read and write the Queue fallback worker model; empty strings inherit the parent Chat's route. */
export function createQueueFallbackSource(remote: SettingsRemote, llm?: () => LlmRemote | undefined): QueueFallbackModelSource {
  return {
    async load() {
      const { namespace, writable } = await describeNamespace(remote, QUEUE_SETTINGS_NAMESPACE)
      return viewOf(namespace, writable)
    },
    async save(values, expectedRevision) {
      const patch = { fallbackProvider: values.provider, fallbackModel: values.model, fallbackReasoningEffort: values.reasoningEffort }
      return viewOf(await updateNamespace(remote, QUEUE_SETTINGS_NAMESPACE, patch, expectedRevision), true)
    },
    async listProviders() {
      const service = llm?.()
      if (service === undefined || typeof service.listProviders !== 'function') return []
      return providersOf(unwrap(await service.listProviders()))
    },
  }
}
