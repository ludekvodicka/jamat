// Quick smoke test for extractSessionTurns against a real JSONL transcript.
// Usage: node --import tsx scripts/smoke-session-changes.ts [path]
//
// Not a unit test — just a runnable diagnostic against the verified corpus
// listed in the plan. Safe to delete once Unit 4 has a real test corpus.

import { extractSessionTurns } from '../core/agents/claude/session-changes.js'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'

const DEFAULT_CORPUS = join(
  homedir(),
  '.claude',
  'projects',
  'C--Code-myproject',
  'ca4100bd-1bc2-4a41-9087-5b4ae4e5995d.jsonl',
)

const path = process.argv[2] ?? DEFAULT_CORPUS

if (!existsSync(path)) {
  console.error(`\n✗ Corpus not found: ${path}`)
  console.error('  This diagnostic needs a real Claude session transcript. Pass one as an argument:')
  console.error('    node --import tsx scripts/smoke-session-changes.ts <path-to.jsonl>')
  console.error('  (Orphan diagnostic — not in `npm test`. See .aidocs/review-todos/052.)')
  process.exit(1)
}

const t0 = Date.now()
const turns = extractSessionTurns(path)
const t1 = Date.now()

console.log(`\n=== Smoke test: ${path}`)
console.log(`Parsed in ${t1 - t0}ms — ${turns.length} turns\n`)

// Cache hit timing
const t2 = Date.now()
extractSessionTurns(path)
const t3 = Date.now()
console.log(`Cache hit: ${t3 - t2}ms\n`)

// Per-turn summary
const totalFiles = new Map<string, number>()
let totalEdits = 0
for (const turn of turns) {
  const fileCount = turn.files.length
  const editCount = turn.files.reduce((s, f) => s + f.editCount, 0)
  totalEdits += editCount
  for (const f of turn.files) {
    totalFiles.set(f.filePath, (totalFiles.get(f.filePath) ?? 0) + f.editCount)
  }
  const ts = turn.timestampISO ? new Date(turn.timestampISO).toISOString().slice(11, 16) : '--:--'
  console.log(
    `Turn ${String(turn.turnIndex).padStart(2)}  ${ts}  ` +
      `files=${fileCount} edits=${editCount}  ` +
      `"${turn.userPromptTextShort}"`,
  )
  for (const f of turn.files) {
    const flag = f.isNewFile ? '[new]' : f.isOverwritten ? '[overwritten]' : ''
    console.log(
      `    ${f.editCount}× ${f.filePath.split(/[\\/]/).pop()} ${flag} ` +
        `(before=${f.beforeText.length}B, after=${f.afterText.length}B)`,
    )
  }
}

console.log(`\nTotals: ${totalFiles.size} unique files, ${totalEdits} edits`)
console.log('\nTop-edited files:')
for (const [fp, n] of [...totalFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${n}× ${fp}`)
}
