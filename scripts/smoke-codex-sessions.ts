/**
 * Smoke for Codex discovery + JSONL parsing (U3), exercised against the
 * committed fixtures (core/agents/codex/fixtures/) and a synthesized ~/.codex
 * date tree in a temp home.
 *
 * Run: `npx tsx scripts/smoke-codex-sessions.ts`
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  findCodexProjectDir,
  listCodexSessionsForProject,
  findCodexSessionFileById,
  resolveCodexActiveSessionFile,
  resolveCodexLaunchedSession,
  loadCodexSessionPreview,
  invalidateCodexIndex,
} from '../core/agents/codex/sessions'
import { extractCodexEditedFiles, extractCodexHasEdits, extractCodexTurns } from '../core/agents/codex/session-changes'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const FIXTURE = join(process.cwd(), 'core/agents/codex/fixtures/rollout-sample.jsonl')

console.log('\n[1] Parsing the committed rollout fixture')
{
  const files = extractCodexEditedFiles(FIXTURE)
  ok('extractCodexEditedFiles → the one patched file', files.length === 1 && files[0] === '/work/demo-project/hello.txt', JSON.stringify(files))
  ok('extractCodexHasEdits → true', extractCodexHasEdits(FIXTURE) === true)

  const turns = extractCodexTurns(FIXTURE)
  ok('extractCodexTurns → exactly one user turn', turns.length === 1, `got ${turns.length}`)
  ok('turn userPromptText is the user message', /Create a file named hello\.txt/.test(turns[0]?.userPromptText ?? ''))
  ok('turn has the edited file', turns[0]?.files.length === 1 && turns[0].files[0].filePath === '/work/demo-project/hello.txt')
  ok('edited file marked isNewFile (apply_patch Add File → kind add)', turns[0]?.files[0]?.isNewFile === true)
  ok('turn timestampISO populated', typeof turns[0]?.timestampISO === 'string')
}

console.log('\n[2] Tolerant of corrupt lines + files without edits')
{
  const dir = mkdtempSync(join(tmpdir(), 'codex-parse-'))
  try {
    // Fixture content + a garbage line spliced in the middle → must not throw, still finds the edit.
    const good = readFileSync(FIXTURE, 'utf-8').trimEnd().split('\n')
    good.splice(3, 0, '{ this is not valid json ]')
    const corrupt = join(dir, 'corrupt.jsonl')
    writeFileSync(corrupt, good.join('\n') + '\n')
    ok('corrupt line skipped, edit still found', extractCodexEditedFiles(corrupt).length === 1)

    const noEdits = join(dir, 'noedits.jsonl')
    writeFileSync(noEdits, JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }) + '\n')
    ok('a session with no patches → [] edited files', extractCodexEditedFiles(noEdits).length === 0)
    ok('a session with no patches → hasEdits false', extractCodexHasEdits(noEdits) === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n[3] Discovery over a synthesized ~/.codex date tree')
{
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  const projDir = join(home, 'work', 'myproj')
  const otherDir = join(home, 'work', 'other')
  try {
    const sid = '019f4bf7-b5d8-74b0-9175-a5a5938a4082'
    const dayDir = join(home, '.codex', 'sessions', '2026', '07', '10')
    mkdirSync(dayDir, { recursive: true })
    // A rollout whose header cwd is projDir.
    const rollout = join(dayDir, `rollout-2026-07-10T14-19-12-${sid}.jsonl`)
    writeFileSync(rollout,
      JSON.stringify({ timestamp: '2026-07-10T11:00:56.797Z', type: 'session_meta', payload: { session_id: sid, id: sid, timestamp: '2026-07-10T11:00:56.797Z', cwd: projDir } }) + '\n' +
      // Codex injects an <environment_context> user message first — must be skipped as the label.
      JSON.stringify({ timestamp: '2026-07-10T11:00:56.9Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>' + projDir + '</cwd>\n</environment_context>' }] } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-10T11:00:57Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } }) + '\n')
    // A second rollout under a DIFFERENT cwd.
    const sid2 = '019f4bf7-aaaa-7bbb-8ccc-ddddeeeeffff'
    writeFileSync(join(dayDir, `rollout-2026-07-10T15-00-00-${sid2}.jsonl`),
      JSON.stringify({ timestamp: '2026-07-10T13:00:00Z', type: 'session_meta', payload: { session_id: sid2, id: sid2, timestamp: '2026-07-10T13:00:00Z', cwd: otherDir } }) + '\n')

    invalidateCodexIndex()
    ok('findCodexProjectDir → projDir when it has sessions', findCodexProjectDir(projDir, home) === projDir)
    ok('findCodexProjectDir → null for a dir with no sessions', findCodexProjectDir(join(home, 'work', 'empty'), home) === null)

    const sessions = listCodexSessionsForProject(projDir, home)
    ok('listCodexSessionsForProject → exactly the projDir session', sessions.length === 1 && sessions[0].sessionId === sid, `got ${sessions.length}`)
    ok('session firstUserMessage skips <environment_context>, returns the real prompt', sessions[0]?.firstUserMessage === 'do the thing')
    ok('session marked not-active (Codex has no live pids)', sessions[0]?.active === false)

    ok('findCodexSessionFileById → the file', findCodexSessionFileById(sid, home) === rollout)
    ok('findCodexSessionFileById → null for unknown id', findCodexSessionFileById('00000000-0000-0000-0000-000000000000', home) === null)
    ok('resolveCodexActiveSessionFile(null) → newest for the cwd', resolveCodexActiveSessionFile(projDir, null, home) === rollout)
    ok('loadCodexSessionPreview → the user line', loadCodexSessionPreview(projDir, sid).some((l) => l === 'do the thing'))

    // The other cwd's session must NOT leak into projDir's list.
    ok('other cwd session excluded from projDir', !sessions.some((s) => s.sessionId === sid2))
  } finally {
    rmSync(home, { recursive: true, force: true })
    invalidateCodexIndex()
  }
}

console.log('\n[4] resolveCodexLaunchedSession — newest rollout for cwd since launch (fork / new-session id)')
{
  const home = mkdtempSync(join(tmpdir(), 'codex-launch-'))
  const projDir = join(home, 'work', 'myproj')
  const otherDir = join(home, 'work', 'other')
  try {
    const dayDir = join(home, '.codex', 'sessions', '2026', '07', '10')
    mkdirSync(dayDir, { recursive: true })
    const LAUNCH = 1_800_000_000_000 // fixed epoch ms so the test is deterministic
    const seed = (sid: string, tsPart: string, cwd: string, mtimeMs: number): void => {
      const f = join(dayDir, `rollout-2026-07-10T${tsPart}-${sid}.jsonl`)
      writeFileSync(f, JSON.stringify({ timestamp: 't', type: 'session_meta', payload: { session_id: sid, id: sid, timestamp: 't', cwd } }) + '\n')
      utimesSync(f, mtimeMs / 1000, mtimeMs / 1000)
    }
    const sidNew = '019f4bf7-1111-7000-8000-000000000001'   // the fork / new session: touched AFTER launch
    const sidOld = '019f4bf7-2222-7000-8000-000000000002'   // an older session for the same cwd
    const sidOther = '019f4bf7-3333-7000-8000-000000000003' // newest overall, but a DIFFERENT cwd
    seed(sidNew, '14-00-05', projDir, LAUNCH + 5000)
    seed(sidOld, '10-00-00', projDir, LAUNCH - 100_000)
    seed(sidOther, '14-00-08', otherDir, LAUNCH + 8000)

    ok('resolves the new-since-launch session for the cwd', resolveCodexLaunchedSession(projDir, home, LAUNCH)?.sessionId === sidNew)
    ok('ignores the stale (pre-launch) session for the cwd', resolveCodexLaunchedSession(projDir, home, LAUNCH)?.sessionId !== sidOld)
    ok('resolves a different cwd to ITS own session', resolveCodexLaunchedSession(otherDir, home, LAUNCH)?.sessionId === sidOther)
    ok('null for a cwd with no matching rollout', resolveCodexLaunchedSession(join(home, 'work', 'nope'), home, LAUNCH) === null)
    ok('null when nothing is newer than sinceMs', resolveCodexLaunchedSession(projDir, home, LAUNCH + 50_000) === null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
