import { build } from 'esbuild'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// CJS so Electron-as-Node (ELECTRON_RUN_AS_NODE) runs it directly; everything inlined (core/ is
// dependency-free), so the installed app needs no sources, tsx, or system Node to render the menu.
await build({
  entryPoints: [resolve(ROOT, 'app-cli/menu-tui.ts')],
  outfile: resolve(ROOT, 'app-electron/out/menu/menu-tui.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  loader: { '.ts': 'ts' },
})

console.log('Built app-cli/menu-tui.ts → app-electron/out/menu/menu-tui.cjs')
