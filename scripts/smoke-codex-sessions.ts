/**
 * Smoke for Codex discovery + JSONL parsing (U3), exercised against the
 * committed fixtures (core/agents/codex/fixtures/) and a synthesized ~/.codex
 * date tree in a temp home.
 *
 * Run: `npx tsx scripts/smoke-codex-sessions.ts`
 */

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'fs'
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
import { CodexThreadNames } from '../core/agents/codex/threadNames'
import { SessionRuntime } from '../core/agents/codex/sessionRuntime'

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
      JSON.stringify({ timestamp: '2026-07-10T11:00:57Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-10T11:00:58Z', type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-10T12:00:00Z', type: 'event_msg', payload: { type: 'task_started' } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-10T12:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'later prompt from a newer schema' } }) + '\n')
    // A second rollout under a DIFFERENT cwd.
    const sid2 = '019f4bf7-aaaa-7bbb-8ccc-ddddeeeeffff'
    writeFileSync(join(dayDir, `rollout-2026-07-10T15-00-00-${sid2}.jsonl`),
      JSON.stringify({ timestamp: '2026-07-10T13:00:00Z', type: 'session_meta', payload: { session_id: sid2, id: sid2, timestamp: '2026-07-10T13:00:00Z', cwd: otherDir } }) + '\n')
    const titleIndex = join(home, '.codex', 'session_index.jsonl')
    writeFileSync(titleIndex,
      '{not valid json}\n' +
      JSON.stringify({ id: sid, thread_name: 'Old name', updated_at: '2026-07-10T10:00:00Z' }) + '\n' +
      JSON.stringify({ id: sid2, thread_name: 'Other project name', updated_at: '2026-07-10T13:00:00Z' }) + '\n' +
      JSON.stringify({ id: sid, thread_name: 'Renamed session', updated_at: '2026-07-10T14:00:00Z' }))

    invalidateCodexIndex()
    ok('findCodexProjectDir → projDir when it has sessions', findCodexProjectDir(projDir, home) === projDir)
    ok('findCodexProjectDir → null for a dir with no sessions', findCodexProjectDir(join(home, 'work', 'empty'), home) === null)

    const sessions = listCodexSessionsForProject(projDir, home)
    ok('listCodexSessionsForProject → exactly the projDir session', sessions.length === 1 && sessions[0].sessionId === sid, `got ${sessions.length}`)
    ok('legacy title keeps the original prompt across later event records', sessions[0]?.firstUserMessage === 'do the thing')
    ok('session slug uses the latest valid Codex thread-name row', sessions[0]?.slug === 'Renamed session', JSON.stringify(sessions[0]?.slug))
    ok('session marked not-active (Codex has no live pids)', sessions[0]?.active === false)

    ok('findCodexSessionFileById → the file', findCodexSessionFileById(sid, home) === rollout)
    ok('findCodexSessionFileById → null for unknown id', findCodexSessionFileById('00000000-0000-0000-0000-000000000000', home) === null)
    ok('resolveCodexActiveSessionFile(null) → newest for the cwd', resolveCodexActiveSessionFile(projDir, null, home) === rollout)
    ok('loadCodexSessionPreview → the user line', loadCodexSessionPreview(projDir, sid).some((l) => l === 'do the thing'))

    ok('Codex title append accepts the matching rollout', CodexThreadNames.appendForSessionFile(rollout, sid, 'codexUI'))
    const titleLines = readFileSync(titleIndex, 'utf8').split(/\r?\n/).filter(Boolean)
    ok('title append preserves JSONL after an unterminated prior row', titleLines.length === 5 && titleLines.every((line, i) => i === 0 || (() => { try { JSON.parse(line); return true } catch { return false } })()))
    ok('Codex title read sees the appended latest name', CodexThreadNames.getForSessionFile(rollout) === 'codexUI')
    ok('session picker sees an appended rename without rebuilding rollout discovery', listCodexSessionsForProject(projDir, home)[0]?.slug === 'codexUI')
    ok('title append rejects a mismatched session id', !CodexThreadNames.appendForSessionFile(rollout, sid2, 'wrong target'))

    writeFileSync(titleIndex, readFileSync(titleIndex, 'utf8') + JSON.stringify({ id: sid, thread_name: '   ', updated_at: '2026-07-10T15:00:00Z' }) + '\n')
    CodexThreadNames.invalidate()
    ok('latest empty thread name clears the picker slug', listCodexSessionsForProject(projDir, home)[0]?.slug === null)

    // The other cwd's session must NOT leak into projDir's list.
    ok('other cwd session excluded from projDir', !sessions.some((s) => s.sessionId === sid2))
  } finally {
    rmSync(home, { recursive: true, force: true })
    invalidateCodexIndex()
  }
}

