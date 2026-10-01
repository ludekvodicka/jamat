import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function prepareLauncher(root: string): Promise<void> {
  const platforms: Partial<Record<NodeJS.Platform, { directory: string; node: string }>> = {
    win32: { directory: 'win', node: 'node.exe' },
    darwin: { directory: 'mac', node: 'bin/node' },
    linux: { directory: 'linux', node: 'bin/node' },
  }
  const platform = platforms[process.platform]
  if (!platform) throw new Error(`unsupported launcher platform: ${process.platform}`)
  const sidecar = resolve(root, `out/remarkable-sidecar/${platform.directory}-${process.arch}/current`)
  const output = resolve(root, 'out/launcher')
  mkdirSync(output, { recursive: true })
  const result = await build({
    entryPoints: [resolve(root, 'app-launcher/start.ts')], outfile: resolve(output, 'launcher.cjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'warning',
  })
  if (result.warnings.length > 0)
    throw new Error(`launcher bundle warnings: ${result.warnings.map(warning => warning.text).join('; ')}`)
  cpSync(resolve(root, 'app-launcher/package.json'), resolve(output, 'package.json'))
  cpSync(resolve(root, 'app-launcher/README.md'), resolve(output, 'README.md'))
  cpSync(resolve(root, 'LICENSE'), resolve(output, 'LICENSE'))
  cpSync(resolve(root, 'lib-orchestrator/node_modules/ws/LICENSE'), resolve(output, 'WS-LICENSE.txt'))
  mkdirSync(dirname(resolve(output, platform.node)), { recursive: true })
  cpSync(resolve(sidecar, platform.node), resolve(output, platform.node))
  cpSync(resolve(sidecar, 'NODE-LICENSE.txt'), resolve(output, 'NODE-LICENSE.txt'))
  cpSync(resolve(root, 'scripts/setup/install-launcher.ps1'), resolve(output, 'install-launcher.ps1'))
  console.log(`Launcher bundle: ${output}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void prepareLauncher(resolve(import.meta.dirname, '../..')).catch((error: unknown) => {
    console.error(`[release:launcher] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
