import { CodexRateLimits } from '../core/agents/codex/rateLimits'

let passed = 0
let failed = 0

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

function windowOf(response: unknown, durationMinutes: number) {
  return CodexRateLimits.windowsFromResponse(response).find((window) => window.durationMinutes === durationMinutes)
}

console.log('\n[1] Standard 5h + weekly response')
{
  const response = {
    rateLimits: {
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_783_699_297 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1_784_286_097 },
    },
  }
  const session = windowOf(response, 300)
  const weekly = windowOf(response, 10080)
  ok('300 minutes maps as an available window', session?.usedPercent === 12)
  ok('10080 minutes maps as an available window', weekly?.usedPercent === 3)
  ok('Unix reset seconds normalize to ISO', session?.resetsAt === '2026-07-10T16:01:37.000Z', session?.resetsAt ?? 'missing')
}

console.log('\n[2] Weekly-only response in primary')
{
  const response = {
    rateLimits: {
      primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1_784_561_412 },
      secondary: null,
    },
  }
  const windows = CodexRateLimits.windowsFromResponse(response)
  ok('weekly-only response keeps one window', windows.length === 1, JSON.stringify(windows))
  ok('weekly window is retained from primary', windows[0]?.durationMinutes === 10080 && windows[0]?.usedPercent === 8)
  ok('missing 300-minute window is not invented', !windows.some((window) => window.durationMinutes === 300))
}

console.log('\n[3] Semantic role follows duration, not primary/secondary')
{
  const response = {
    rateLimits: {
      primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: null },
      secondary: { usedPercent: 41, windowDurationMins: 300, resetsAt: null },
    },
  }
  ok('300-minute secondary remains the session window', windowOf(response, 300)?.usedPercent === 41)
  ok('10080-minute primary remains the weekly window', windowOf(response, 10080)?.usedPercent === 9)
}

console.log('\n[4] Exact codex bucket wins over model-specific and compatibility buckets')
{
  const response = {
    rateLimits: { primary: { usedPercent: 77, windowDurationMins: 300, resetsAt: null } },
    rateLimitsByLimitId: {
      codex_bengalfox: { primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: null } },
      codex: { primary: { usedPercent: 6, windowDurationMins: 10080, resetsAt: null } },
    },
  }
  const windows = CodexRateLimits.windowsFromResponse(response)
  ok('only exact codex bucket is mapped', windows.length === 1 && windows[0]?.usedPercent === 6, JSON.stringify(windows))
}

console.log('\n[5] Malformed values are skipped; percentages are display-safe')
{
  ok('non-object response maps to no windows', CodexRateLimits.windowsFromResponse('bad').length === 0)
  ok('missing snapshot maps to no windows', CodexRateLimits.windowsFromResponse({}).length === 0)
  const response = {
    rateLimits: {
      primary: { usedPercent: 150, windowDurationMins: 300, resetsAt: 'not-a-number' },
      secondary: { usedPercent: '3', windowDurationMins: 10080, resetsAt: null },
    },
  }
  const windows = CodexRateLimits.windowsFromResponse(response)
  ok('valid numeric window is clamped and retained', windows.length === 1 && windows[0]?.usedPercent === 100)
  ok('invalid reset value becomes null', windows[0]?.resetsAt === null)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
