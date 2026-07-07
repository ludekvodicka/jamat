/**
 * check-mdext-diagrams.ts — validate every ```archify fence in the given Markdown files by running
 * the REAL renderer (`renderArchify`) headlessly. Archify is the deterministic engine: its layout
 * validation THROWS on overlapping labels, off-canvas nodes, too-short connections, etc. — errors
 * that otherwise only surface when the doc is opened in the viewer (as "show source"). Running the
 * same validation here catches them BEFORE the doc ships, so a generated diagram can't silently fail.
 *
 *   node --import tsx scripts/check-mdext-diagrams.ts docs/jamat-architecture.md [more.md ...]
 *
 * Exit code 1 if any archify diagram fails to render. (Vega-Lite / Mermaid render in-browser and are
 * not validated here — only archify has offline layout validation.)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderArchify } from '../app-electron/src/renderer/widgets/mdExtRenderer/renderers/archify/index'

// With explicit args, check those files; with none, scan docs/ recursively for Markdown.
const args = process.argv.slice(2)
const files = args.length > 0
  ? args
  : readdirSync('docs', { recursive: true })
      .map((f) => join('docs', f.toString()))
      .filter((f) => f.endsWith('.md') || f.endsWith('.mdext'))

let failures = 0
let checked = 0

for (const file of files) {
  const md = readFileSync(file, 'utf8')
  const fenceRe = /```archify\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  let n = 0
  while ((match = fenceRe.exec(md)) !== null) {
    n++
    const line = md.slice(0, match.index).split('\n').length
    const where = `${file}:${line} archify#${n}`
    let spec: { diagram_type?: string }
    try {
      spec = JSON.parse(match[1])
    } catch (e) {
      console.log(`  ✗ ${where} — invalid JSON: ${(e as Error).message}`)
      failures++
      continue
    }
    checked++
    try {
      renderArchify(spec)
      console.log(`  ✓ ${where} (${spec.diagram_type})`)
    } catch (e) {
      console.log(`  ✗ ${where} (${spec.diagram_type}) — ${(e as Error).message.replace(/\n/g, ' ')}`)
      failures++
    }
  }
  if (n === 0) console.log(`  · ${file} — no archify diagrams`)
}

console.log(`\n${checked} archify diagram(s) checked, ${failures} failed.`)
process.exit(failures > 0 ? 1 : 0)
