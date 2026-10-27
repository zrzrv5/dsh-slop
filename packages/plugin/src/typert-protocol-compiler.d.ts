/**
 * Compiler-only ambient view of the published Typert protocol.
 *
 * The rc.2 workspace generator recognizes Remote metadata by the owning
 * ambient module when the protocol itself is consumed as a published package
 * outside the upstream monorepo. Keep this declaration deliberately limited
 * to the two runtime exports used by this package; JavaScript still resolves
 * to `@deepseek-ai/dsh-typert-protocol`.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  import { Service, type Context } from '@deepseek-ai/cordis'

  const LOOKUP_HOST: unique symbol
  const LOOKUP_WIRE: unique symbol
  const CONTEXT_WIRE: unique symbol

  export interface TypertLookup<Host, Wire> {
    readonly [LOOKUP_HOST]: Host
    readonly [LOOKUP_WIRE]: Wire
  }

  export interface TypertContext<Wire> {
    readonly [CONTEXT_WIRE]: Wire
  }

  export interface TypertLookupMap {}
  export interface TypertContextMap {}

  export interface TypertGatewayBindingOptions {
    readonly namespace?: string
  }

  export abstract class TypertRemoteService<out T = never> extends Service<T> {
    protected constructor(ctx: Context, serviceKey: string, options?: TypertGatewayBindingOptions)
  }

  type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void
  export function Remote(exportName: string): RemoteMethodDecorator
}
