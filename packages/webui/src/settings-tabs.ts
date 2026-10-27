import type { ReactNode } from 'react'

/** One tab inside the single DSH-SLOP settings section. */
export interface SlopSettingsTab {
  readonly id: string
  /** Lower values come first. */
  readonly order: number
  readonly label: string
  readonly render: () => ReactNode
}

/**
 * Tabs registered by the enabled SLOP components. A component registers its
 * tab when its client plugin starts and disposes it when the plugin stops, so
 * the tab strip follows Plugin Manager enablement.
 */
export interface SlopSettingsTabRegistry {
  /** Add a tab; the returned function removes exactly this registration. */
  register(tab: SlopSettingsTab): () => void
  /** Notify on every registration change; for `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void
  /** The registered tabs in display order; stable until the next change. */
  snapshot(): readonly SlopSettingsTab[]
  /** The tab the user selected last during this page lifetime. */
  selected: string | undefined
}

export function createSettingsTabRegistry(): SlopSettingsTabRegistry {
  const entries = new Set<SlopSettingsTab>()
  const listeners = new Set<() => void>()
  let current: readonly SlopSettingsTab[] = []
  const publish = (): void => {
    current = Object.freeze([...entries].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)))
    for (const listener of listeners) listener()
  }
  return {
    selected: undefined,
    register(tab) {
      // A fresh object keeps two registrations of the same tab independent.
      const entry: SlopSettingsTab = { ...tab }
      entries.add(entry)
      publish()
      return () => {
        if (entries.delete(entry)) publish()
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot: () => current,
  }
}
