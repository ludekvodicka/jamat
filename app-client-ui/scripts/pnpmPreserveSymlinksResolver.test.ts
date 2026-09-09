import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PnpmPreserveSymlinksResolver } from '../electron.vite.config'

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
    const fixtures: readonly (readonly [string, string, string])[] = [
      ['shiki/dist/langs/typescript.mjs', '@shikijs/langs/typescript', 'shiki@4.4.3'],
      ['vega/build/vega.module.js', 'vega-util', 'vega@6.4.0'],
      ['mermaid/dist/mermaid.core.mjs', 'd3', 'mermaid@11.16.1'],
      ['react-markdown/lib/index.js', 'unified', 'react-markdown@10.1.0'],
    ]
    for (const [importer, source, expectedPackage] of fixtures) {
      const build = installed()
      const full = join(packageRoot, 'node_modules', importer)

      await build.ask({ path: source, importer: full })

      expect(build.asked).toHaveLength(1)
      expect(build.asked[0].path).toBe(source)
      expect(build.asked[0].importer).toContain(expectedPackage)
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

  it('steps aside when esbuild cannot resolve it either', async () => {
    const build = installed({ errors: [{ text: 'Could not resolve' }] })
    const importer = join(packageRoot, 'node_modules', 'vega', 'build', 'vega.module.js')

    expect(await build.ask({ path: 'nothing-like-this', importer })).toBeNull()
  })
})
