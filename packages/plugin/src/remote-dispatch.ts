import type {
  PrincipalContext,
  SlopApplicationApi,
  SlopRemoteMethod,
  WireResult,
} from '@dsh-slop/core'

/**
 * Preserve the complete validated browser payload at the Host-to-core seam.
 * This function is intentionally decorator-free so the transport boundary can
 * be unit-tested without loading the generated Typert host module.
 */
export function invokeBrowserRemote(
  application: SlopApplicationApi,
  method: SlopRemoteMethod,
  request: unknown,
  principal: PrincipalContext,
  signal: AbortSignal,
): Promise<WireResult<unknown>> {
  return application.invoke(method, request, principal, signal)
}
