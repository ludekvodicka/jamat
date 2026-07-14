/**
 * Smoke for the agent registry. Verifies the interface shape, both
 * adapters registered, the lookup helpers, and sessionId→agent
 * resolution.
 *
 * Run: `npx tsx scripts/smoke-agents-registry.ts`
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { getAgent, listAgents, listAvailableAgents, resolveAgentForSessionId } from '../core/agents/index'
import { getRendererAgent } from '../core/agents/renderer'
import { normalizeTty } from '../core/agents/claude/patterns'

let passed = 0
let failed = 0

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n[1] Registry contents')
const all = listAgents()
ok('two agents registered', all.length === 2)
ok('claude registered', all.some((a) => a.id === 'claude'))
ok('codex registered', all.some((a) => a.id === 'codex'))

console.log('\n[2] getAgent lookup')
const claude = getAgent('claude')
ok('claude has correct id', claude.id === 'claude')
ok('claude displayName', claude.displayName === 'Claude')
ok('claude binary', claude.binary === 'claude')

const codex = getAgent('codex')
ok('codex has correct id', codex.id === 'codex')
ok('codex displayName', codex.displayName === 'Codex')
ok('codex binary', codex.binary === 'codex')

console.log('\n[3] getAgent on unknown id throws')
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAgent('gpt-4' as any)
  ok('threw on unknown id', false, 'no throw')
} catch (err) {
  ok('threw on unknown id', String(err).includes('unknown agent id'))
}

console.log('\n[4] Codex CLI is real (U4) — exec command shape + launch/resume chains')
// Build the discovery index against a FRESH empty home first, so later homedir()-based
// discovery calls in this file reuse the empty index (the index is a process singleton) —
// keeps this smoke off the machine's real 25k-file ~/.codex tree.
const emptyHome = mkdtempSync(join(tmpdir(), 'codex-empty-'))
ok('codex.findSessionFileById → null on a home with no ~/.codex', codex.findSessionFileById('12345678-1234-1234-1234-123456789012', emptyHome) === null)
rmSync(emptyHome, { recursive: true, force: true })
{
  const ex = codex.buildExecCommand('summarize', 'gpt-5.6-sol', { stdinPayload: 'DIFF', ephemeral: true })
  ok('codex.buildExecCommand command = codex', ex.command === 'codex')
  ok('codex exec args = exec --json', ex.args.includes('exec') && ex.args.includes('--json'))
  ok('codex exec args include the model', ex.args.includes('--model') && ex.args.includes('gpt-5.6-sol'))
  ok('codex exec args include --ephemeral', ex.args.includes('--ephemeral'))
  ok('codex exec prompt is the last arg', ex.args[ex.args.length - 1] === 'summarize')
  ok('codex exec stdin carries the diff payload', ex.stdin === 'DIFF')
}
{
  // A new-session launch (cmd 'cc') in terminal mode.
  const cc = codex.buildLaunchCommand({ dir: '/proj', cmd: 'cc', folderName: 'proj', isolated: false, antiFlicker: false, agent: 'codex' }, 'terminal')
  ok('codex launch cc → command codex, cwd /proj', cc.command === 'codex' && cc.cwd === '/proj')
  ok('codex launch cc skip-perms flag', cc.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  // Resume a specific session.
  const rid = '12345678-1234-1234-1234-123456789012'
  const rs = codex.buildLaunchCommand({ dir: '/proj', cmd: 'resume', sessionId: rid, folderName: 'proj', isolated: false, antiFlicker: false, agent: 'codex' }, 'terminal')
  ok('codex resume → args resume <id>', rs.args[0] === 'resume' && rs.args[1] === rid)
  // Fork maps resume-fork → `codex fork <id>`.
  const fk = codex.buildLaunchCommand({ dir: '/proj', cmd: 'resume-fork', sessionId: rid, folderName: 'proj', isolated: false, antiFlicker: false, agent: 'codex' }, 'terminal')
  ok('codex resume-fork → args fork <id>', fk.args[0] === 'fork' && fk.args[1] === rid)
  // parseExecOutput reduces the NDJSON stream to the final agent_message.
  const ndjson = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"working on it"}}',
    '{"type":"item.completed","item":{"type":"file_change"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Done: created foo."}}',
    '{"type":"turn.completed","usage":{}}',
  ].join('\n')
  ok('codex.parseExecOutput → last agent_message', codex.parseExecOutput(ndjson) === 'Done: created foo.')
  ok('codex.parseExecOutput → "" on empty/garbage', codex.parseExecOutput('not json\n{bad}') === '')
}

console.log('\n[5] Codex sessionsRoot points at ~/.codex/sessions')
ok('codex sessionsRoot path', codex.sessionsRoot('/home/u').replace(/\\/g, '/') === '/home/u/.codex/sessions')

console.log('\n[6] listAvailableAgents PATH filter is exercised')
const avail = listAvailableAgents()
ok('listAvailableAgents returned array', Array.isArray(avail))
ok('availability is a subset of all', avail.every((a) => all.some((b) => b.id === a.id)))
// We don't assert which agents are available since the test env may
// have or lack `claude`/`codex` on PATH — just that the filter works.

console.log('\n[7] Claude adapter — real facade over existing core/menu-core modules')
ok('claude.sessionsRoot ends with .claude/projects', claude.sessionsRoot('/home/u').replace(/\\/g, '/').endsWith('.claude/projects'))
ok('claude.encodeProjectDir replaces non-alnum', claude.encodeProjectDir('Q:\\foo bar') === 'Q--foo-bar')
ok('claude.renameSlashCommand has \\r terminator', claude.renameSlashCommand('test') === '/rename test\r')
const execCmd = claude.buildExecCommand('hello', 'haiku')
ok('claude.buildExecCommand command = claude', execCmd.command === 'claude')
ok('claude.buildExecCommand includes -p flag', execCmd.args.includes('-p'))
ok('claude.buildExecCommand includes --model haiku', execCmd.args.includes('--model') && execCmd.args.includes('haiku'))
ok('claude.buildExecCommand stdin = prompt', execCmd.stdin === 'hello')
const permPaths = claude.permissionConfigPaths('/proj', '/home/u')
ok('permissionConfigPaths returns 3 entries', permPaths.length === 3)
ok('permissionConfigPaths first is project local', permPaths[0].includes('settings.local.json'))
ok('claude.ttyPatterns.toolUse matches Read marker', claude.ttyPatterns.toolUse.test('  ⏺ Read(/tmp/foo.ts)'))
ok('claude.ttyPatterns.blocked matches y/n', claude.ttyPatterns.blocked.some((r) => r.test('Proceed? [y/n]')))

console.log('\n[8] resolveAgentForSessionId — synthesizes a Claude session and resolves it')
const synthHome = mkdtempSync(join(tmpdir(), 'agents-smoke-'))
try {
  const projDirName = claude.encodeProjectDir('Q:\\fake-proj')
  const claudeRoot = join(claude.sessionsRoot(synthHome), projDirName)
  mkdirSync(claudeRoot, { recursive: true })
  const realId = '12345678-1234-1234-1234-123456789012'
  writeFileSync(join(claudeRoot, `${realId}.jsonl`), '')

  ok('resolves real Claude session to claude', resolveAgentForSessionId(realId, synthHome) === 'claude')
  ok('returns null for unknown id', resolveAgentForSessionId('00000000-0000-0000-0000-000000000000', synthHome) === null)
} finally {
  rmSync(synthHome, { recursive: true, force: true })
}

console.log('\n[9] getSessionTitle — reads each agent\'s durable rename store')
const titleHome = mkdtempSync(join(tmpdir(), 'agents-title-'))
try {
  const projDirName = claude.encodeProjectDir('Q:\\fake-proj')
  const root = join(claude.sessionsRoot(titleHome), projDirName)
  mkdirSync(root, { recursive: true })
  const sid = '12345678-1234-1234-1234-123456789012'
  const named = join(root, `${sid}.jsonl`)
  writeFileSync(
    named,
    JSON.stringify({ type: 'user', sessionId: sid, message: { content: 'hello' } }) + '\n' +
    JSON.stringify({ type: 'custom-title', customTitle: 'My Named Session', sessionId: sid }) + '\n',
  )
  ok('claude.getSessionTitle returns the custom title', claude.getSessionTitle(named) === 'My Named Session')

  const unnamed = join(root, 'unnamed.jsonl')
  writeFileSync(unnamed, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
  ok('claude.getSessionTitle is null when never renamed', claude.getSessionTitle(unnamed) === null)

  const codexSid = '99999999-1234-1234-1234-123456789012'
  const codexDay = join(titleHome, '.codex', 'sessions', '2026', '07', '14')
  mkdirSync(codexDay, { recursive: true })
  const codexRollout = join(codexDay, `rollout-2026-07-14T17-04-23-${codexSid}.jsonl`)
  writeFileSync(codexRollout, JSON.stringify({ type: 'session_meta', payload: { id: codexSid, cwd: '/project' } }) + '\n')
  writeFileSync(join(titleHome, '.codex', 'session_index.jsonl'), JSON.stringify({ id: codexSid, thread_name: 'Codex Named Session', updated_at: '2026-07-14T15:33:27Z' }) + '\n')
  ok('codex.getSessionTitle returns the latest index name', codex.getSessionTitle(codexRollout) === 'Codex Named Session')
  ok('codex.appendCustomTitle appends a durable index name', codex.appendCustomTitle(codexRollout, codexSid, 'Renamed by Jamat'))
  ok('codex.getSessionTitle sees the appended name', codex.getSessionTitle(codexRollout) === 'Renamed by Jamat')

  const claudeWatch = claude.getSessionTitleWatchTarget(root, sid, titleHome)
  ok('Claude title watch targets its transcript', claudeWatch?.dir === root && claudeWatch.base === `${sid}.jsonl`)
  const codexWatch = codex.getSessionTitleWatchTarget('/project', codexSid, titleHome)
  ok('Codex title watch targets session_index.jsonl', codexWatch?.dir === join(titleHome, '.codex') && codexWatch.base === 'session_index.jsonl')
} finally {
  rmSync(titleHome, { recursive: true, force: true })
}

console.log('\n[10] listActivePids — shape (alive sessions with owning pid)')
const pids = claude.listActivePids(homedir())
ok('claude.listActivePids returns an array', Array.isArray(pids))
ok('claude.listActivePids entries have pid+sessionId', pids.every((p) => typeof p.pid === 'number' && typeof p.sessionId === 'string'))
ok('codex.listActivePids is empty (no live-pid registry)', Array.isArray(codex.listActivePids(homedir())) && codex.listActivePids(homedir()).length === 0)

console.log('\n[11] discovery + rename members routed through the adapter (plan 004 #2)')
ok('codex.buildSessionMetaCache → empty Map for a missing project', codex.buildSessionMetaCache('/nope', ['a']).size === 0)
{
  const cp = codex.loadSessionPreview('/nope', 'x')
  ok('codex.loadSessionPreview → [] for a missing session', Array.isArray(cp) && cp.length === 0)
}
ok('codex.invalidateDiscoveryCache is a no-op (no throw)', (() => { try { codex.invalidateDiscoveryCache(); return true } catch { return false } })())
ok('claude.invalidateDiscoveryCache does not throw', (() => { try { claude.invalidateDiscoveryCache(); return true } catch { return false } })())
{
  const metaHome = mkdtempSync(join(tmpdir(), 'agents-meta-'))
  try {
    ok('claude.buildSessionMetaCache returns a Map (empty folderNames → empty)', claude.buildSessionMetaCache(metaHome, []).size === 0)
    ok('claude.loadSessionPreview → [] for a missing session', claude.loadSessionPreview(metaHome, 'no-such-id').length === 0)
  } finally {
    rmSync(metaHome, { recursive: true, force: true })
  }
}

console.log('\n[12] selected-agent routing guard — each adapter uses its own storage layout')
// Plan 2026-06-01-004 rerouted menu-core discovery through getAgent(selectedAgent). [11] only
// exercised the trivial early-exit branches (empty/missing inputs). This asserts the HAPPY path
// (real JSONL parse) AND that the SAME inputs through the other agent do NOT yield Claude's result
// — so a regression that dropped selectedAgent / hard-coded the Claude path would fail here.
// loadSessionPreview reads `<dir>/<sid>.jsonl` directly (no ~/.claude/projects home resolution), so
// the guard needs no HOME scaffolding; buildSessionMetaCache's findProjectDir path does and is left
// to the heavier createMenuState test the todo deemed disproportionate.
{
  const routeDir = mkdtempSync(join(tmpdir(), 'agents-route-'))
  try {
    const sid = '12345678-1234-1234-1234-123456789012'
    writeFileSync(
      join(routeDir, `${sid}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: sid, message: { content: 'first prompt' } }) + '\n' +
      JSON.stringify({ type: 'user', sessionId: sid, message: { content: 'second prompt' } }) + '\n',
    )
    const cPrev = claude.loadSessionPreview(routeDir, sid)
    ok('claude.loadSessionPreview parses a real session (non-empty, newest-first)',
      cPrev.length === 2 && /second prompt/.test(cPrev[0]))
    ok('codex.loadSessionPreview is [] for the same dir+id (selected agent changes the result)',
      codex.loadSessionPreview(routeDir, sid).length === 0)
  } finally {
    rmSync(routeDir, { recursive: true, force: true })
  }
}

console.log('\n[13] Busy detection — busyWide (deep-scan elapsed subset) catches the spinner status line')
{
  const busy = claude.ttyPatterns.busy
  const wide = claude.ttyPatterns.busyWide
  ok('claude.ttyPatterns.busy is defined', !!busy)
  ok('claude.ttyPatterns.busyWide is defined', !!wide)
  // The classifier tests these against normalizeTty(screen) — normalize the raw samples the same way.
  const matchesWide = (raw: string) => !!wide && wide.test(normalizeTty(raw))
  const matchesBusy = (raw: string) => !!busy && busy.test(normalizeTty(raw))

  // Positive: the elapsed-timer forms that stay present through a whole "thinking" turn.
  ok('busyWide matches "(1h 25m 33s · …)" (elapsedDot)',
    matchesWide('✻ Flowing… (1h 25m 33s · still thinking with xhigh effort)'))
  ok('busyWide matches "…(45s)" (elapsedEllipsis)',
    matchesWide('Compacting conversation… (45s)'))
  ok('busyWide matches a bare "(8s ·" elapsed', matchesWide('✶ Spinning… (8s · thinking)'))

  // Negative: prose parentheticals must NOT read as busy (that's why only the tightly-anchored
  // elapsed markers get the deep scan — spinnerGlyph / esc-to-interrupt stay shallow-window only).
  ok('busyWide rejects prose "(5s) pause"', !matchesWide('the (5s) pause before the retry'))
  ok('busyWide rejects a section ref "(2)"', !matchesWide('see step (2) below for details'))
  ok('busyWide rejects the idle prompt', !matchesWide('> \n  bypass permissions on (shift+tab to cycle)'))

  // Subset invariant: anything busyWide matches, the full busy union also matches (it's built from
  // the same BUSY_SIGNALS_COLLAPSED entries) — so the deep scan can only ADD coverage, never diverge.
  for (const s of ['✻ Flowing… (1h 25m 33s · x)', 'Compacting… (45s)', '✶ Spinning… (8s · thinking)']) {
    ok(`busyWide ⊆ busy for ${JSON.stringify(s)}`, !matchesWide(s) || matchesBusy(s))
  }
}

console.log('\n[14] capabilities — declared flags + main↔renderer parity (U1)')
ok('claude.capabilities.fork = true', claude.capabilities.fork === true)
ok('claude.capabilities.usageSource = claude-web', claude.capabilities.usageSource === 'claude-web')
ok('claude.capabilities.execModels includes opus', claude.capabilities.execModels.some((m) => m.id === 'opus'))
ok('claude.capabilities.docker image = jamat-isolated', claude.capabilities.docker?.image === 'jamat-isolated')
ok('codex.capabilities.fork = true', codex.capabilities.fork === true)
ok('codex.capabilities.liveRename = true', codex.capabilities.liveRename === true)
ok('codex.capabilities.usageSource = openai', codex.capabilities.usageSource === 'openai')
ok('codex.capabilities.docker configDirName = .codex', codex.capabilities.docker?.configDirName === '.codex')
ok('codex.capabilities.execModels empty (filled in U8)', codex.capabilities.execModels.length === 0)
// The main-process adapter and the renderer registry share the SAME capabilities object — both import
// the single const from renderer-meta.ts. So parity is object identity, and the two can't drift.
ok('claude capabilities parity (main === renderer, same object)', getAgent('claude').capabilities === getRendererAgent('claude').capabilities)
ok('codex capabilities parity (main === renderer, same object)', getAgent('codex').capabilities === getRendererAgent('codex').capabilities)
ok('claude prompt newline uses CSI-u Shift+Enter',
  getRendererAgent('claude').promptNewlineSequences.standard === '\x1b[13;2u'
  && getRendererAgent('claude').promptNewlineSequences.win32InputMode === '\x1b[13;2u')
ok('codex standard prompt newline uses Ctrl+J/LF', getRendererAgent('codex').promptNewlineSequences.standard === '\n')
ok('codex Win32 prompt newline uses encoded Ctrl+J key event',
  getRendererAgent('codex').promptNewlineSequences.win32InputMode === '\x1b[74;36;10;1;8;1_')

console.log('\n[15] owner memo — positive hit survives file deletion; a miss is NOT cached (U1)')
const memoHome = mkdtempSync(join(tmpdir(), 'agents-memo-'))
try {
  const projDirName = claude.encodeProjectDir('Q:\\memo-proj')
  const root = join(claude.sessionsRoot(memoHome), projDirName)
  mkdirSync(root, { recursive: true })
  const memoId = '99999999-9999-9999-9999-999999999999'
  // Miss BEFORE the file exists → null, and (crucially) must NOT be cached.
  ok('resolve miss before file exists → null', resolveAgentForSessionId(memoId, memoHome) === null)
  const f = join(root, `${memoId}.jsonl`)
  writeFileSync(f, '')
  ok('resolve after file created → claude (proves the miss was not memoized)', resolveAgentForSessionId(memoId, memoHome) === 'claude')
  rmSync(f, { force: true })
  ok('resolve after file deleted → still claude (proves the positive hit IS memoized)', resolveAgentForSessionId(memoId, memoHome) === 'claude')
} finally {
  rmSync(memoHome, { recursive: true, force: true })
}

console.log('\n[16] remaining graceful-degrade defaults + rename command + parseExecOutput (U1)')
ok('codex.encodeProjectDir → "" (base default)', codex.encodeProjectDir('/whatever') === '')
ok('codex.renameSlashCommand uses native inline /rename', codex.renameSlashCommand('x') === '/rename x\r')
ok('renderer Codex rename slash matches main adapter', getRendererAgent('codex').renameSlashCommand('x') === '/rename x\r')
ok('codex.readEffortLevel → null (base default)', codex.readEffortLevel('/p', '/h') === null)
ok('codex.appendCustomTitle rejects invalid inputs', codex.appendCustomTitle('/f', 'id', 't') === false)
// codex overrides parseExecOutput (NDJSON reduce) — exercised in [4]. Claude inherits the base trim:
ok('claude.parseExecOutput inherits base trim (correct for `claude -p`)', claude.parseExecOutput('  hello \n') === 'hello')

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
