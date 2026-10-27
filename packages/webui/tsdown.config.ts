import { defineConfig } from 'tsdown'

/**
 * The host-facing exports stay platform-neutral while the browser entry is
 * kept separate so DSH can load it through the package's `dsh.client`
 * manifest.  Keeping these entries separate also prevents React/DOM code
 * from leaking into the host-side type surface.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mock: 'src/mock.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  clean: true,
})
