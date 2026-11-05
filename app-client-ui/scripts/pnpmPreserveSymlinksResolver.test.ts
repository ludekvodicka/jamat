import { dirname, join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { BuildEnvironment, normalizePath, optimizeDeps, resolveConfig, type UserConfig } from 'vite'

import { describe, expect, it } from 'vitest'

import rendererConfig, { PnpmPreserveSymlinksResolver } from '../electron.vite.config'

interface RecordedResolve {
  path: string
  importer: string
  resolveDir: string
  pluginData: unknown
}

class FakeEsbuild {
  readonly asked: RecordedResolve[] = []
  private handler: ((args: Record<string, unknown>) => unknown) | null = null

  constructor(private readonly answer: { path?: string; errors?: unknown[] } = {}) {}

  onResolve(_filter: unknown, handler: (args: Record<string, unknown>) => unknown): void {
    this.handler = handler
  }

  resolve(path: string, options: Record<string, unknown>): Promise<unknown> {
    this.asked.push({
      path,
      importer: String(options.importer),
      resolveDir: String(options.resolveDir),
      pluginData: options.pluginData,
    })
    return Promise.resolve({ path: this.answer.path ?? path, errors: this.answer.errors ?? [] })
  }

  ask(args: Record<string, unknown>): Promise<unknown> {
    if (this.handler === null) throw new Error('The plugin registered no resolver')
    return Promise.resolve(this.handler({ kind: 'import-statement', pluginData: undefined, ...args }))
  }
}

describe('app-client-ui/scripts/pnpmPreserveSymlinksResolver', () => {
  const packageRoot = join(import.meta.dirname, '..')

  function installed(answer: { path?: string; errors?: unknown[] } = {}): FakeEsbuild {
    const build = new FakeEsbuild(answer)
    PnpmPreserveSymlinksResolver.optimizerPlugin().setup(build as never)
    return build
  }

  it('hands a transitive import to esbuild from the real pnpm directory of its importer', async () => {
    const fixtures: readonly (readonly [string, string])[] = [
      ['shiki/dist/langs/typescript.mjs', '@shikijs/langs/typescript'],
      ['vega/build/vega.module.js', 'vega-util'],
      ['mermaid/dist/mermaid.core.mjs', 'd3'],
      ['react-markdown/lib/index.js', 'unified'],
    ]
    for (const [importer, source] of fixtures) {
      const build = installed()
      const full = join(packageRoot, 'node_modules', importer)

      await build.ask({ path: source, importer: full })

      expect(build.asked).toHaveLength(1)
      expect(build.asked[0].path).toBe(source)
      expect(build.asked[0].importer).toBe(realpathSync(full))
      expect(build.asked[0].importer).not.toBe(full)
      expect(build.asked[0].resolveDir).toBe(dirname(build.asked[0].importer))
    }
  })

  /*
   * The regression this file exists for. Resolving here with `createRequire().resolve()` applied
   * node conditions, so a package whose `exports` splits on `node` handed the browser its node
   * build; vega-canvas' one opens with `await import("canvas")` and the dev server refused to
   * transform it. Conditions are esbuild's to apply, so the plugin must delegate rather than answer.
   */
  it("never resolves a package itself, so the browser conditions stay esbuild's", async () => {
    const browserBuild = join(packageRoot, 'node_modules', 'vega-canvas', 'build', 'vega-canvas.browser.js')
    const build = installed({ path: browserBuild })
    const importer = join(packageRoot, 'node_modules', 'vega', 'build', 'vega.module.js')

    const answer = await build.ask({ path: 'vega-canvas', importer }) as { path: string }

    expect(build.asked).toHaveLength(1)
    expect(answer.path).toBe(browserBuild)
  })

  it('does not ask esbuild about an answer esbuild is already asking it about', async () => {
    const build = installed()
    const importer = join(packageRoot, 'node_modules', 'vega', 'build', 'vega.module.js')

    const answer = await build.ask({ path: 'vega-util', importer, pluginData: { pnpmResolved: true } })

    expect(answer).toBeNull()
    expect(build.asked).toHaveLength(0)
  })

  it('leaves application and relative imports to Vite', async () => {
    const build = installed()

    expect(await build.ask({ path: 'react', importer: join(packageRoot, 'renderer', 'main.tsx') })).toBeNull()
    expect(await build.ask({
      path: './chunk.js',
      importer: join(packageRoot, 'node_modules', 'mermaid', 'dist', 'mermaid.core.mjs'),
    })).toBeNull()
    expect(build.asked).toHaveLength(0)
  })

  /*
   * The Usage chart failed in the dev server with `Unrecognized transform type: "formula"`: every
   * vega package linked vega-dataflow through its own pnpm directory, esbuild bundled one copy per
   * link, and vega registered its transforms in a copy the parser did not read.
   */
  it('bundles a dependency shared by several pnpm packages once', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'jamat-optimizer-'))
    try {
      const renderer = (rendererConfig as { renderer: UserConfig }).renderer
      const config = await resolveConfig({ ...renderer, configFile: false, cacheDir, logLevel: 'silent',
        optimizeDeps: { ...renderer.optimizeDeps, include: ['vega', 'vega-lite'], noDiscovery: true } }, 'serve')
      await optimizeDeps(config, true)
      const bundled = readdirSync(join(cacheDir, 'deps')).filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(cacheDir, 'deps', file), 'utf8')).join('\n')
      expect(bundled.match(/^var transforms\d* = \{\};$/gm)).toHaveLength(1)
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  }, 120_000)

  it('steps aside when esbuild cannot resolve it either', async () => {
    const build = installed({ errors: [{ text: 'Could not resolve' }] })
    const importer = join(packageRoot, 'node_modules', 'vega', 'build', 'vega.module.js')

    expect(await build.ask({ path: 'nothing-like-this', importer })).toBeNull()
  })

  it('unifies dependency identities while preserving queries and resolver metadata', async () => {
    const plugin = PnpmPreserveSymlinksResolver.plugin(), resolveId = plugin.resolveId
    if (typeof resolveId !== 'function') throw new Error('Expected a renderer resolver hook')
    const config = await resolveConfig({ configFile: false, root: packageRoot, resolve: { preserveSymlinks: true } }, 'build')
    if (typeof plugin.configResolved !== 'function') throw new Error('Expected renderer resolver initialization')
    await plugin.configResolved.call({} as never, config)
    const dependency = join(packageRoot, 'node_modules/vega/build/vega.module.js')
    const resolved = { id: `${dependency}?raw`, moduleSideEffects: false, meta: { fixture: true } }
    const answer = await resolveId.call({ environment: new BuildEnvironment('client', config), resolve: async (id: string) => ({ ...resolved, id }) } as never, 'vega?raw',
      join(packageRoot, 'renderer/usage/usageChart.tsx'), { attributes: {}, isEntry: false })
    expect(answer).toEqual({ ...resolved, id: `${normalizePath(realpathSync(dependency))}?raw` })
  })

  it('preserves application identities and external resolutions', async () => {
    const plugin = PnpmPreserveSymlinksResolver.plugin(), resolveId = plugin.resolveId
    if (typeof resolveId !== 'function') throw new Error('Expected a renderer resolver hook')
    const application = join(packageRoot, 'renderer/usage/usageChart.tsx')
    const config = await resolveConfig({ configFile: false, root: packageRoot,
      resolve: { preserveSymlinks: true, alias: { fixture: application } } }, 'build')
    if (typeof plugin.configResolved !== 'function') throw new Error('Expected renderer resolver initialization')
    await plugin.configResolved.call({} as never, config)
    const resolved = { id: 'external-module', external: true }
    const context = { environment: new BuildEnvironment('client', config), resolve: async () => resolved }
    expect(await resolveId.call(context as never, 'fixture', application, { attributes: {}, isEntry: false })).toBeNull()
    expect(await resolveId.call(context as never, './poolGraphSpec', application, { attributes: {}, isEntry: false })).toBeNull()
    expect(await resolveId.call(context as never, 'vega', application, { attributes: {}, isEntry: false })).toBe(resolved)
  })
})
