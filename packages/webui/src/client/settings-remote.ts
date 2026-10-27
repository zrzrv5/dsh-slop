/** Shared access to DSH's settings Remote for the SLOP settings tabs. */

export interface NamespaceView { readonly ns?: unknown; readonly value?: unknown; readonly revision?: unknown }

/** The generated `ctx.remote.settings` calls the SLOP settings tabs use. */
export interface SettingsRemote {
  describe(): Promise<unknown>
  update(ns: string, patch: Record<string, unknown>, expectedRevision: number | undefined): Promise<unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Accept both the Remote result envelope and a bare value. */
export function unwrap(result: unknown): unknown {
  if (!isRecord(result) || !('ok' in result)) return result
  if (result.ok === true) return result.value
  const failure = result.error
  throw new Error(isRecord(failure) && typeof failure.message === 'string' ? failure.message : 'The settings request failed.')
}

/** Find one namespace in a `describe()` answer; also reports whether the profile accepts writes. */
export async function describeNamespace(remote: SettingsRemote, ns: string): Promise<{ namespace: NamespaceView | undefined; writable: boolean }> {
  const described = unwrap(await remote.describe())
  if (!isRecord(described) || !Array.isArray(described.namespaces)) throw new Error('The settings service returned an unexpected answer.')
  const namespace = (described.namespaces as NamespaceView[]).find(candidate => isRecord(candidate) && candidate.ns === ns)
  return { namespace, writable: described.writable !== false }
}

/** Write a patch with the expected revision and return the namespace the Host reports back. */
export async function updateNamespace(remote: SettingsRemote, ns: string, patch: Record<string, unknown>, expectedRevision: number): Promise<NamespaceView> {
  const updated = unwrap(await remote.update(ns, patch, expectedRevision))
  if (!isRecord(updated)) throw new Error('The settings service returned an unexpected answer.')
  return updated as NamespaceView
}
