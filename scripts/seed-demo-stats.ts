/**
 * Fabricates Claude + Codex transcripts for the Demo sandbox and rebuilds the Usage Stats dashboard
 * data from them — fully isolated from every real profile.
 *
 *   npm run demo:stats            seed fake transcripts + regenerate the demo stats.json
 *
 * How the isolation works:
 *   - Transcripts are written to Q:\Demo\.claude-demo\projects\<encoded>\*.jsonl.
 *   - The stats generator runs with CLAUDE_CONFIG_DIR and CODEX_HOME pointed at isolated demo dirs
 *     AND --config-dir DEMO_CONFIG_DIR (so stats.json is written into the demo profile's
 *     own config-dir, .private/configs/demo/stats — the same place the demo Electron instance reads).
 *   - Nothing here touches a real profile: real ~/.claude is never read, and the real profiles'
 *     stats (in their own config-dirs) are never written. No backup/restore needed.
 *
 * The demo launcher (.private/scripts/start-demo.bat) exports the same two agent homes, so the
 * dashboard's own ↻ Refresh re-runs the generator against the same demo data and stays consistent.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { pathToProjectDirName } from '../core/agents/claude/sessions.js'
import { DEMO_ROOT, DEMO_CLAUDE_DIR, DEMO_CODEX_DIR, DEMO_CONFIG_DIR, DEMO_CATEGORIES, DEMO_MODELS } from './demo-manifest.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO_PROJECTS_DIR = join(DEMO_CLAUDE_DIR, 'projects')
const STATS_DIR = join(DEMO_CONFIG_DIR, 'stats')
const CACHE_FILE = join(STATS_DIR, 'historical-cache.json')
const CODEX_CACHE_FILE = join(STATS_DIR, 'codex-usage-cache.json')
const STATS_JSON = join(STATS_DIR, 'stats.json')
const GENERATOR = join(ROOT, 'app-stats', 'generate-stats.ts')

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// ---- tiny deterministic-ish RNG helpers (plain Math.random is fine for fake data) ----
const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))
const chance = (p: number) => Math.random() < p

function pickModel(): string {
  const r = Math.random()
  let acc = 0
  for (const m of DEMO_MODELS) { acc += m.weight; if (r <= acc) return m.model }
  return DEMO_MODELS[DEMO_MODELS.length - 1].model
}

function tokensFor(model: string) {
  if (model.includes('opus')) {
    return { input: randInt(3_000, 25_000), output: randInt(400, 3_500), cacheCreate: randInt(1_000, 25_000), cacheRead: randInt(8_000, 180_000) }
  }
  if (model.includes('haiku')) {
    return { input: randInt(1_000, 9_000), output: randInt(150, 1_500), cacheCreate: randInt(300, 6_000), cacheRead: randInt(2_000, 60_000) }
  }
  return { input: randInt(2_000, 20_000), output: randInt(300, 3_000), cacheCreate: randInt(800, 18_000), cacheRead: randInt(5_000, 150_000) }
}

let seq = 0
function usageLine(tsMs: number, sessionId: string, cwd: string): string {
  const model = pickModel()
  const t = tokensFor(model)
  seq++
  const line = {
    timestamp: new Date(tsMs).toISOString(),
    sessionId,
    version: '1.0.0',
    cwd,
    requestId: `demo-req-${seq}`,
    message: {
      id: `demo-msg-${seq}`,
      model,
      usage: {
        input_tokens: t.input,
        output_tokens: t.output,
        cache_creation_input_tokens: t.cacheCreate,
        cache_read_input_tokens: t.cacheRead,
      },
    },
  }
  return JSON.stringify(line)
}

interface ProjEntry { cwd: string; encoded: string; dir: string }

function allProjects(): ProjEntry[] {
  const out: ProjEntry[] = []
  for (const cat of DEMO_CATEGORIES) {
    for (const p of cat.projects) {
      const cwd = join(DEMO_ROOT, cat.label, p.name)
      const encoded = pathToProjectDirName(cwd)
      out.push({ cwd, encoded, dir: join(DEMO_PROJECTS_DIR, encoded) })
    }
  }
  return out
}

function seedTranscripts() {
  // Fresh start: drop any prior demo transcripts so reruns don't pile up duplicates.
  rmSync(DEMO_PROJECTS_DIR, { recursive: true, force: true })
  mkdirSync(DEMO_PROJECTS_DIR, { recursive: true })

  const now = Date.now()
  const projects = allProjects()
  for (const p of projects) mkdirSync(p.dir, { recursive: true })

  let files = 0
  let lines = 0
  const append = (dir: string, sessionId: string, rows: string[]) => {
    writeFileSync(join(dir, `${sessionId}.jsonl`), rows.join('\n') + '\n')
    files++; lines += rows.length
  }

  // 1) Historical activity: days 1..20 ago → drives Overview daily chart, heatmap, totals, sessions.
  const DAYS_BACK = 20
  for (let d = 1; d <= DAYS_BACK; d++) {
    for (const p of projects) {
      if (!chance(0.5)) continue // ~half the projects active on a given day
      const sessionsToday = randInt(1, 2)
      for (let s = 0; s < sessionsToday; s++) {
        const sessionId = `demo-${p.encoded.slice(-10)}-d${d}-s${s}`
        const reqs = randInt(3, 9)
        const rows: string[] = []
        for (let r = 0; r < reqs; r++) {
          const hour = randInt(8, 22)
          const min = randInt(0, 59)
          const base = new Date()
          base.setHours(0, 0, 0, 0)
          const tsMs = base.getTime() - d * DAY_MS + hour * HOUR_MS + min * 60_000
          rows.push(usageLine(tsMs, sessionId, p.cwd))
        }
        append(p.dir, sessionId, rows)
      }
    }
  }

  // 2) Recent activity within the last 24h → drives the 24h tab and the today slice of Overview.
  //    Distributed so the 5h and 1h Detailed tabs are also populated.
  const recentBuckets: { count: number; maxAgoMs: number }[] = [
    { count: 10, maxAgoMs: 1 * HOUR_MS },   // last hour  → 1h tab
    { count: 22, maxAgoMs: 5 * HOUR_MS },   // last 5h    → 5h tab
    { count: 55, maxAgoMs: 24 * HOUR_MS },  // last 24h   → 24h tab
  ]
  // One open session per project for "today" so the 24h per-project table is rich.
  const todaySessions = new Map<string, string>()
  for (const p of projects) todaySessions.set(p.encoded, `demo-${p.encoded.slice(-10)}-today`)

  const todayRows = new Map<string, string[]>()
  for (const b of recentBuckets) {
    for (let i = 0; i < b.count; i++) {
      const p = projects[randInt(0, projects.length - 1)]
      const tsMs = now - randInt(60_000, b.maxAgoMs) // at least 1 min in the past
      const sessionId = todaySessions.get(p.encoded)!
      const key = `${p.dir}::${sessionId}`
      if (!todayRows.has(key)) todayRows.set(key, [])
      todayRows.get(key)!.push(usageLine(tsMs, sessionId, p.cwd))
    }
  }
  for (const [key, rows] of todayRows) {
    const [dir, sessionId] = key.split('::')
    // sort rows by timestamp for realism
    rows.sort()
    append(dir, sessionId, rows)
  }

  return { files, lines, projects: projects.length }
}

function seedCodexRollouts() {
  const sessionsRoot = join(DEMO_CODEX_DIR, 'sessions')
  rmSync(sessionsRoot, { recursive: true, force: true })
  const projects = allProjects().filter((_project, index) => index % 2 === 0)
  const models = ['gpt-5.6-sol', 'gpt-5.5']
  const now = Date.now()
  let files = 0
  let requests = 0

  projects.forEach((project, index) => {
    const started = now - randInt(10 * 60_000, 3 * DAY_MS)
    const date = new Date(started)
    const dayDir = join(sessionsRoot, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'))
    const sessionId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    const model = models[index % models.length]
    const rows = [
      JSON.stringify({ timestamp: new Date(started).toISOString(), type: 'session_meta', payload: { id: sessionId, cwd: project.cwd, originator: index % 3 === 0 ? 'codex_exec' : 'codex-tui' } }),
      JSON.stringify({ timestamp: new Date(started + 1000).toISOString(), type: 'turn_context', payload: { model } }),
    ]
    let input = 0
    let cached = 0
    let output = 0
    let reasoning = 0
    const count = randInt(4, 10)
    for (let request = 0; request < count; request++) {
      const fresh = randInt(2_000, 14_000)
      const cache = randInt(4_000, 90_000)
      const out = randInt(300, 2_500)
      const reason = randInt(50, Math.max(50, Math.floor(out * 0.6)))
      input += fresh + cache
      cached += cache
      output += out
      reasoning += reason
      const last = { input_tokens: fresh + cache, cached_input_tokens: cache, output_tokens: out, reasoning_output_tokens: reason, total_tokens: fresh + cache + out }
      const total = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output }
      rows.push(JSON.stringify({ timestamp: new Date(started + (request + 2) * 60_000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } }))
      requests++
    }
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(join(dayDir, `rollout-demo-${sessionId}.jsonl`), rows.join('\n') + '\n')
    files++
  })
  return { files, requests }
}

function runGenerator(): number {
  // Spawn the real generator so stats.json keeps the exact shape the dashboard expects.
  // Agent homes point both loaders at demo transcripts; --config-dir → stats.json lands in
  // the demo profile's own config-dir (the same place the demo Electron instance reads it).
  const env = { ...process.env, CLAUDE_CONFIG_DIR: DEMO_CLAUDE_DIR, CODEX_HOME: DEMO_CODEX_DIR }
  // Drop the same-day historical cache so the generator does a fresh scan of the demo data
  // instead of reusing whatever was cached earlier today.
  if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE, { force: true })
  if (existsSync(CODEX_CACHE_FILE)) rmSync(CODEX_CACHE_FILE, { force: true })

  const res = spawnSync(process.execPath, ['--import', 'tsx', GENERATOR, '--config-dir', DEMO_CONFIG_DIR], {
    cwd: ROOT, env, stdio: 'inherit',
  })
  return res.status ?? 1
}

function main() {
  console.log('Seeding demo transcripts into', DEMO_PROJECTS_DIR)
  const { files, lines, projects } = seedTranscripts()
  const codex = seedCodexRollouts()
  console.log(`  Claude: ${lines} usage records across ${files} sessions / ${projects} projects.`)
  console.log(`  Codex: ${codex.requests} usage records across ${codex.files} sessions.`)
  console.log('Regenerating stats.json for the demo profile (isolated config-dir + agent homes)...\n')
  const code = runGenerator()
  if (code === 0) {
    console.log(`\n✓ Demo dashboard data → ${STATS_JSON}`)
    console.log('  Launch the demo profile (.private\\scripts\\start-demo.bat) to see it.')
  } else {
    console.log(`\n✗ Generator exited ${code}. stats.json may be unchanged.`)
  }
  process.exit(code)
}

main()
