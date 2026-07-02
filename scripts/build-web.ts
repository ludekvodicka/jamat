import { build } from 'esbuild'
import { resolve, dirname } from 'path'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const PURE_TS = resolve(ROOT, 'core/menu-core/pure.ts')

// Auto-discover exported function names from pure.ts
const source = readFileSync(PURE_TS, 'utf-8')
const exports = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1])
const footer = exports.map(name => `var ${name} = __pure.${name};`).join('\n')

await build({
  entryPoints: [PURE_TS],
  outfile: resolve(ROOT, 'app-agent/web/shared.js'),
  bundle: true,
  format: 'iife',
  globalName: '__pure',
  platform: 'browser',
  target: 'es2022',
  loader: { '.ts': 'ts' },
  footer: { js: footer },
})

console.log(`Built pure.ts → shared.js (${exports.length} functions: ${exports.join(', ')})`)
