import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { DepOptimizationConfig, Plugin } from 'vite'

type DependencyOptimizerPlugin = NonNullable<
  NonNullable<DepOptimizationConfig['esbuildOptions']>['plugins']
>[number]

export class PnpmPreserveSymlinksResolver {
  static plugin(): Plugin {
    return {
      name: 'pnpm-preserve-symlinks-resolver',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!importer || !PnpmPreserveSymlinksResolver.isBare(source)
          || !PnpmPreserveSymlinksResolver.isDependency(importer))
          return null
        const realImporter = PnpmPreserveSymlinksResolver.realImporter(importer)
        if (realImporter === null) return null
        return this.resolve(source, realImporter, { skipSelf: true })
      },
    }
  }

  static optimizerPlugin(): DependencyOptimizerPlugin {
    return {
      name: 'pnpm-dependency-optimizer-resolver',
      setup(build) {
        build.onResolve({ filter: /^[^./\\]/ }, async (args) => {
          if (args.pluginData !== undefined && args.pluginData.pnpmResolved === true) return null
          if (!args.importer || !PnpmPreserveSymlinksResolver.isBare(args.path)
            || !PnpmPreserveSymlinksResolver.isDependency(args.importer))
            return null
          const realImporter = PnpmPreserveSymlinksResolver.realImporter(args.importer)
          if (realImporter === null) return null
          // esbuild does the resolving, only from the real location. `createRequire().resolve()`
          // did it here once and applied NODE conditions, so a package whose `exports` splits on
          // `node` handed the browser its node build, and the node build of vega-canvas opens with
          // `await import("canvas")`, which no browser bundle can resolve. Following the symlink
          // is what this plugin is for; the conditions were never its to decide.
          const resolved = await build.resolve(args.path, {
            kind: args.kind,
            importer: realImporter,
            resolveDir: dirname(realImporter),
            pluginData: { pnpmResolved: true },
          })
          return resolved.errors.length > 0 ? null : resolved
        })
      },
    }
  }

  private static isBare(source: string): boolean {
    return !source.startsWith('.')
      && !source.startsWith('/')
      && !source.startsWith('\\')
      && !source.startsWith('\0')
      && !source.includes(':')
  }

  private static isDependency(importer: string): boolean {
    return /[/\\]node_modules[/\\]/.test(importer)
  }

  private static realImporter(importer: string): string | null {
    const path = importer.split('?')[0]
    try {
      const real = realpathSync(path)
      return real === path ? null : real
    } catch { return null }
  }
}

// The three entries are explicit because this package keeps each program at its own top level
// (`app/`, `preload/`, `renderer/`), instead of the `src/{main,preload,renderer}` layout
// electron-vite discovers on its own.
// preserveSymlinks in the Vite module graph: this tree is reached through a `subst` virtual disk,
// and without it the main entry is bundled twice, which splits every module-level singleton in half.
export default defineConfig({
  main: {
    resolve: { preserveSymlinks: true },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          start: resolve(__dirname, 'start.ts'),
          fileDiffWorker: resolve(__dirname, 'app/fileChanges/diff/fileDiffWorkerEntry.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { preserveSymlinks: true },
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve(__dirname, 'preload/index.ts') } },
  },
  renderer: {
    root: resolve(__dirname, 'renderer'),
    esbuild: { jsx: 'automatic' },
    resolve: {
      preserveSymlinks: true,
      dedupe: [
        '@viz-js/viz',
        'dockview',
        'dompurify',
        'mermaid',
        'react',
        'react-dom',
        'react-markdown',
        'rehype-sanitize',
        'remark-directive',
        'remark-gfm',
        'shiki',
        'vega',
        'vega-lite',
        'yaml',
      ],
    },
    server: { fs: { allow: [resolve(__dirname, '..')] } },
    optimizeDeps: {
      // The dev optimizer must follow pnpm package symlinks so each package can see its own transitives.
      esbuildOptions: {
        preserveSymlinks: false,
        plugins: [PnpmPreserveSymlinksResolver.optimizerPlugin()],
      },
    },
    plugins: [PnpmPreserveSymlinksResolver.plugin(), react()],
    build: {
      // Two documents, one renderer build: the workspace window and the Debug window.
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'renderer/index.html'),
          debug: resolve(__dirname, 'renderer/debug.html'),
        },
      },
    },
  },
})
