/**
 * Smoke: ensureCodexProjectTrust — appends a `[projects.'<dir>'] trust_level="trusted"` block to
 * ~/.codex/config.toml so a launched Codex session doesn't block on the "trust this directory?"
 * gate. Pure unit test against temp fixtures (no real ~/.codex/config.toml touched). Uses real
 * temp DIRS because the seeder is existence-gated.
 *
 * Run: node --import tsx scripts/smoke-codex-trust.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureCodexProjectTrust } from '../core/agents/codex/trust.js'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'codex-trust-'))
let n = 0
/** A real, existing project dir (the seeder refuses non-existent paths). */
function projDir(name: string): string {
  const p = join(root, `proj-${n++}-${name}`)
  mkdirSync(p, { recursive: true })
  return p
}
/** A config.toml fixture with the given content; returns its path. */
function cfg(content: string): string {
  const p = join(root, `config-${n++}.toml`)
  writeFileSync(p, content)
  return p
}

try {
  // 1) Fresh config (existing unrelated sections) → block appended, others preserved.
  {
    const dir = projDir('fresh')
    const existing = 'model = "gpt-5.6-sol"\n\n[mcp_servers.pencil]\ncommand = "x"\n'
    const p = cfg(existing)
    const r = ensureCodexProjectTrust(dir, p, true)
    const out = readFileSync(p, 'utf8')
    const key = dir.replace(/\//g, '\\').toLowerCase()
    ok('fresh: changed=true', r.changed === true)
    ok('fresh: appended header with lowercased backslash key', out.includes(`[projects.'${key}']`), out)
    ok('fresh: trust_level = "trusted"', /trust_level = "trusted"/.test(out))
    ok('fresh: existing model line preserved', out.includes('model = "gpt-5.6-sol"'))
    ok('fresh: existing mcp section preserved', out.includes('[mcp_servers.pencil]'))
  }

  // 2) Already trusted (block present, DIFFERENT slash/case form) → idempotent no-op.
  {
    const dir = projDir('already')
    const altKey = dir.replace(/\\/g, '/').toLowerCase() // forward slashes — normalizes equal
    const p = cfg(`[projects.'${altKey}']\ntrust_level = "trusted"\n`)
    const before = readFileSync(p, 'utf8')
    const r = ensureCodexProjectTrust(dir, p, true)
    ok('already: changed=false (idempotent, normalized match)', r.changed === false)
    ok('already: file byte-identical (no duplicate table)', readFileSync(p, 'utf8') === before)
  }

  // 3) Non-existent projectDir → existence gate refuses, config untouched.
  {
    const p = cfg('model = "x"\n')
    const before = readFileSync(p, 'utf8')
    const r = ensureCodexProjectTrust(join(root, 'does-not-exist-dir'), p, true)
    ok('missing dir: changed=false (existence-gated)', r.changed === false)
    ok('missing dir: config untouched', readFileSync(p, 'utf8') === before)
  }

  // 4) Missing config file → created with just the block.
  {
    const dir = projDir('nofile')
    const p = join(root, 'brand-new-config.toml')
    const r = ensureCodexProjectTrust(dir, p, true)
    const out = readFileSync(p, 'utf8')
    const key = dir.replace(/\//g, '\\').toLowerCase()
    ok('no file: created + block written', r.changed === true && out.includes(`[projects.'${key}']`))
    ok('no file: valid trusted block', /trust_level = "trusted"/.test(out))
  }

  // 5) Second distinct project appends WITHOUT clobbering the first (two tables coexist).
  {
    const dirA = projDir('multiA')
    const dirB = projDir('multiB')
    const p = cfg('model = "x"\n')
    ensureCodexProjectTrust(dirA, p, true)
    ensureCodexProjectTrust(dirB, p, true)
    const out = readFileSync(p, 'utf8')
    const keyA = dirA.replace(/\//g, '\\').toLowerCase()
    const keyB = dirB.replace(/\//g, '\\').toLowerCase()
    ok('multi: both project headers present', out.includes(`[projects.'${keyA}']`) && out.includes(`[projects.'${keyB}']`))
    ok('multi: exactly two trust_level lines', (out.match(/trust_level = "trusted"/g) || []).length === 2)
  }

  // 6) Re-seeding an already-appended project is a no-op (self-consistent format round-trips).
  {
    const dir = projDir('roundtrip')
    const p = cfg('model = "x"\n')
    const r1 = ensureCodexProjectTrust(dir, p, true)
    const r2 = ensureCodexProjectTrust(dir, p, true)
    ok('roundtrip: first appends', r1.changed === true)
    ok('roundtrip: second is no-op (own format detected)', r2.changed === false)
  }

  // 7) Non-Windows mode preserves case + forward slashes in the key.
  {
    const dir = projDir('POSIXish')
    const p = cfg('')
    ensureCodexProjectTrust(dir, p, false)
    const out = readFileSync(p, 'utf8')
    ok('posix: key preserves original case (no lowercasing)', out.includes(`[projects.'${dir.replace(/[\\/]+$/, '')}']`), out)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
