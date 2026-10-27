import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { pluginDataHome } from './data-home.ts'
import { browserBootstrap, serveBrowserBootstrap, BROWSER_BOOTSTRAP_PATH } from './browser-bootstrap.ts'
import { registerGoalPolicy } from './goal-policy.ts'
import { registerSlopPromptBlock } from './prompt-block.ts'
import { registerBehavior } from './behavior.ts'
import { BEHAVIOR_TRAITS, behaviorTrait, type BehaviorTraitId } from './behavior-catalog.ts'
export * from './admission.ts'
export * from './behavior.ts'
export * from './behavior-catalog.ts'
export interface Config { readonly productHome: string; readonly dataRoot: string; readonly trustedBrowserHosts?: string[] }
const defaultHome = pluginDataHome()
const sharedConfig = { productHome: z.string().default(defaultHome), dataRoot: z.string().default(resolve(defaultHome, 'slop')), trustedBrowserHosts: z.array(z.string()).default([]) }
export const Config: z<Config> = z.object(sharedConfig)
type BehaviorLevelConfig = { readonly [K in BehaviorTraitId]: Volatile<string> }
export interface RuntimeConfig extends Omit<Config, 'trustedBrowserHosts'>, BehaviorLevelConfig {
  readonly trustedBrowserHosts: string[]
  readonly promptOverrides: Volatile<Record<string, string>>
}
function behaviorLevelField(id: BehaviorTraitId) {
  const trait = behaviorTrait(id)
  return z.union(trait.levels.map(level => z.const(level.id))).default(trait.defaultLevel).volatile()
    .description(`${trait.description} Applies to new sessions.`)
}
/**
 * The runtime entry also owns the user-editable Agent behavior preferences;
 * other components keep the shared Config. `followThrough` keeps its original
 * key and values so existing profiles stay valid.
 */
export const RuntimeConfig: z<Record<string, unknown>, RuntimeConfig> = z.object({
  ...sharedConfig,
  ...Object.fromEntries(BEHAVIOR_TRAITS.map(trait => [trait.id, behaviorLevelField(trait.id)])) as Record<BehaviorTraitId, ReturnType<typeof behaviorLevelField>>,
  promptOverrides: z.dict(z.string()).default({}).volatile()
    .description('Custom prompt text keyed `<trait>.<level>`. Empty text uses the default.'),
})
export function validateConfig(config: Config): string {
  if (!isAbsolute(config.productHome) || !isAbsolute(config.dataRoot) || resolve(config.dataRoot) !== resolve(config.productHome, 'slop')) throw new Error('Expected absolute productHome and dataRoot equal to productHome/slop')
  return resolve(config.productHome)
}
declare module '@deepseek-ai/cordis' { interface Context { slopRuntime: SlopRuntime } }
export class SlopRuntime extends Service {
  readonly nonce = randomBytes(32).toString('base64url')
  readonly trustedHosts: readonly string[]
  constructor(ctx: Context, config: RuntimeConfig) {
    super(ctx, 'slopRuntime')
    validateConfig(config)
    this.trustedHosts = config.trustedBrowserHosts ?? []
    ctx.on('webserver/index-inject', (table: IndexInjection[]) => { table.push({ kind: 'global', name: '__DSH_SLOP_BOOT__', value: browserBootstrap(this.nonce) }) })
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: BROWSER_BOOTSTRAP_PATH, handler: (req, res) => { serveBrowserBootstrap(req, res, this.nonce, this.trustedHosts) } }))
    ctx.effect(() => registerGoalPolicy(ctx))
    ctx.effect(() => registerSlopPromptBlock(ctx))
    ctx.effect(() => registerBehavior(ctx, () => ({
      levels: Object.fromEntries(BEHAVIOR_TRAITS.map(trait => [trait.id, config[trait.id].get()])),
      overrides: config.promptOverrides.get(),
    })))
    // This runtime ships its own Settings page, so the host must not generate one.
    ctx.inject(['settings'], scoped => { scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber)) })
  }
}
export const name = 'slop-runtime'
export const inject = ['webServer', 'agents', 'tools', 'systemPrompt']
export function apply(ctx: Context, config: RuntimeConfig): void { new SlopRuntime(ctx, config) }
