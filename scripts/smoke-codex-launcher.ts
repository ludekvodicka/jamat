/**
 * Smoke for the Codex launcher (U4) — the mode × isolation matrix, resume
 * chains, ccc fallback, and the (until-U7) Docker refusal.
 *
 * Run: `npx tsx scripts/smoke-codex-launcher.ts`
 */

import { buildCodexLaunchCommand } from '../core/agents/codex/launcher'
import type { MenuSelection } from '../core/types/contracts'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const RID = '12345678-1234-1234-1234-123456789012'
function sel(cmd: MenuSelection['cmd'], extra: Partial<MenuSelection> = {}): MenuSelection {
  return { dir: '/proj', cmd, folderName: 'proj', isolated: false, antiFlicker: false, agent: 'codex', ...extra }
}

console.log('\n[1] terminal (native) — arg vectors')
{
  const cc = buildCodexLaunchCommand({ selection: sel('cc'), mode: 'terminal' })
  ok('cc: command=codex, cwd, empty env', cc.command === 'codex' && cc.cwd === '/proj' && Object.keys(cc.env).length === 0)
  ok('cc: skip-perms flag by default', cc.args.includes('--dangerously-bypass-approvals-and-sandbox'))

  const ccNoSkip = buildCodexLaunchCommand({ selection: sel('cc'), mode: 'terminal', skipPermissions: false })
  ok('cc: no bypass flag when skipPermissions=false', !ccNoSkip.args.includes('--dangerously-bypass-approvals-and-sandbox'))

  const resume = buildCodexLaunchCommand({ selection: sel('resume', { sessionId: RID }), mode: 'terminal' })
  ok('resume: args = ["resume", <id>, ...]', resume.args[0] === 'resume' && resume.args[1] === RID)
  ok('resume: no fallback (must fail loudly if id gone)', resume.fallback === undefined)

  const ccc = buildCodexLaunchCommand({ selection: sel('ccc'), mode: 'terminal' })
  ok('ccc: args = resume --last', ccc.args[0] === 'resume' && ccc.args[1] === '--last')
  ok('ccc: fallback drops resume (plain codex)', !!ccc.fallback && !ccc.fallback.args.includes('resume'))
}

console.log('\n[2] pty (native) — shell chains carry the || fallback')
{
  const ccc = buildCodexLaunchCommand({ selection: sel('ccc'), mode: 'pty' })
  const chain = ccc.args.join(' ')
  ok('ccc pty chain: `codex resume --last ... || codex`', /codex resume --last.*\|\|\s*codex/.test(chain), chain)

  const resume = buildCodexLaunchCommand({ selection: sel('resume', { sessionId: RID }), mode: 'pty' })
  const rchain = resume.args.join(' ')
  ok('resume pty chain has `codex resume <id>` and NO ||', rchain.includes(`codex resume ${RID}`) && !rchain.includes('||'), rchain)

  const cc = buildCodexLaunchCommand({ selection: sel('cc'), mode: 'pty' })
  ok('cc pty chain runs plain codex', cc.args.join(' ').includes('codex'))
}

console.log('\n[3] fork maps to `codex fork <id>` + resume fork-parent fallback + invalid sessionId')
{
  const forkT = buildCodexLaunchCommand({ selection: sel('resume-fork', { sessionId: RID }), mode: 'terminal' })
  ok('resume-fork → args fork <id>', forkT.args[0] === 'fork' && forkT.args[1] === RID)

  const forkPty = buildCodexLaunchCommand({ selection: sel('resume-fork', { sessionId: RID }), mode: 'pty' })
  ok('resume-fork pty chain runs `codex fork <id>`', forkPty.args.join(' ').includes(`codex fork ${RID}`))

  // A resume carrying a fork PARENT re-forks the parent when the fork's own id is gone.
  const PID = '87654321-4321-4321-4321-210987654321'
  const rfb = buildCodexLaunchCommand({ selection: sel('resume', { sessionId: RID, forkParentId: PID }), mode: 'terminal' })
  ok('resume+forkParent → fallback forks the parent', !!rfb.fallback && rfb.fallback.args[0] === 'fork' && rfb.fallback.args[1] === PID)
  const rfbChain = buildCodexLaunchCommand({ selection: sel('resume', { sessionId: RID, forkParentId: PID }), mode: 'pty' }).args.join(' ')
  ok('resume+forkParent pty chain: resume <id> || fork <parent>', /codex resume .*\|\|\s*codex fork/.test(rfbChain), rfbChain)

  let badIdThrew = false
  try { buildCodexLaunchCommand({ selection: sel('resume', { sessionId: 'not-a-uuid' }), mode: 'terminal' }) } catch { badIdThrew = true }
  ok('invalid sessionId throws', badIdThrew)
}

console.log('\n[4] Docker isolation refused until U7')
{
  let threw = false
  let msg = ''
  try {
    buildCodexLaunchCommand({ selection: sel('cc', { isolated: true }), mode: 'pty', dockerContextDir: '/repo/dockerized-claude' })
  } catch (e) { threw = true; msg = String(e) }
  ok('isolated Codex launch throws (not Claude-in-docker)', threw)
  ok('refusal message mentions Codex isolation', /Codex Docker isolation/.test(msg))
}

console.log('\n[5] unknown mode throws')
{
  let threw = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { buildCodexLaunchCommand({ selection: sel('cc'), mode: 'bogus' as any }) } catch { threw = true }
  ok('unknown launch mode throws', threw)
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
