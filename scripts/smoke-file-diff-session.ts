// Smoke test: composeFileBaselineFromSession against the verified JSONL
// corpus listed in the FileViewer-diff plan.
// Usage: node --import tsx scripts/smoke-file-diff-session.ts

import { extractSessionTurns } from '../core/agents/claude/session-changes.js'
import {
  composeFileBaselineFromSession,
  sessionHasEditsForFile,
  turnCountForFile,
} from '../core/menu-core/file-diff-session.js'
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
const CORPUS = process.argv[2] ?? DEFAULT_CORPUS

if (!existsSync(CORPUS)) {
  console.error(`\n✗ Corpus not found: ${CORPUS}`)
  console.error('  This smoke needs a real Claude session transcript. Pass one as an argument:')
  console.error('    node --import tsx scripts/smoke-file-diff-session.ts <path-to.jsonl>')
  console.error('  (Orphan diagnostic — not in `npm test`. See .aidocs/review-todos/051.)')
  process.exit(1)
}

let failed = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log(`\n=== Smoke: file-diff-session`)
console.log(`Corpus: ${CORPUS}\n`)

const turns = extractSessionTurns(CORPUS)
console.log(`[setup] ${turns.length} turns parsed`)

// Pick any file that has edits in this session to exercise the helpers.
const editedFiles = new Set<string>()
for (const t of turns) for (const e of t.files) editedFiles.add(e.filePath)
const candidate = [...editedFiles][0]
console.log(`[setup] using file: ${candidate ?? '<none>'}\n`)

if (!candidate) {
  console.log('Corpus has no edits — cannot run session compose checks.')
  process.exit(failed === 0 ? 0 : 1)
}

// [1] sessionHasEditsForFile + turnCountForFile
console.log('[1] Index helpers')
check('sessionHasEditsForFile(candidate) = true', sessionHasEditsForFile(turns, candidate))
const turnCount = turnCountForFile(turns, candidate)
check('turnCountForFile > 0', turnCount > 0, `got ${turnCount}`)
check('sessionHasEditsForFile(unknown) = false', !sessionHasEditsForFile(turns, 'Q:/nope/never.ts'))

// [2] composeFileBaselineFromSession with synthetic disk content that
// contains the regionAfter — substitution should produce a whole-file
// before (NOT region-only).
console.log('\n[2] session-start with substituting disk content')
// We synthesize disk content by sandwiching the regionAfter of the net diff.
// To find it we briefly run session-start against an empty disk first.
const dryRun = composeFileBaselineFromSession(turns, candidate, { kind: 'session-start' }, '')
if (!dryRun) {
  console.log('  (could not compose net diff for candidate — skipping)')
} else {
  const regionAfter = dryRun.afterText
  const synthDisk = `// PREFIX HEADER\n${regionAfter}\n// SUFFIX TAIL\n`
  const result = composeFileBaselineFromSession(turns, candidate, { kind: 'session-start' }, synthDisk)
  check('returns non-null', result !== null)
  if (result) {
    check('isRegionOnly = false (substitution succeeded)', !result.isRegionOnly, result.regionOnlyReason)
    check('afterText = whole synthDisk', result.afterText === synthDisk)
    check('beforeText starts with PREFIX', result.beforeText.startsWith('// PREFIX HEADER'))
    check('beforeText ends with SUFFIX', result.beforeText.endsWith('// SUFFIX TAIL\n'))
  }
}

// [3] last-turn point
console.log('\n[3] last-turn point')
const last = composeFileBaselineFromSession(turns, candidate, { kind: 'last-turn' }, 'irrelevant disk content')
if (last) {
  // With unrelated disk content, the region won't be found → region-only.
  check('last-turn returns result', last !== null)
  check('isRegionOnly = true (disk diverged)', last.isRegionOnly)
  check('regionOnlyReason set', !!last.regionOnlyReason)
} else {
  console.log('  (last-turn returned null — corpus may not match)')
}

// [4] turn-back N
console.log('\n[4] turn-back n=2')
const tb = composeFileBaselineFromSession(turns, candidate, { kind: 'turn-back', n: 2 }, '')
check('turn-back n=2 returns result', tb !== null)

// [5] unknown file returns null
console.log('\n[5] unknown file')
const unk = composeFileBaselineFromSession(turns, 'Q:/no/such/file.ts', { kind: 'session-start' }, '')
check('unknown file → null', unk === null)

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failure${failed === 1 ? '' : 's'})\n`)
process.exit(failed === 0 ? 0 : 1)
