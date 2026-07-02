/**
 * Smoke for the ideas-manager round trip. No Electron — we test the
 * pure file I/O against a temp HOME so the user's real
 * ~/.jamat/ stays untouched.
 *
 * Run: `npx tsx scripts/smoke-ideas-store.ts`
 */

import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// Override HOME + APPDATA so the manager writes into our scratch dir. Must be set BEFORE importing
// the manager (which captures the path at module load via `resolveUserDataDir()` →
// `%APPDATA%\jamat`). APPDATA drives resolveUserDataDir; HOME/USERPROFILE is the fallback.
const fakeHome = mkdtempSync(join(tmpdir(), 'claude-ideas-smoke-'))
process.env['HOME'] = fakeHome
process.env['USERPROFILE'] = fakeHome // Windows
process.env['APPDATA'] = join(fakeHome, 'AppData', 'Roaming')
const STORAGE = join(fakeHome, 'AppData', 'Roaming', 'jamat') // resolveUserDataDir() result

async function run(): Promise<void> {
  const { loadIdeas, saveIdeas } = await import('../app-electron/src/main/ideas-manager')

  console.log('\n[1] Load from nonexistent file returns []')
  const empty = loadIdeas('window-a')
  ok('returns array', Array.isArray(empty))
  ok('empty', empty.length === 0)

  console.log('\n[2] Save → load round trip')
  const sample = [
    {
      id: 'id-1', title: 'Idea one', body: '', category: 'plans',
      importance: 3 as const, dueDate: '', createdAt: '2026-05-28T00:00:00Z',
      updatedAt: '2026-05-28T00:00:00Z',
    },
    {
      id: 'id-2', title: 'Idea two', body: 'details', category: 'plans',
      importance: 5 as const, dueDate: '2026-06-01', createdAt: '2026-05-28T00:01:00Z',
      updatedAt: '2026-05-28T00:01:00Z',
    },
  ]
  const saved = saveIdeas('window-a', sample)
  ok('save ok', saved.ok === true)
  const loaded = loadIdeas('window-a')
  ok('loaded 2 items', loaded.length === 2)
  ok('id-1 preserved', loaded[0].id === 'id-1')
  ok('importance preserved', loaded[1].importance === 5)
  ok('dueDate preserved', loaded[1].dueDate === '2026-06-01')

  console.log('\n[3] Per-window isolation')
  saveIdeas('window-b', [{ ...sample[0], id: 'id-other', title: 'Other window' }])
  const a = loadIdeas('window-a')
  const b = loadIdeas('window-b')
  ok('window-a still 2 items', a.length === 2)
  ok('window-b has 1 item', b.length === 1)
  ok('window-b id', b[0].id === 'id-other')

  console.log('\n[4] Corrupt JSON returns []')
  const { writeFileSync } = await import('fs')
  writeFileSync(join(STORAGE, 'ideas-corrupt.json'), '{ not valid json', 'utf-8')
  const corrupt = loadIdeas('corrupt')
  ok('corrupt → []', corrupt.length === 0)

  console.log('\n[5] Filter out invalid entries on load')
  writeFileSync(
    join(STORAGE, 'ideas-mixed.json'),
    JSON.stringify([
      sample[0],
      { id: 'bad', title: 'no other fields' },  // invalid
      sample[1],
    ]),
    'utf-8',
  )
  const mixed = loadIdeas('mixed')
  ok('two valid entries kept', mixed.length === 2)
  ok('invalid one filtered out', !mixed.some((x) => x.id === 'bad'))

  console.log('\n[6] Empty array save → load returns []')
  saveIdeas('window-a', [])
  const cleared = loadIdeas('window-a')
  ok('cleared', cleared.length === 0)

  console.log('\n[7] windowId sanitization — bad characters rejected to safe slug')
  saveIdeas('../etc/passwd', [{ ...sample[0], id: 'sanitized' }])
  // The file should be under STORAGE_DIR with sanitized chars, not in /etc.
  const exists = existsSync(join(STORAGE, 'ideas-___etc_passwd.json'))
  ok('safe filename used', exists)

  // Cleanup.
  rmSync(fakeHome, { recursive: true, force: true })

  console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'} (${passed} passed, ${failed} failed)`)
  process.exit(failed === 0 ? 0 : 1)
}

run().catch((err) => { console.error('Smoke crashed:', err); process.exit(1) })
