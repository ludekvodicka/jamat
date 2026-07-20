import type { ContextWarnLevel } from '../../../../core/types/config'
import type { SessionModelInfo } from '../../../../core/types/session'

export interface ContextLevelVisual {
  /** Tab indicator glyph (the status bar doesn't use this). */
  glyph: string
  /** Text color — used by BOTH the per-tab indicator and the status-bar "xk / 1M · pct%". */
  color: string
  fontWeight: number
  /** Tab indicator font-size (px). The status bar keeps its own size and ignores this. */
  fontSize: number
}

/**
 * The 4 FIXED context-fullness warning levels — used when the config doesn't override them. The
 * count is always 4; only the values are user-editable (Settings → Context warnings, persisted as
 * `AppConfig.contextLevels`). Defaults reproduce the historical behaviour: 35 % is a SILENT action
 * level (overlay + Compact button only, no passive colour), 45/75/85 % also light the status bar
 * (amber/orange/red).
 */
export const DEFAULT_CONTEXT_LEVELS: ContextWarnLevel[] = [
  { pct: 35, popup: true, statusBar: false },
  { pct: 45, popup: true, statusBar: true },
  { pct: 75, popup: true, statusBar: true },
  { pct: 85, popup: true, statusBar: true },
]

/**
 * Visuals by SEVERITY rank (ascending pct), NOT by config array index — so the lowest threshold
 * always reads as info and the highest as red regardless of the order the values were entered.
 */
const LEVEL_VISUALS: ContextLevelVisual[] = [
  { glyph: '◔', color: '#6a9fb5', fontWeight: 400, fontSize: 9 },  // info   (level 1)
  { glyph: '◑', color: '#e0b000', fontWeight: 400, fontSize: 9 },  // amber  (level 2)
  { glyph: '◕', color: '#ef8a3c', fontWeight: 700, fontSize: 9 },  // orange (level 3)
  { glyph: '●!', color: '#e8554e', fontWeight: 700, fontSize: 10 }, // red    (level 4)
]

export type ResolvedContextLevel = ContextWarnLevel & { visual: ContextLevelVisual }

/**
 * The configured levels (or the defaults when absent/malformed) sorted ascending by pct and paired
 * with their severity-rank visual. Single source the status bar, the per-tab glyph and the overlay
 * all read from, so their thresholds + colours stay identical.
 */
export function resolveContextLevels(levels: ContextWarnLevel[] | null | undefined): ResolvedContextLevel[] {
  const src = levels && levels.length === 4 ? levels : DEFAULT_CONTEXT_LEVELS
  return [...src]
    .sort((a, b) => a.pct - b.pct)
    .map((l, i) => ({ ...l, visual: LEVEL_VISUALS[i] }))
}

/**
 * Passive status-bar / per-tab visual for the current fill — the visual of the HIGHEST crossed
 * level whose `statusBar` is on, or null below the first such level (no highlight). `pct` is the
 * context-window fill, 0–100. `levels` defaults to DEFAULT_CONTEXT_LEVELS.
 */
export function contextLevel(pct: number | null, levels?: ContextWarnLevel[] | null): ContextLevelVisual | null {
  if (pct === null) return null
  let hit: ContextLevelVisual | null = null
  for (const l of resolveContextLevels(levels)) if (l.statusBar && pct > l.pct) hit = l.visual
  return hit
}

/**
 * Lowest configured threshold — the fill above which the status-bar Compact button appears (the
 * first nudge, independent of popup/statusBar). Replaces the old fixed COMPACT_SUGGEST_PCT.
 */
export function compactSuggestPct(levels?: ContextWarnLevel[] | null): number {
  return resolveContextLevels(levels)[0].pct
}

export function contextUsedPercent(info: SessionModelInfo | null): number | null {
  if (!info || !Number.isFinite(info.contextTokens) || info.contextTokens < 0) return null
  if (!Number.isFinite(info.contextWindow) || info.contextWindow <= 0) return null
  return Math.round((info.contextTokens / info.contextWindow) * 100)
}
