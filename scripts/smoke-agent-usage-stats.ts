import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadDailyUsageData, loadSessionData } from 'ccusage/data-loader'
import { ClaudeUsageLoader } from '../app-stats/claudeUsageLoader'
import { CodexUsageLoader } from '../app-stats/codex-usage-loader'
import { StatsViewBuilder, type NormalizedUsageRecord } from '../app-stats/stats-view'
import { costForTokens, modelRates } from '../core/pricing'

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function tokenRow(timestamp: string, total: object, last?: object): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}) } },
  })
}

function usage(input: number, cached: number, output: number, reasoning: number): object {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output }
}

const root = mkdtempSync(join(tmpdir(), 'jamat-agent-stats-'))
const sessionsRoot = join(root, 'sessions')
const dayDir = join(sessionsRoot, '2026', '07', '14')
const cacheFile = join(root, 'stats', 'codex-cache.json')
mkdirSync(dayDir, { recursive: true })

try {
  const project = join(root, 'work', 'project-one')
  const tuiId = '11111111-1111-1111-1111-111111111111'
  const tuiRows = [
    JSON.stringify({ timestamp: '2026-07-14T10:00:00.000Z', type: 'session_meta', payload: { id: tuiId, cwd: project, originator: 'codex-tui' } }),
    JSON.stringify({ timestamp: '2026-07-14T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    tokenRow('2026-07-14T10:00:02.000Z', usage(100, 40, 20, 5), usage(100, 40, 20, 5)),
    '{ malformed json',
    tokenRow('2026-07-14T10:00:03.000Z', usage(100, 40, 20, 5), usage(100, 40, 20, 5)),
    tokenRow('2026-07-14T10:00:04.000Z', usage(160, 70, 35, 10)),
    tokenRow('2026-07-14T10:00:05.000Z', usage(10, 2, 3, 1), usage(10, 2, 3, 1)),
  ]
  writeFileSync(join(dayDir, `rollout-tui-${tuiId}.jsonl`), tuiRows.join('\n') + '\n')

  const execId = '22222222-2222-2222-2222-222222222222'
  writeFileSync(join(dayDir, `rollout-exec-${execId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-07-14T11:00:00.000Z', type: 'session_meta', payload: { id: execId, cwd: project, originator: 'codex_exec' } }),
    JSON.stringify({ timestamp: '2026-07-14T11:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    tokenRow('2026-07-14T11:00:02.000Z', usage(50, 20, 10, 2), usage(50, 20, 10, 2)),
  ].join('\n') + '\n')

  const sdkId = '33333333-3333-3333-3333-333333333333'
  writeFileSync(join(dayDir, `rollout-sdk-${sdkId}.jsonl`), [
    JSON.stringify({ timestamp: '2026-07-14T11:30:00.000Z', type: 'session_meta', payload: { id: sdkId, cwd: project, originator: 'codex_sdk_ts' } }),
    tokenRow('2026-07-14T11:30:01.000Z', usage(999, 0, 1, 0), usage(999, 0, 1, 0)),
  ].join('\n') + '\n')

  console.log('\n[1] Codex rollout normalization')
  const first = await CodexUsageLoader.load({ sessionsRoot, cacheFile })
  ok('walks all three rollout files', first.filesScanned === 3, String(first.filesScanned))
  ok('fully parses only tui + exec origins', first.filesParsed === 2, String(first.filesParsed))
  ok('ignores sdk origin even when a synthetic token row exists', first.records.length === 4, String(first.records.length))
  ok('deduplicates an unchanged cumulative token event', first.records.filter((record) => record.sessionId === tuiId).length === 3)
  ok('uses the turn-context model', first.records.some((record) => record.model === 'gpt-5.6-sol'))
  ok('attributes records to the rollout cwd basename', first.records.every((record) => record.project === 'project-one'))
  ok('all fixture models have current API pricing', first.costCoverage === 'full')

  console.log('\n[2] Persistent file cache')
  const second = await CodexUsageLoader.load({ sessionsRoot, cacheFile })
  ok('second scan is all cache hits', second.cacheHits === 3 && second.filesParsed === 0, JSON.stringify(second))
  ok('cached records equal the first result', JSON.stringify(second.records) === JSON.stringify(first.records))

  console.log('\n[3] Shared aggregation semantics')
  const codex = StatsViewBuilder.build(first.records, new Date('2026-07-14T12:00:00.000Z'), first.costCoverage, 'none')
  ok('fresh input excludes cached input', codex.totals.inputTokens === 128, String(codex.totals.inputTokens))
  ok('cached input is retained once as cache-read', codex.totals.cacheReadTokens === 92, String(codex.totals.cacheReadTokens))
  ok('output remains inclusive of reasoning', codex.totals.outputTokens === 48, String(codex.totals.outputTokens))
  ok('reasoning is retained as an informational subset', codex.totals.reasoningTokens === 13, String(codex.totals.reasoningTokens))
  ok('reasoning is not double-counted in total', codex.totals.totalTokens === 268, String(codex.totals.totalTokens))
  ok('builds two token-bearing sessions', codex.sessions.length === 2, String(codex.sessions.length))
  ok('detailed output excludes the internal project path', codex.detailed.requests.every((request) => !Object.hasOwn(request, 'projectPath')))
  ok('Codex API-equivalent cost prices each token type once', Math.abs(codex.totals.totalCost - 0.002126) < 1e-12, String(codex.totals.totalCost))

  console.log('\n[4] OpenAI pricing semantics')
  const longCost = costForTokens('gpt-5.6-sol', { input: 200_000, output: 10_000, cacheCreate: 0, cacheRead: 100_000 })
  ok('long-context request applies 2x input and 1.5x output to the full request', longCost !== null && Math.abs(longCost - 2.55) < 1e-12, String(longCost))
  ok('GPT-5.5 exposes official per-million rates', JSON.stringify(modelRates('gpt-5.5')) === JSON.stringify({ input: 5, output: 30, cacheCreate: 6.25, cacheRead: 0.5 }))
  ok('current Opus models use the ccusage five-dollar input rate', JSON.stringify(modelRates('claude-opus-4-8')) === JSON.stringify({ input: 5, output: 25, cacheCreate: 6.25, cacheRead: 0.5 }))
  ok('Sonnet 5 uses its current lower token rates', JSON.stringify(modelRates('claude-sonnet-5')) === JSON.stringify({ input: 2, output: 10, cacheCreate: 2.5, cacheRead: 0.2 }))
  ok('unknown models are not guessed', costForTokens('gpt-5.5-codex', { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 }) === null)
  ok('mixed known and unknown models report partial coverage', CodexUsageLoader.costCoverage([...first.records, { ...first.records[0], model: 'gpt-5.5-codex' }]) === 'partial')
  ok('empty Codex usage reports no cost coverage', CodexUsageLoader.costCoverage([]) === 'none')

  console.log('\n[5] Claude multi-day file cache')
  const claudeRoot = join(root, 'claude')
  const claudeProject = join(claudeRoot, 'projects', 'Q--work-project-one')
  const claudeFileOne = join(claudeProject, 'session-one.jsonl')
  const claudeFileTwo = join(claudeProject, 'session-two.jsonl')
  const claudeCacheFile = join(root, 'stats', 'claude-cache.json')
  mkdirSync(claudeProject, { recursive: true })
  const claudeRow = (timestamp: string, messageId: string, requestId: string, input: number, output: number) => JSON.stringify({
    timestamp,
    requestId,
    message: { id: messageId, model: 'claude-sonnet-4-6', usage: { input_tokens: input, output_tokens: output } },
  })
  writeFileSync(claudeFileOne, `${claudeRow('2026-07-14T10:00:00.000Z', 'message-1', 'request-1', 10, 2)}\n`)
  writeFileSync(claudeFileTwo, [
    claudeRow('2026-07-14T10:01:00.000Z', 'message-1', 'request-1', 999, 999),
    claudeRow('2026-07-14T10:02:00.000Z', 'message-2', 'request-2', 20, 3),
  ].join('\n') + '\n')
  const claudeFirst = await ClaudeUsageLoader.load({ cacheFile: claudeCacheFile, claudePaths: [claudeRoot] })
  ok('Claude cold load parses both files', claudeFirst.filesParsed === 2 && claudeFirst.cacheHits === 0, JSON.stringify(claudeFirst))
  ok('Claude global message/request dedupe suppresses the duplicate', claudeFirst.daily[0].inputTokens === 30 && claudeFirst.daily[0].outputTokens === 5, JSON.stringify(claudeFirst.daily))
  const ccDaily = await loadDailyUsageData({ claudePath: claudeRoot, mode: 'calculate', offline: true, order: 'asc' })
  const ccSessions = await loadSessionData({ claudePath: claudeRoot, mode: 'calculate', offline: true })
  ok('Claude daily token aggregates match ccusage', claudeFirst.daily[0].inputTokens === ccDaily[0].inputTokens && claudeFirst.daily[0].outputTokens === ccDaily[0].outputTokens)
  ok('Claude session token aggregates match ccusage', claudeFirst.sessions[0].inputTokens === ccSessions[0].inputTokens && claudeFirst.sessions[0].outputTokens === ccSessions[0].outputTokens)
  const claudeWarm = await ClaudeUsageLoader.load({ cacheFile: claudeCacheFile, claudePaths: [claudeRoot] })
  ok('Claude warm load remains cached across calendar days', claudeWarm.cacheHits === 2 && claudeWarm.filesParsed === 0)
  writeFileSync(claudeCacheFile, '{ corrupt cache')
  const claudeRebuilt = await ClaudeUsageLoader.load({ cacheFile: claudeCacheFile, claudePaths: [claudeRoot] })
  ok('a corrupt Claude cache rebuilds only Claude data', claudeRebuilt.filesParsed === 2 && claudeRebuilt.daily[0].inputTokens === 30)
  appendFileSync(claudeFileOne, `${claudeRow('2026-07-15T08:00:00.000Z', 'message-3', 'request-3', 30, 4)}\n`)
  const claudeChanged = await ClaudeUsageLoader.load({ cacheFile: claudeCacheFile, claudePaths: [claudeRoot] })
  ok('only the changed Claude file is reparsed', claudeChanged.filesParsed === 1 && claudeChanged.cacheHits === 1, JSON.stringify(claudeChanged))
  ok('a resumed file adds one next-day contribution without double counting', claudeChanged.daily.length === 2 && claudeChanged.daily[1].inputTokens === 30)
  rmSync(claudeFileTwo)
  const claudeDeleted = await ClaudeUsageLoader.load({ cacheFile: claudeCacheFile, claudePaths: [claudeRoot] })
  ok('deleted Claude files are pruned from cached totals', claudeDeleted.filesScanned === 1 && claudeDeleted.daily[0].inputTokens === 10)

  console.log('\n[6] All-agent merge')
  const claudeRecord: NormalizedUsageRecord = {
    agent: 'claude', timestamp: '2026-07-14T11:45:00.000Z', model: 'claude-test',
    inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, cost: 1, durationMs: 1000, project: 'project-one', projectPath: project,
    sessionId: '44444444-4444-4444-4444-444444444444',
  }
  const claude = StatsViewBuilder.build([claudeRecord], new Date('2026-07-14T12:00:00.000Z'), 'full', 'full')
  const all = StatsViewBuilder.merge(claude, codex)
  ok('merged token total is additive', all.totals.totalTokens === 283, String(all.totals.totalTokens))
  ok('merged project row contains both agents', all.projects24h.length === 1 && all.projects24h[0].totalTokens === 283)
  ok('merged sessions retain all three owners', all.sessions.length === 3)
  ok('merged cost is full while duration remains Claude-only', all.costCoverage === 'full' && all.durationCoverage === 'partial')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
