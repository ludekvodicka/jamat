/** Display formatters for the usage stats tab (pure, unit-testable). */

/** Token/count formatter with K/M/B suffixes (mirrors generate-stats.ts formatNumber). */
export function fmtNum(n: number): string {
  if (!isFinite(n)) return '0'
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

/** Plain integer with thousands separators (for request/session counts). */
export function fmtInt(n: number): string {
  return Math.round(n || 0).toLocaleString('en-US')
}

/** USD cost. Sub-cent values still show 2 decimals; large values keep 2. */
export function fmtCost(n: number): string {
  return '$' + (n || 0).toFixed(2)
}

/** Duration "2h 30m" / "5m 12s" / "12s" from milliseconds. */
export function fmtDuration(ms: number): string {
  if (!ms || ms < 1000) return '0s'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** Short model label: strip provider, "claude-" prefix, and a trailing 8-digit date
 *  ("anthropic/claude-haiku-4-5-20251001" → "haiku-4-5"). */
export function shortModel(model: string): string {
  return model.replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '') || model
}

/** "Jun 26" from a YYYY-MM-DD date (interpreted as UTC to match the stored date). */
export function fmtDayLabel(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  if (isNaN(d.getTime())) return isoDate
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
