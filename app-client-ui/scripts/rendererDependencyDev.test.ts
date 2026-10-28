import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { createServer, normalizePath, type ViteDevServer } from 'vite'
import { expect, it } from 'vitest'
import config from '../electron.vite.config'

it('serves optimized React DOM and JSX dependencies with CommonJS import interoperability', async () => {
  const parent = join(import.meta.dirname, '../../.aidocs/temp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'usage-dev-'))
  let server: ViteDevServer | undefined
  const deadline = setTimeout(() => { void server?.close() }, 20_000)
  try {
    const entry = join(root, 'probe.ts')
    await writeFile(entry, [
      "import { createRoot } from 'react-dom/client'",
      "import { jsx } from 'react/jsx-runtime'",
      'export { createRoot, jsx }',
    ].join('\n'))
    server = await createServer({ ...config.renderer, configFile: false, envFile: false,
      cacheDir: join(root, 'cache'), publicDir: false, logLevel: 'warn', appType: 'custom',
      server: { ...config.renderer?.server, host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null },
      optimizeDeps: { ...config.renderer?.optimizeDeps, entries: [entry] },
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP server')
    const origin = `http://127.0.0.1:${address.port}`
    const response = await fetch(`${origin}/@fs/${normalizePath(entry)}`, { signal: AbortSignal.timeout(10_000) })
    expect(response.status).toBe(200)
    const code = await response.text()
    const client = server.environments.client
    for (const [source, exported] of [['react-dom/client', 'createRoot'], ['react/jsx-runtime', 'jsx']]) {
      const resolved = await client.pluginContainer.resolveId(source, entry)
      expect(resolved).not.toBeNull()
      if (!resolved) throw new Error(`Unresolved dependency: ${source}`)
      expect(client.depsOptimizer?.isOptimizedDepFile(resolved.id)).toBe(true)
      expect(resolved.id.startsWith(`${normalizePath(root)}/cache/`)).toBe(true)
      expect(code).toContain(`["${exported}"]`)
      const dependency = await fetch(`${origin}/@fs/${resolved.id}`, { signal: AbortSignal.timeout(10_000) })
      expect(dependency.status).toBe(200)
      expect(await dependency.text()).toContain('export default')
    }
  } finally {
    clearTimeout(deadline)
    try { await server?.close() } finally {
      const [actualRoot, actualParent, metadata] = await Promise.all([realpath(root), realpath(parent), lstat(root)])
      const inside = relative(actualParent, actualRoot)
      if (!inside || inside.startsWith('..') || isAbsolute(inside) || metadata.isSymbolicLink()) throw new Error('Unsafe renderer dev probe cleanup')
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30_000)
