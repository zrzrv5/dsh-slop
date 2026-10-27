import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Workspace packages publish build artifacts, but unit tests exercise
    // source before the build phase. Keep the public package specifier while
    // resolving it to the authoritative source entry only in Vitest.
    alias: {
      '@dsh-slop/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@dsh-slop/execution': fileURLToPath(new URL('./packages/execution/src/index.ts', import.meta.url)),
      '@dsh-slop/knowledge/settings-bridge': fileURLToPath(new URL('./packages/knowledge/src/settings-bridge.ts', import.meta.url)),
      '@dsh-slop/knowledge': fileURLToPath(new URL('./packages/knowledge/src/index.ts', import.meta.url)),
      '@dsh-slop/queue': fileURLToPath(new URL('./packages/queue/src/index.ts', import.meta.url)),
      '@dsh-slop/operations': fileURLToPath(new URL('./packages/operations/src/index.ts', import.meta.url)),
      '@dsh-slop/runtime-base/behavior-catalog': fileURLToPath(new URL('./packages/runtime-base/src/behavior-catalog.ts', import.meta.url)),
    },
  },
  test: {
    css: true,
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
    include: [
      'packages/*/tests/**/*.{spec,test}.{ts,tsx}',
      'tests/**/*.{spec,test}.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['packages/*/src/**/*.d.ts'],
    },
  },
  ssr: {
    noExternal: ['@deepseek-ai/dsh-client-ui-primitives'],
  },
})
