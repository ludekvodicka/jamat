import { realpathSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build, normalizePath } from 'vite'
import { expect, it } from 'vitest'
import config from '../electron.vite.config'

it('bundles one physical dependency instance with browser conditions and renders the actual Usage specs', async () => {
  const parent = join(import.meta.dirname, '../../.aidocs/temp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'usage-bundle-'))
  const packageRoot = join(import.meta.dirname, '..')
  const modules: string[] = []
  try {
    const entry = join(root, 'probe.ts')
    await writeFile(entry, [
      `import { poolGraphSpec } from ${JSON.stringify(normalizePath(join(packageRoot, 'renderer/usageWindow/poolGraphSpec.ts')))}`,
      `import { TokensSectionModel } from ${JSON.stringify(normalizePath(join(packageRoot, 'renderer/usageWindow/tokensSectionModel.ts')))}`,
      "import React from 'react'",
      "import { jsx } from 'react/jsx-runtime'",
      'export async function render() {',
      " const [lite, vega] = await Promise.all([import('vega-lite'), import('vega')])",
      " const theme = { text: 'black', grid: 'gray', accent: 'blue' }",
      ' const pool = poolGraphSpec({ recorded: [{ at: 0, remaining: 100 }, { at: 3600000, remaining: 90 }],',
      '  projected: [{ at: 3600000, remaining: 90 }, { at: 7200000, remaining: 80 }], now: 3600000, until: 7200000,',
      '  displayRange: { from: 0, to: 7200000 }, burnPerHour: 10, poolEmptyAt: null, firstEmpty: null, nextReset: null, knownAccounts: 1, totalAccounts: 1 }, theme)',
      " const tokens = TokensSectionModel.chart([{ key: 'day', label: '2026-10-26', agentId: 'claude', input: 70, output: 20, cacheRead: 30, cacheWrite: 0 }], 'Day', theme)",
      ' const svgs = []',
      ' for (const spec of [pool, tokens]) {',
      "  const view = new vega.View(vega.parse(lite.compile(spec).spec), { renderer: 'none' }).width(640)",
      '  try { svgs.push(await view.toSVG()) } finally { view.finalize() }',
      ' }',
      " return { svgs, reactElement: React.isValidElement(jsx('span', { children: 'ready' })) }",
      '}',
    ].join('\n'))
    const result = await build({ ...config.renderer, configFile: false, cacheDir: join(root, 'cache'), publicDir: false, logLevel: 'warn',
      plugins: [...config.renderer?.plugins ?? [], { name: 'record-probe-modules', generateBundle() { modules.push(...this.getModuleIds()) } }],
      build: { target: 'esnext', minify: false, write: false, rollupOptions: {
        input: entry, preserveEntrySignatures: 'strict', output: { format: 'iife', name: 'usageBundleProbe', inlineDynamicImports: true },
      } },
    })
    if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one in-memory renderer bundle')
    const chunk = result.output.find(output => output.type === 'chunk')
    if (!chunk || chunk.type !== 'chunk') throw new Error('Renderer probe produced no executable chunk')
    const retained = Object.entries(chunk.modules).filter(([, module]) => module.renderedLength > 0).map(([id]) => id)
    const dataflow = retained.filter(id => /[/\\]vega-dataflow[/\\]build[/\\]vega-dataflow\.js$/.test(id))
    console.log('Bundled Vega dataflow modules:', JSON.stringify(Object.entries(chunk.modules)
      .filter(([id]) => /[/\\]vega-dataflow[/\\]build[/\\]vega-dataflow\.js$/.test(id)).map(([id, module]) => ({ id, renderedLength: module.renderedLength }))))
    const probe = runInNewContext(`${chunk.code}\nusageBundleProbe`, { console, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval }) as {
      render(): Promise<{ svgs: string[]; reactElement: boolean }>
    }
    const rendered = await probe.render()
    expect(rendered.reactElement).toBe(true)
    expect(rendered.svgs).toHaveLength(2)
    for (const svg of rendered.svgs) {
      expect(svg).toContain('<svg')
      expect(svg).toContain('<path')
    }
    expect(dataflow).toHaveLength(1)
    const physical = new Map<string, string[]>()
    for (const id of retained)
      if (isAbsolute(id) && !id.includes('?') && /[/\\]node_modules[/\\]/.test(id)) {
        const path = normalizePath(realpathSync(id))
        physical.set(path, [...physical.get(path) ?? [], id])
      }
    expect([...physical.values()].filter(ids => ids.length > 1)).toEqual([])
    expect(modules.some(id => id.endsWith('/vega-canvas/build/vega-canvas.browser.js'))).toBe(true)
    expect(modules.some(id => id.endsWith('/vega-canvas/build/vega-canvas.node.js'))).toBe(false)
  } finally {
    const [actualRoot, actualParent, metadata] = await Promise.all([realpath(root), realpath(parent), lstat(root)])
    const inside = relative(actualParent, actualRoot)
    if (!inside || inside.startsWith('..') || isAbsolute(inside) || metadata.isSymbolicLink()) throw new Error('Unsafe renderer probe cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
