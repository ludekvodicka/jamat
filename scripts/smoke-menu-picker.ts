/**
 * Smoke for the session-picker redesign (U5): per-agent `New <Agent> session`
 * rows + a merged, recency-sorted resume list where each row carries its owner.
 *
 * Points os.homedir() at a temp tree (USERPROFILE/HOME) so the real adapters
 * resolve against a synthesized ~/.codex; only Codex sessions are seeded, so the
 * Claude side contributes its `New Claude session` row but no resume rows.
 *
 * Run: `npx tsx scripts/smoke-menu-picker.ts`
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const HOME = mkdtempSync(join(tmpdir(), 'picker-home-'))
process.env['USERPROFILE'] = HOME
process.env['HOME'] = HOME

// Import AFTER setting the home env so every homedir() lands on HOME.
const { openSessionPicker, getSessionPreview } = await import('../core/menu-core/facade')
const { invalidateCodexIndex } = await import('../core/agents/codex/sessions')
const { buildUnionSessionMetaCache } = await import('../core/menu-core/transitions')
import type { MenuState } from '../core/types'
import type { AgentId } from '../core/types/contracts'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const WORK = join(HOME, 'work')
const FOLDER = 'myproj'
const PROJ = join(WORK, FOLDER)
mkdirSync(PROJ, { recursive: true })

// Two Codex sessions for PROJ, explicit mtimes so recency order is deterministic.
const dayDir = join(HOME, '.codex', 'sessions', '2026', '07', '10')
mkdirSync(dayDir, { recursive: true })
function seedCodex(sid: string, tsPart: string, prompt: string, mtimeSec: number): void {
  const f = join(dayDir, `rollout-2026-07-10T${tsPart}-${sid}.jsonl`)
  writeFileSync(f,
    JSON.stringify({ timestamp: '2026-07-10T11:00:00Z', type: 'session_meta', payload: { session_id: sid, id: sid, timestamp: '2026-07-10T11:00:00Z', cwd: PROJ } }) + '\n' +
    JSON.stringify({ timestamp: '2026-07-10T11:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }) + '\n')
  utimesSync(f, mtimeSec, mtimeSec)
}
seedCodex('019f4bf7-aaaa-7000-8000-000000000001', '10-00-00', 'older codex session', 1_700_000_000)
seedCodex('019f4bf7-bbbb-7000-8000-000000000002', '11-00-00', 'newer codex session', 1_700_000_500)

function makeState(selectedAgent: AgentId, availableAgents: AgentId[]): MenuState {
  return {
    cat: { label: 't', path: WORK, hiddenFolders: new Set(), virtualFolders: [], flattenFolders: new Set() },
    selectedAgent,
    availableAgents,
    spItems: [],
    spSelected: 0,
    spScrollOffset: 0,
    spFolderName: '',
    spPreviewCache: new Map(),
    spProjectDirs: new Map(),
    submenu: null,
  } as unknown as MenuState
}

console.log('\n[1] Picker: per-agent new-session rows (selected first) + merged resume list')
{
  invalidateCodexIndex()
  const s = makeState('codex', ['claude', 'codex'])
  openSessionPicker(s, FOLDER)

  ok('row0 = new-session codex (selected agent first)', s.spItems[0].kind === 'new-session' && (s.spItems[0] as { agent: AgentId }).agent === 'codex')
  ok('row1 = new-session claude', s.spItems[1].kind === 'new-session' && (s.spItems[1] as { agent: AgentId }).agent === 'claude')

  const resumeRows = s.spItems.slice(2)
  ok('two codex resume rows', resumeRows.length === 2, `got ${resumeRows.length}`)
  ok('first resume row = last-session (newest)', resumeRows[0]?.kind === 'last-session')
  ok('resume rows carry agent codex', resumeRows.every((r) => (r as { agent: AgentId }).agent === 'codex'))
  ok('newest first (recency sort)', resumeRows[0]?.kind !== 'new-session' && /newer codex session/.test((resumeRows[0] as { session: { firstUserMessage: string } }).session.firstUserMessage))
  ok('spProjectDirs: codex found, claude null', s.spProjectDirs.get('codex') === PROJ && s.spProjectDirs.get('claude') === null)
}

console.log('\n[2] Selected agent orders the new-session rows')
{
  invalidateCodexIndex()
  const s = makeState('claude', ['claude', 'codex'])
  openSessionPicker(s, FOLDER)
  ok('row0 = new-session claude when claude selected', (s.spItems[0] as { agent: AgentId }).agent === 'claude')
  ok('row1 = new-session codex', (s.spItems[1] as { agent: AgentId }).agent === 'codex')
}

console.log('\n[3] getSessionPreview routes through the row\'s own agent')
{
  invalidateCodexIndex()
  const s = makeState('codex', ['claude', 'codex'])
  openSessionPicker(s, FOLDER)
  s.spSelected = 2 // first resume row
  const preview = getSessionPreview(s)
  ok('preview loaded via item.agent (codex)', preview.some((l) => /codex session/.test(l)), JSON.stringify(preview))
  s.spSelected = 0 // a new-session row
  ok('preview empty on a new-session row', getSessionPreview(s).length === 0)
}

console.log('\n[4] buildUnionSessionMetaCache: folder shows Codex activity')
{
  invalidateCodexIndex()
  const union = buildUnionSessionMetaCache(WORK, [FOLDER], ['claude', 'codex'])
  ok('union has the folder from Codex sessions', union.has(FOLDER))
  ok('lastActivity is a Date', union.get(FOLDER)?.lastActivity instanceof Date)
}

rmSync(HOME, { recursive: true, force: true })
invalidateCodexIndex()
console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
process.exit(failed === 0 ? 0 : 1)