console.log('\n[4] Current Codex user prompt normalization')
{
  const home = mkdtempSync(join(tmpdir(), 'codex-prompts-'))
  const projectDir = join(home, 'work', 'current-shape')
  const syntheticOnlyDir = join(home, 'work', 'synthetic-only')
  try {
    const dayDir = join(home, '.codex', 'sessions', '2026', '07', '14')
    mkdirSync(dayDir, { recursive: true })
    const sid = '019f6128-1111-7000-8000-000000000001'
    const turnId = '019f6128-2222-7000-8000-000000000002'
    const agentsEnvelope = '# AGENTS.md instructions for ' + projectDir + '\n\n<INSTRUCTIONS>\nGenerated project rules\n</INSTRUCTIONS>\n<environment_context>\n</environment_context>'
    const responsePrompt = '<image name=[Image #1] path="d:\\Upload\\shot.png"></image>Fix the Codex session titles [Image #1]'
    const cleanPrompt = 'Fix the Codex session titles [Image #1]'
    writeFileSync(join(dayDir, `rollout-2026-07-14T17-04-23-${sid}.jsonl`),
      JSON.stringify({ timestamp: '2026-07-14T15:04:23Z', type: 'session_meta', payload: { session_id: sid, id: sid, cwd: projectDir } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-14T15:04:24Z', type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-14T15:04:25Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: agentsEnvelope }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-14T15:04:26Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: responsePrompt }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-14T15:04:27Z', type: 'event_msg', payload: { type: 'user_message', message: cleanPrompt, local_images: ['d:\\Upload\\shot.png'] } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-14T15:04:28Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will inspect it.' }] } }) + '\n')

    const syntheticSid = '019f6128-3333-7000-8000-000000000003'
    writeFileSync(join(dayDir, `rollout-2026-07-14T17-05-23-${syntheticSid}.jsonl`),
      JSON.stringify({ timestamp: '2026-07-14T15:05:23Z', type: 'session_meta', payload: { session_id: syntheticSid, id: syntheticSid, cwd: syntheticOnlyDir } }) + '\n' +
      JSON.stringify({ timestamp: '2026-07-14T15:05:24Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: agentsEnvelope }] } }) + '\n')

    invalidateCodexIndex()
    const session = listCodexSessionsForProject(projectDir, home)[0]
    ok('current shape title uses clean event_msg/user_message', session?.firstUserMessage === cleanPrompt, JSON.stringify(session?.firstUserMessage))
    const preview = loadCodexSessionPreview(projectDir, sid)
    ok('preview excludes generated AGENTS envelope', !preview.some((line) => line.startsWith('# AGENTS.md instructions')))
    const turns = extractCodexTurns(findCodexSessionFileById(sid, home)!)
    ok('turns exclude generated AGENTS envelope', turns.length === 1 && turns[0].userPromptText === responsePrompt, JSON.stringify(turns.map((turn) => turn.userPromptText)))
    const syntheticOnly = listCodexSessionsForProject(syntheticOnlyDir, home)[0]
    ok('synthetic-only rollout has no firstUserMessage', syntheticOnly?.firstUserMessage === null, JSON.stringify(syntheticOnly?.firstUserMessage))
  } finally {
    rmSync(home, { recursive: true, force: true })
    invalidateCodexIndex()
  }
}

console.log('\n[5] resolveCodexLaunchedSession — newest rollout for cwd since launch (fork / new-session id)')
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

console.log('\n[6] Session runtime — model, effort, context, incremental append, and reset')
{
  const fixtureInfo = SessionRuntime.read(FIXTURE)
  ok('fixture runtime uses the latest token_count', fixtureInfo?.model === 'gpt-5.6-sol' && fixtureInfo.effortLevel === 'max' && fixtureInfo.contextTokens === 103147 && fixtureInfo.contextWindow === 258400, JSON.stringify(fixtureInfo))
  ok('GPT slug gets a conservative human label', fixtureInfo?.modelLabel === 'GPT-5.6 Sol', fixtureInfo?.modelLabel)

  const dir = mkdtempSync(join(tmpdir(), 'codex-runtime-'))
  const file = join(dir, 'runtime.jsonl')
  const row = (type: string, payload: object): string => JSON.stringify({ timestamp: 't', type, payload }) + '\n'
  const turn = (model: string, effort: object): string => row('turn_context', { model, ...effort })
  const token = (totalTokens: number, contextWindow = 258400): string => row('event_msg', {
    type: 'token_count',
    info: { last_token_usage: { total_tokens: totalTokens }, model_context_window: contextWindow },
  })
  try {
    writeFileSync(file, turn('gpt-5.4', { effort: 'high' }) + token(100))
    ok('current effort shape parsed', SessionRuntime.read(file)?.effortLevel === 'high')

    appendFileSync(file, token(200))
    ok('appended token_count updates without changing settings', SessionRuntime.read(file)?.contextTokens === 200)

    appendFileSync(file, turn('gpt-5.6-sol', { effort: 'max' }))
    const beforeNewToken = SessionRuntime.read(file)
    ok('new turn without token_count keeps the prior complete snapshot', beforeNewToken?.model === 'gpt-5.4' && beforeNewToken.contextTokens === 200, JSON.stringify(beforeNewToken))

    const partialToken = token(300)
    appendFileSync(file, partialToken.slice(0, -2))
    ok('partial final JSONL row is ignored', SessionRuntime.read(file)?.model === 'gpt-5.4')
    appendFileSync(file, partialToken.slice(-2))
    const completedNewTurn = SessionRuntime.read(file)
    ok('completed appended row applies the pending model and effort', completedNewTurn?.model === 'gpt-5.6-sol' && completedNewTurn.effortLevel === 'max' && completedNewTurn.contextTokens === 300, JSON.stringify(completedNewTurn))

    appendFileSync(file, '{malformed json]\n' + token(-1) + token(40))
    ok('malformed/negative rows are ignored and a lower post-compact count wins', SessionRuntime.read(file)?.contextTokens === 40)

    appendFileSync(file, turn('gpt-5.1-codex-max', { reasoning_effort: 'xhigh' }) + token(50))
    const legacyEffort = SessionRuntime.read(file)
    ok('legacy reasoning_effort parsed', legacyEffort?.effortLevel === 'xhigh')
    ok('multi-part GPT slug formatted', legacyEffort?.modelLabel === 'GPT-5.1 Codex Max', legacyEffort?.modelLabel)

    appendFileSync(file, turn('gpt-5.2', { collaboration_mode: { settings: { reasoning_effort: 'medium' } } }) + token(60))
    ok('nested collaboration effort parsed', SessionRuntime.read(file)?.effortLevel === 'medium')

    writeFileSync(file, turn('gpt-5.3', {}) + token(7, 400000))
    const afterShrink = SessionRuntime.read(file)
    ok('file shrink resets cached state', afterShrink?.model === 'gpt-5.3' && afterShrink.contextTokens === 7 && afterShrink.contextWindow === 400000, JSON.stringify(afterShrink))

    const incomplete = join(dir, 'incomplete.jsonl')
    writeFileSync(incomplete, row('turn_context', { effort: 'high' }) + token(10))
    ok('missing model never produces a guessed snapshot', SessionRuntime.read(incomplete) === null)

    const wide = join(dir, 'wide.jsonl')
    writeFileSync(wide,
      turn('gpt-5.6-sol', { effort: 'max' })
      + row('event_msg', { type: 'noise', text: 'x'.repeat(600000) })
      + token(77))
    const wideInfo = SessionRuntime.read(wide)
    ok('cold tail falls back once when turn_context is beyond the bounded tail', wideInfo?.model === 'gpt-5.6-sol' && wideInfo.contextTokens === 77, JSON.stringify(wideInfo))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
