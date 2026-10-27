import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

export function dshClientBuild(PACKAGE_ID: string, entry: string, outDir = 'lib') {
const CSS_PREFIX = '\0dsh-slop-css:'
const CSS_SUFFIX = '.mjs'
const requested = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'])

/**
 * DSH dynamic clients are closure factories, not ordinary browser ESM. This
 * standalone-workspace preset implements the pinned loader contract and keeps
 * React identity in DSH's module table. Product CSS is injected once when the
 * factory loads, matching upstream dynamic UI packages.
 */
return defineConfig({
  entry: { client: entry },
  outDir,
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => requested.has(specifier),
    alwaysBundle: specifier => !requested.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-slop-global-css-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.css') || importer === undefined) return null
      return `${CSS_PREFIX}${resolve(dirname(importer), source)}${CSS_SUFFIX}`
    },
    async load(id) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const filename = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(filename)
      const source = await readFile(filename, 'utf8')
      const compiled = filename.endsWith('.module.css') ? transform({ filename, code: Buffer.from(source), cssModules: true }) : undefined
      const css = compiled?.code.toString() ?? source
      const classes = Object.fromEntries(Object.entries(compiled?.exports ?? {}).map(([key, value]) => [key, value.name]))
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(`${PACKAGE_ID}/${filename}`)};`,
        'if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classes)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

}
