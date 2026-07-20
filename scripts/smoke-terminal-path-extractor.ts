/**
 * Smoke for the terminal file-path extractors (core/terminal). Verifies the per-agent registry, the
 * universal resolve() behavior, the Claude ellipsis handling, the Codex driveless rewrite, and the
 * pure wildcard suffix matcher that file:find-by-suffix reuses.
 *
 * Run: `npx tsx scripts/smoke-terminal-path-extractor.ts`
 */

import { TerminalFilePathExtractor, type PathCandidate } from '../core/terminal/terminalFilePathExtractor'
import { getTerminalFilePathExtractor } from '../core/terminal/terminalFilePathExtractors'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function directOf(cands: PathCandidate[]): string | null {
  const d = cands.find((c) => c.kind === 'direct')
  return d?.kind === 'direct' ? d.path : null
}
function searchOf(cands: PathCandidate[]): { baseDir: string; partial: string } | null {
  const s = cands.find((c) => c.kind === 'search')
  return s?.kind === 'search' ? { baseDir: s.baseDir, partial: s.partial } : null
}

const claude = getTerminalFilePathExtractor('claude')
const codex = getTerminalFilePathExtractor('codex')

console.log('\n[1] Registry')
ok('claude extractor has agent claude', claude.agent === 'claude')
ok('codex extractor has agent codex', codex.agent === 'codex')
ok('distinct instances per agent', claude !== codex)
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTerminalFilePathExtractor('gpt' as any)
  ok('unknown agent id throws', false, 'no throw')
} catch (err) {
  ok('unknown agent id throws', String(err).includes('unknown agent id'))
}

console.log('\n[2] Universal resolve() — direct candidates (via the Claude extractor, which inherits base resolve)')
const proj = 'Q:\\Proj'
ok('drive-absolute kept as-is', directOf(claude.resolve('C:\\foo\\bar.ts', { projectDir: proj })) === 'C:\\foo\\bar.ts')
ok('forward slashes normalized to backslashes', directOf(claude.resolve('C:/foo/bar.ts', { projectDir: proj })) === 'C:\\foo\\bar.ts')
ok('~ kept for main-side expandHome', directOf(claude.resolve('~/notes.md', { projectDir: proj })) === '~\\notes.md')
ok('UNC path kept as-is', directOf(claude.resolve('\\\\server\\share\\x.txt', { projectDir: null })) === '\\\\server\\share\\x.txt')
ok('relative joined under projectDir', directOf(claude.resolve('src/foo.ts', { projectDir: proj })) === 'Q:\\Proj\\src\\foo.ts')
ok('relative with no projectDir → no direct candidate', directOf(claude.resolve('src/foo.ts', { projectDir: null })) === null)
ok('trailing :line:col stripped', directOf(claude.resolve('C:\\foo\\bar.ts:12:5', { projectDir: proj })) === 'C:\\foo\\bar.ts')
ok('surrounding quotes stripped', directOf(claude.resolve('"C:\\a\\b.ts"', { projectDir: proj })) === 'C:\\a\\b.ts')

console.log('\n[3] Claude ellipsis truncation')
ok('claude keeps U+2026 in its path char class', claude.pathChars.test('…') === true)
ok('codex (base) does NOT treat U+2026 as a path char', codex.pathChars.test('…') === false)
{
  const cands = claude.resolve('2026-07-10-001-…-plan.md', { projectDir: proj })
  const search = searchOf(cands)
  ok('claude emits a search candidate for a truncated name', search !== null)
  ok('search partial keeps the ellipsis', search?.partial === '2026-07-10-001-…-plan.md')
  ok('search baseDir is the project dir', search?.baseDir === proj)
}

console.log('\n[4] Wildcard suffix matcher (pure — reused by file:find-by-suffix)')
const planFile = ['.aidocs', 'plans', '2026-07-10-001-refactor-universal-agent-codex-plan.md']
ok('ellipsis pattern matches the real truncated plan file',
  TerminalFilePathExtractor.matchesSuffix(planFile, ['2026-07-10-001-…-plan.md']) === true)
ok('ellipsis pattern rejects a non-matching file',
  TerminalFilePathExtractor.matchesSuffix(['x', '2026-07-11-999-other-doc.md'], ['2026-07-10-001-…-plan.md']) === false)
ok('literal "..." also acts as a wildcard',
  TerminalFilePathExtractor.segTester('2026-...-plan.md')('2026-abc-plan.md') === true)
ok('* acts as a wildcard', TerminalFilePathExtractor.segTester('foo*bar')('fooXYZbar') === true)
ok('* wildcard rejects a non-match', TerminalFilePathExtractor.segTester('foo*bar')('fooXYZbaz') === false)
ok('exact (non-wildcard) segment still matches', TerminalFilePathExtractor.segTester('c.ts')('c.ts') === true)
ok('exact segment rejects a different name', TerminalFilePathExtractor.segTester('c.ts')('x.ts') === false)
ok('multi-segment suffix matches', TerminalFilePathExtractor.matchesSuffix(['proj', 'src', 'foo.ts'], ['src', 'foo.ts']) === true)
ok('multi-segment suffix rejects a wrong parent', TerminalFilePathExtractor.matchesSuffix(['proj', 'lib', 'foo.ts'], ['src', 'foo.ts']) === false)
ok('longer pattern than file → no match', TerminalFilePathExtractor.matchesSuffix(['foo.ts'], ['src', 'foo.ts']) === false)

console.log('\n[5] Codex driveless .codex rewrite')
const rollout = '\\Users\\jane.doe\\.codex\\sessions\\2026\\04\\24\\rollout-2026-04-24T08-43-47-019dbe3a-f2de-77d0-996c-cc68e183a3a7.jsonl'
const expectedRewrite = '~\\.codex\\sessions\\2026\\04\\24\\rollout-2026-04-24T08-43-47-019dbe3a-f2de-77d0-996c-cc68e183a3a7.jsonl'
{
  const cands = codex.resolve(rollout, { projectDir: null })
  ok('codex rewrites the driveless rollout path to a single direct ~ candidate', cands.length === 1 && directOf(cands) === expectedRewrite)
}
ok('codex rewrite works with forward slashes too',
  directOf(codex.resolve(rollout.replace(/\\/g, '/'), { projectDir: null })) === expectedRewrite)
ok('claude does NOT rewrite a codex driveless path (per-agent difference)',
  directOf(claude.resolve(rollout, { projectDir: null })) === rollout)
ok('codex leaves a drive-absolute .codex path unchanged (base handles it)',
  directOf(codex.resolve('C:\\Users\\x\\.codex\\sessions\\a\\rollout-y.jsonl', { projectDir: null })) === 'C:\\Users\\x\\.codex\\sessions\\a\\rollout-y.jsonl')
ok('codex passes a non-.codex driveless path through to base (unchanged)',
  directOf(codex.resolve('\\Foo\\bar.txt', { projectDir: null })) === '\\Foo\\bar.txt')

console.log('\n[6] looksSearchable gate')
ok('truncated dotted name is searchable', TerminalFilePathExtractor.looksSearchable('2026-07-10-001-…-plan.md') === true)
ok('a dotted relative path is searchable', TerminalFilePathExtractor.looksSearchable('src/foo.ts') === true)
ok('a bare word (no dot) is NOT searchable', TerminalFilePathExtractor.looksSearchable('README') === false)
ok('a lone ellipsis is NOT searchable', TerminalFilePathExtractor.looksSearchable('…') === false)

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
