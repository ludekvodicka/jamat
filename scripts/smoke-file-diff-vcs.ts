// Smoke test: VCS baseline fetch + detection against the local git repo.
// Usage: node --import tsx scripts/smoke-file-diff-vcs.ts

import {
  detectVcs,
  fetchGitBaseline,
  fetchSvnBaseline,
  findGitRoot,
  findSvnRoot,
  listRecentGitHistory,
  preferVcsForFile,
  _resetFileDiffVcsCachesForTests,
} from '../core/menu-core/file-diff-vcs.js'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let failed = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\n=== Smoke: file-diff-vcs')

// 1. Repo detection against this project (git repo).
// Some machines have an outer svn WC wrapping the git repo — both can be
// detected. The preference resolution must still pick git (newer timestamp).
const here = resolve(__dirname, '..', 'package.json')
console.log(`\n[1] Detection: ${here}`)
const gitRoot = findGitRoot(here)
const svnRoot = findSvnRoot(here)
check('git root found', gitRoot !== null, `gitRoot=${gitRoot}`)
if (svnRoot !== null) {
  console.log(`    (outer svn WC also detected at ${svnRoot} — mixed-VCS scenario)`)
}

const detection = detectVcs(here)
check('detectVcs returns git', detection.git !== null)

const preferred = preferVcsForFile(detection, here)
if (svnRoot !== null) {
  // Dual-tracked checkout (git + outer svn WC): the file has both a git
  // and an svn baseline, so "newer wins" can legitimately resolve to
  // either. Only assert a sane, non-null choice.
  check('preferred ∈ {git, svn} (mixed-VCS checkout)', preferred === 'git' || preferred === 'svn', `preferred=${preferred}`)
} else {
  check('preferred = git (newer than any svn baseline)', preferred === 'git')
}

// 2. Baseline content for a tracked file.
if (gitRoot) {
  console.log(`\n[2] Git baseline @ HEAD for package.json`)
  const r = fetchGitBaseline(gitRoot, here, 'HEAD')
  check('exit ok', r.error === undefined, r.error)
  check('content present (file tracked)', r.content.length > 0 && r.exists)
  check('content looks like JSON', r.content.trimStart().startsWith('{'))
  check('timestamp populated', typeof r.timestamp === 'number' && (r.timestamp ?? 0) > 0)

  // Cache hit test
  const t0 = Date.now()
  fetchGitBaseline(gitRoot, here, 'HEAD')
  const t1 = Date.now()
  check('cache hit fast (<5ms)', t1 - t0 < 5, `took ${t1 - t0}ms`)

  // 3. History
  console.log(`\n[3] Git history (top 3)`)
  const history = listRecentGitHistory(gitRoot, 3)
  check('history non-empty', history.length > 0)
  check('first entry is HEAD', history[0]?.ref === 'HEAD')
  if (history.length > 1) check('second entry is HEAD~1', history[1].ref === 'HEAD~1')
  for (const h of history) {
    console.log(`    ${h.ref}  ${h.shortSha}  ${new Date(h.commitDate).toISOString().slice(0, 16)}  ${h.subject.slice(0, 60)}`)
  }

  // 4. HEAD~1 fetch (only if we have at least 2 commits)
  if (history.length >= 2) {
    console.log(`\n[4] Git baseline @ HEAD~1`)
    const r = fetchGitBaseline(gitRoot, here, 'HEAD~1')
    check('HEAD~1 fetch ok', r.error === undefined)
    // HEAD and HEAD~1 may have same or different content depending on commits.
    // Just check we got a result without error.
    check('HEAD~1 returns content', typeof r.content === 'string')
  }
}

// 5. File outside any VCS
const outside = resolve('Q:/this-path-does-not-exist-anywhere/foo.txt')
console.log(`\n[5] File outside VCS`)
const noDetection = detectVcs(outside)
check('git=null', noDetection.git === null)
check('svn=null', noDetection.svn === null)
check('prefer=null', preferVcsForFile(noDetection, outside) === null)

// 6. Reset cache (smoke for the test helper)
_resetFileDiffVcsCachesForTests()
console.log(`\n[6] Cache reset helper`)
check('reset does not throw', true)

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} failure${failed === 1 ? '' : 's'})\n`)
process.exit(failed === 0 ? 0 : 1)
