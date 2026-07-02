/**
 * Smoke: ensureClaudeProjectTrust — pre-seeds ~/.claude.json trust/import flags for a project
 * dir so a launched Claude session doesn't block on the trust / external-CLAUDE.md-import
 * dialogs. Pure unit test against temp fixtures (no real ~/.claude.json touched).
 *
 * Run: node --import tsx scripts/smoke-claude-trust.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureClaudeProjectTrust, normalizeProjectKey, TRUST_FLAGS } from '../core/agents/claude/trust.js'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'claude-trust-'))
let n = 0
function fixture(content: unknown): string {
  const p = join(dir, `cj-${n++}.json`)
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return p
}
function read(p: string): any { return JSON.parse(readFileSync(p, 'utf8')) }
function allTrue(entry: any): boolean { return !!entry && TRUST_FLAGS.every(f => entry[f] === true) }

try {
  // 1) Brand-new dir (no entry) → canonical entry created, all flags true, changed.
  {
    const p = fixture({ projects: { 'C:/Projects/Other': { hasTrustDialogAccepted: true } } })
    const r = ensureClaudeProjectTrust('C:\\Projects\\NewProj', p)
    const j = read(p)
    ok('new dir: changed=true', r.changed === true)
    ok('new dir: canonical (forward-slash) key seeded', allTrue(j.projects['C:/Projects/NewProj']))
    ok('new dir: unrelated project untouched', j.projects['C:/Projects/Other'].hasTrustDialogAccepted === true)
  }

  // 2) Existing entry, all flags false → flipped to true, changed.
  {
    const p = fixture({ projects: { 'C:/Projects/X': { hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false, allowedTools: ['Bash'] } } })
    const r = ensureClaudeProjectTrust('C:\\Projects\\X', p)
    const j = read(p)
    ok('existing false: changed=true', r.changed === true)
    ok('existing false: flags now true', allTrue(j.projects['C:/Projects/X']))
    ok('existing false: other fields preserved', JSON.stringify(j.projects['C:/Projects/X'].allowedTools) === JSON.stringify(['Bash']))
  }

  // 3) Already all true → idempotent no-op (no write).
  {
    const entry: any = {}
    for (const f of TRUST_FLAGS) entry[f] = true
    const p = fixture({ projects: { 'C:/Projects/Done': entry } })
    const before = readFileSync(p, 'utf8')
    const r = ensureClaudeProjectTrust('C:/Projects/Done', p)
    ok('already true: changed=false (idempotent)', r.changed === false)
    ok('already true: file byte-identical (no churn)', readFileSync(p, 'utf8') === before)
  }

  // 4) Case-insensitive + slash match: existing lowercase-drive forward-slash key gets fixed
  //    even when called with uppercase backslash dir.
  {
    const p = fixture({ projects: { 'c:/projects/casetest': { hasTrustDialogAccepted: false } } })
    const r = ensureClaudeProjectTrust('C:\\Projects\\CaseTest', p)
    const j = read(p)
    ok('case-insensitive: existing lowercase key flagged', allTrue(j.projects['c:/projects/casetest']))
    ok('case-insensitive: changed=true', r.changed === true)
  }

  // 5) Missing file and corrupt JSON → no throw, changed=false.
  {
    const r1 = ensureClaudeProjectTrust('C:\\Projects\\X', join(dir, 'does-not-exist.json'))
    ok('missing file: changed=false, no throw', r1.changed === false)
    const bad = fixture('{ this is not json')
    const r2 = ensureClaudeProjectTrust('C:\\Projects\\X', bad)
    ok('corrupt json: changed=false, no throw', r2.changed === false)
    ok('corrupt json: file left untouched', readFileSync(bad, 'utf8') === '{ this is not json')
  }

  // 6) No `projects` map yet → created.
  {
    const p = fixture({ numStartups: 5 })
    const r = ensureClaudeProjectTrust('C:\\Projects\\Fresh', p)
    const j = read(p)
    ok('no projects map: created + seeded', r.changed === true && allTrue(j.projects['C:/Projects/Fresh']))
    ok('no projects map: sibling top-level keys preserved', j.numStartups === 5)
  }

  // 7) normalizeProjectKey behavior.
  ok('normalize: backslashes → forward', normalizeProjectKey('Q:\\A\\B') === 'Q:/A/B')
  ok('normalize: trailing slash stripped', normalizeProjectKey('Q:/A/B/') === 'Q:/A/B')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
