/**
 * Smoke for the per-agent PRE-LAUNCH hook (Settings → Agents; runs the Codex AGENTS.md packer before
 * a Codex launch). Covers `resolveAgentPreLaunch` lookup, the `{dir}`/`{name}` + `~` expansion and
 * argv/cwd/timeout resolution (via an injected spawnSync stub, platform-agnostic), the non-fatal
 * failure contract, and a REAL end-to-end `node` spawn against a throwaway hook script.
 *
 * Run: node --import tsx scripts/smoke-pre-launch.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SpawnSyncReturns } from 'node:child_process'
import { resolveAgentPreLaunch, runAgentPreLaunch } from '../core/executor/pre-launch.js'
import type { AgentsConfig, AgentPreLaunch } from '../core/types/config.js'
import type { MenuSelection } from '../core/types/contracts.js'

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'prelaunch-'))
function sel(dir: string, folderName = 'abc'): MenuSelection {
  return { dir, cmd: 'cc', folderName, isolated: false, antiFlicker: false, agent: 'codex' }
}
/** A spawnSync stub that records its call and returns a canned result. */
function stub(result: Partial<SpawnSyncReturns<string>>) {
  const calls: { file: string; args: string[]; opts: any }[] = []
  const fn = ((file: string, args: string[], opts: any) => {
    calls.push({ file, args, opts })
    return { status: 0, signal: null, stdout: '', stderr: '', pid: 1, output: [], ...result } as SpawnSyncReturns<string>
  }) as unknown as typeof import('node:child_process').spawnSync
  return { fn, calls }
}

try {
  console.log('\n[1] resolveAgentPreLaunch — lookup')
  {
    const hook: AgentPreLaunch = { command: 'node', args: ['x'] }
    const agents: AgentsConfig = { codex: { preLaunch: hook } }
    ok('codex hook resolves', resolveAgentPreLaunch(agents, 'codex') === hook)
    ok('claude (absent) → undefined', resolveAgentPreLaunch(agents, 'claude') === undefined)
    ok('agents undefined → undefined', resolveAgentPreLaunch(undefined, 'codex') === undefined)
    ok('agent undefined → undefined', resolveAgentPreLaunch(agents, undefined) === undefined)
  }

  console.log('\n[2] substitution + ~ expansion + argv/cwd/timeout (injected spawnSync)')
  {
    const s = stub({ status: 0 })
    const hook: AgentPreLaunch = {
      command: '~/bin/tool',
      args: ['--dir', '{dir}', '--name', '{name}', '~/x'],
      cwd: '{dir}',
      timeoutMs: 1234,
    }
    const r = runAgentPreLaunch(hook, sel('/proj/abc', 'abc'), { spawnSync: s.fn, homeDir: '/home/me' })
    ok('status ok on exit 0', r.status === 'ok')
    ok('spawn called once', s.calls.length === 1)
    const joined = `${s.calls[0]?.file} ${(s.calls[0]?.args ?? []).join(' ')}`
    ok('{dir} substituted', joined.includes('/proj/abc'), joined)
    ok('{name} substituted', joined.includes('--name abc'), joined)
    ok('~ expanded in command', joined.includes('/home/me/bin/tool'), joined)
    ok('~ expanded in args', joined.includes('/home/me/x'), joined)
    ok('cwd substituted', s.calls[0]?.opts?.cwd === '/proj/abc', String(s.calls[0]?.opts?.cwd))
    ok('timeout passed through', s.calls[0]?.opts?.timeout === 1234, String(s.calls[0]?.opts?.timeout))
  }

  console.log('\n[3] default timeout when unset')
  {
    const s = stub({ status: 0 })
    runAgentPreLaunch({ command: 'node' }, sel('/p'), { spawnSync: s.fn, homeDir: '/h' })
    ok('default 20000 ms', s.calls[0]?.opts?.timeout === 20000, String(s.calls[0]?.opts?.timeout))
  }

  console.log('\n[4] skipped (no hook / empty command) — never spawns')
  {
    const s = stub({ status: 0 })
    ok('undefined hook → skipped', runAgentPreLaunch(undefined, sel('/p'), { spawnSync: s.fn }).status === 'skipped')
    ok('blank command → skipped', runAgentPreLaunch({ command: '   ' }, sel('/p'), { spawnSync: s.fn }).status === 'skipped')
    ok('no spawn on skip', s.calls.length === 0)
  }

  console.log('\n[5] non-fatal failures (never throws)')
  {
    const sFail = stub({ status: 1, stderr: 'ERROR: --dir is unsupported outside an Applications* tree\n' })
    const rf = runAgentPreLaunch({ command: 'node' }, sel('/p'), { spawnSync: sFail.fn, homeDir: '/h' })
    ok('exit 1 → failed', rf.status === 'failed')
    ok('failed detail = last stderr line', rf.detail === 'ERROR: --dir is unsupported outside an Applications* tree', rf.detail)

    const sErr = stub({ error: new Error('spawn ENOENT') as any, status: null })
    const re = runAgentPreLaunch({ command: 'nope' }, sel('/p'), { spawnSync: sErr.fn, homeDir: '/h' })
    ok('spawn error → failed', re.status === 'failed' && /ENOENT/.test(re.detail ?? ''))

    const sSig = stub({ status: null, signal: 'SIGTERM' as any })
    const rs = runAgentPreLaunch({ command: 'node' }, sel('/p'), { spawnSync: sSig.fn, homeDir: '/h' })
    ok('killed/timeout (status null) → failed', rs.status === 'failed' && /SIGTERM/.test(rs.detail ?? ''))
  }

  console.log('\n[6] REAL node spawn — hook runs in the project dir, exit code interpreted')
  {
    // Fake hook: exits 1 when any arg is FAIL, else writes a marker in its CWD carrying its args.
    const hookScript = join(root, 'fake-hook.mjs')
    writeFileSync(hookScript, [
      "import { writeFileSync } from 'node:fs'",
      'const a = process.argv.slice(2)',
      "if (a.includes('FAIL')) { console.error('ERROR: intentional'); process.exit(1) }",
      "writeFileSync('ran.marker', a.join(' '))",
      'process.exit(0)',
    ].join('\n'))

    const projDir = join(root, 'proj')
    mkdirSync(projDir, { recursive: true })
    const okRun = runAgentPreLaunch({ command: 'node', args: [hookScript, '--dir', '{dir}'] }, sel(projDir))
    ok('real run status ok', okRun.status === 'ok', okRun.detail)
    const marker = join(projDir, 'ran.marker')
    ok('hook ran in the project dir (marker written there)', existsSync(marker))
    ok('marker carries the substituted {dir}', existsSync(marker) && readFileSync(marker, 'utf8').includes(projDir))

    const failRun = runAgentPreLaunch({ command: 'node', args: [hookScript, 'FAIL'] }, sel(projDir))
    ok('real run non-zero → failed (non-fatal)', failRun.status === 'failed', failRun.detail)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed}/${passed + failed}) ===`)
process.exit(failed === 0 ? 0 : 1)
