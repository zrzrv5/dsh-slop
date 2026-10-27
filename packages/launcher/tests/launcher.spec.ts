import { mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DSH_UPSTREAM_COMMIT, DSH_VERSION, initializeProductHome, launcherDiagnostics, PRODUCT_HOME_SCHEMA_GENERATION, PRODUCT_VERSION, productEnvironment, resolveDshBin, resolveProductPaths, resolveRuntimeBundle } from '../src/index.js'

describe('product home', () => {
  it('rejects relative and ordinary DSH paths', () => {
    expect(() => resolveProductPaths('relative')).toThrow('absolute')
    expect(() => resolveProductPaths('/tmp/ordinary', { DSH_HOME: '/tmp/ordinary' })).toThrow('ordinary')
  })

  it('creates an owner-only isolated profile idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    if (process.platform !== 'win32') expect((await stat(paths.productHome)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(join(paths.productHome, '.dsh-slop-redesign-v1'), 'utf8'))).toEqual({ schemaGeneration: PRODUCT_HOME_SCHEMA_GENERATION })
    const profile = JSON.parse(await readFile(join(paths.profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    expect(Object.keys(profile.dependencies).sort()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-slop/bundle', '@dsh-slop/web-runtime'].sort())
    expect(profile.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-slop/bundle', '@dsh-slop/web-runtime'])
    await expect(readdir(join(paths.dshHome, '.agent-presets'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const name of ['bundle', 'knowledge', 'plugin', 'ui', 'runtime', 'machine', 'queue-plugin', 'queue-webhook', 'web-runtime']) {
      const linked = JSON.parse(await readFile(join(paths.profileDir, 'node_modules', '@dsh-slop', name, 'package.json'), 'utf8'))
      expect(linked.name).toBe(`@dsh-slop/${name}`)
    }
    const neutralEnvironment = productEnvironment(paths, {})
    expect(neutralEnvironment.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(neutralEnvironment.DSH_BUNDLED_SKILL_DIR).toBeUndefined()
    expect(neutralEnvironment.DSH_SLOP_SKILL_DIR).toContain('skills')
    expect(productEnvironment(paths, { DSH_BUNDLED_SKILL_DIR: '/operator/skills' }).DSH_BUNDLED_SKILL_DIR).toBe('/operator/skills')
    expect(neutralEnvironment.THESEUS_API_KEY).toBeUndefined()
    expect(neutralEnvironment.MLX_API_KEY).toBeUndefined()
    expect(productEnvironment(paths, { DSH_MODEL_API_KEY: 'operator-value' }).DSH_MODEL_API_KEY).toBe('operator-value')
  })

  it('preserves user profile overrides across startup and composes only the explicitly selected runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-runtime-'))
    const paths = resolveProductPaths(join(root, 'product'))
    await initializeProductHome(paths)
    const patch = join(paths.profileDir, 'cordis.patch.yml')
    const override = '# operator notes\n- id: agent-presets\n  config:\n    default: standard\n'
    await writeFile(patch, override)
    const directory = join(root, 'personal')
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: '@example/personal', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    const runtime = await resolveRuntimeBundle(directory)
    await initializeProductHome(paths, process.env, runtime)
    await initializeProductHome(paths, process.env, runtime)
    expect(await readFile(patch, 'utf8')).toBe(override)
    const manifest = JSON.parse(await readFile(join(paths.profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles.at(-1)).toBe('@example/personal')
    expect(await realpath(join(paths.profileDir, 'node_modules', '@example', 'personal'))).toBe(await realpath(directory))
    await initializeProductHome(paths)
    const core = JSON.parse(await readFile(join(paths.profileDir, 'package.json'), 'utf8'))
    expect(core.dsh.profile.bundles).not.toContain('@example/personal')
    expect(await readFile(patch, 'utf8')).toBe(override)
  })



  it('refuses to reinterpret a non-empty unmarked product home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-legacy-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    await mkdir(paths.productHome, { recursive: true })
    const legacy = join(paths.productHome, 'legacy.sqlite')
    await writeFile(legacy, 'legacy bytes', 'utf8')

    await expect(initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })).rejects.toThrow('requires a compatible product home')
    await expect(readFile(legacy, 'utf8')).resolves.toBe('legacy bytes')
  })

  it('retains installed and disabled external plugins and their precedence across startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-plugin-profile-'))
    const paths = resolveProductPaths(join(root, 'product'))
    await initializeProductHome(paths)
    const path = join(paths.profileDir, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    manifest.dependencies['@deepseek-ai/dsh-base'] = '0.1.5-rc.1'
    manifest.dependencies['@example/first'] = '1.2.3'
    manifest.dependencies['@example/second'] = '2.0.0'
    manifest.dependencies['@example/disabled'] = '3.0.0'
    manifest.dsh.profile.bundles.push('@example/second', '@example/first')
    manifest.description = 'Operator-owned profile description'
    await writeFile(path, JSON.stringify(manifest))

    await initializeProductHome(paths)
    const first = await readFile(path, 'utf8')
    await initializeProductHome(paths)
    expect(await readFile(path, 'utf8')).toBe(first)
    const restored = JSON.parse(first)
    expect(restored.dependencies).toMatchObject({
      '@deepseek-ai/dsh-base': DSH_VERSION,
      '@example/first': '1.2.3',
      '@example/second': '2.0.0',
      '@example/disabled': '3.0.0',
    })
    expect(restored.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-slop/bundle', '@dsh-slop/web-runtime',
      '@example/second', '@example/first',
    ])
    expect(restored.description).toBe(manifest.description)
  })

  it.each(['{broken', '{"dependencies":[]}', '{"dsh":{"profile":{"bundles":[7]}}}'])(
    'refuses a malformed profile without overwriting it: %s', async original => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-slop-invalid-profile-'))
      const paths = resolveProductPaths(join(root, 'product'))
      await initializeProductHome(paths)
      const path = join(paths.profileDir, 'package.json')
      await writeFile(path, original)
      await expect(initializeProductHome(paths)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(original)
    },
  )


  it('keeps launcher diagnostics and installed package pins aligned with the verified release', async () => {
    const release = JSON.parse(await readFile(new URL('../../../tests/fixtures/upstream-release.json', import.meta.url), 'utf8'))
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect({ version: DSH_VERSION, tag: `dsh-v${DSH_VERSION}`, commit: DSH_UPSTREAM_COMMIT }).toEqual(release)
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe(release.version)
    await expect(resolveDshBin()).resolves.toEqual(expect.any(String))
  })

  it('accepts only the exact DSH package version and reports the recorded upstream revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-version-'))
    const packageRoot = join(root, 'dsh')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8')
    const manifest = join(packageRoot, 'package.json')
    await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION, bin: { dsh: 'lib/bin.js' } }), 'utf8')
    expect(await resolveDshBin(manifest)).toBe(join(packageRoot, 'lib', 'bin.js'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    await expect(launcherDiagnostics(paths, manifest)).resolves.toMatchObject({
      productVersion: PRODUCT_VERSION,
      dshVersion: DSH_VERSION,
      dshUpstreamCommit: DSH_UPSTREAM_COMMIT,
    })

    await writeFile(manifest, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1', bin: { dsh: 'lib/bin.js' } }), 'utf8')
    await expect(resolveDshBin(manifest)).rejects.toThrow(`requires @deepseek-ai/dsh ${DSH_VERSION}`)
    await expect(launcherDiagnostics(paths, manifest)).rejects.toThrow(`requires @deepseek-ai/dsh ${DSH_VERSION}`)
  })

  it('repairs an owned stale runtime link after the installation moves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    const destination = join(paths.profileDir, 'node_modules', '@dsh-slop', 'bundle')
    const installedSource = await realpath(destination)
    await unlink(destination)
    await symlink(join(root, 'old-install', 'bundle'), destination, process.platform === 'win32' ? 'junction' : 'dir')
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    expect(await realpath(destination)).toBe(installedSource)
  })

  it('adds Knowledge without adopting an unowned link when upgrading an older runtime manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-legacy-links-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    const scope = join(paths.profileDir, 'node_modules', '@dsh-slop')
    for (const name of ['knowledge', 'runtime', 'machine', 'queue-plugin', 'queue-webhook', 'web-runtime']) await unlink(join(scope, name))
    await writeFile(join(scope, '.dsh-slop-runtime-links.json'), `${JSON.stringify({
      schema: 1,
      owner: 'dsh-slop-launcher',
      packages: {
        bundle: '@dsh-slop/bundle',
        plugin: '@dsh-slop/plugin',
        ui: '@dsh-slop/ui',
      },
    }, null, 2)}\n`, 'utf8')

    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })

    expect(JSON.parse(await readFile(join(scope, 'knowledge', 'package.json'), 'utf8')).name).toBe('@dsh-slop/knowledge')
    const ownership = JSON.parse(await readFile(join(scope, '.dsh-slop-runtime-links.json'), 'utf8')) as { packages: Record<string, string> }
    expect(ownership.packages.knowledge).toBe('@dsh-slop/knowledge')
  })

  it('refuses an unowned Knowledge link while upgrading an older runtime manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-legacy-links-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    const scope = join(paths.profileDir, 'node_modules', '@dsh-slop')
    await writeFile(join(scope, '.dsh-slop-runtime-links.json'), `${JSON.stringify({
      schema: 1,
      owner: 'dsh-slop-launcher',
      packages: {
        bundle: '@dsh-slop/bundle',
        plugin: '@dsh-slop/plugin',
        ui: '@dsh-slop/ui',
      },
    }, null, 2)}\n`, 'utf8')
    await unlink(join(scope, 'knowledge'))
    await symlink(join(root, 'unowned-install', 'knowledge'), join(scope, 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') }),
    ).rejects.toThrow('refusing to adopt unowned runtime package link')
  })

  it('rejects an expected runtime link without an ownership manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    const scope = join(paths.profileDir, 'node_modules', '@dsh-slop')
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    await unlink(join(scope, '.dsh-slop-runtime-links.json'))
    await unlink(join(scope, 'bundle'))
    await symlink(join(root, 'unowned-install', 'bundle'), join(scope, 'bundle'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })).rejects.toThrow('unowned runtime package link')
  })

  it('rejects a non-link at an expected runtime package path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-slop-launcher-'))
    const paths = resolveProductPaths(join(root, 'product'), { DSH_HOME: join(root, 'ordinary') })
    const scope = join(paths.profileDir, 'node_modules', '@dsh-slop')
    await initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })
    await unlink(join(scope, 'bundle'))
    await mkdir(join(scope, 'bundle'))
    await expect(initializeProductHome(paths, { DSH_HOME: join(root, 'ordinary') })).rejects.toThrow('refusing to replace non-link runtime package')
  })
})
