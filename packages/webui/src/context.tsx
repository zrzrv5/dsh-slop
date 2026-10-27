import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { SlopRemoteClient } from './remote-client.ts'
import { useSlopState, type SlopStore, type SlopStoreState } from './store.ts'
import type { SnapshotProjection } from './types.ts'

export type SlopRoute =
  | { kind: 'machines'; machineId?: string }
  | { kind: 'settings'; section: 'knowledge' | 'machines' | 'queue' }

export interface SlopUiContextValue {
  client: SlopRemoteClient
  store: SlopStore
  state: SlopStoreState
  snapshot?: SnapshotProjection
  route: SlopRoute
  navigate: (route: SlopRoute) => void
  reload: () => Promise<void>
}

const Context = createContext<SlopUiContextValue | undefined>(undefined)

export function SlopUiProvider({ client, store, route: controlledRoute, onNavigate, children }: { client: SlopRemoteClient; store: SlopStore; route?: SlopRoute; onNavigate?: (route: SlopRoute) => void; children: ReactNode }): ReactNode {
  const state = useSlopState(store)
  const [internalRoute, setInternalRoute] = useState<SlopRoute>(controlledRoute ?? { kind: 'machines' })
  const route = controlledRoute ?? internalRoute
  const navigate = onNavigate ?? setInternalRoute
  const value = useMemo<SlopUiContextValue>(() => ({ client, store, state, snapshot: state.snapshot, route, navigate, reload: () => store.load() }), [client, navigate, route, state, store])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useSlopUi(): SlopUiContextValue {
  const value = useContext(Context)
  if (value === undefined) throw new Error('useSlopUi must be used inside SlopUiProvider')
  return value
}

export function useOptionalSlopUi(): SlopUiContextValue | undefined { return useContext(Context) }

export function useSlopMutation<T>(fn: () => Promise<{ ok: true; value: T } | { ok: false; error: import('./types.ts').RemoteFailure }>): { run: () => Promise<T | undefined>; pending: boolean; error?: import('./types.ts').RemoteFailure } {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<import('./types.ts').RemoteFailure | undefined>(undefined)
  const run = async (): Promise<T | undefined> => {
    setPending(true)
    setError(undefined)
    const result = await fn()
    setPending(false)
    if (!result.ok) { setError(result.error); return undefined }
    return result.value
  }
  return { run, pending, error }
}

export function useSnapshotRequired(): SnapshotProjection {
  const { snapshot } = useSlopUi()
  if (snapshot === undefined) throw new Error('A SLOP snapshot is required for this view')
  return snapshot
}
