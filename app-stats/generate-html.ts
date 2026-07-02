import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { resolveConfigDir } from '../core/config-dir.js';
import { modelRates } from '../core/pricing.js';

// Stats live under the portable config-dir (--config-dir / JAMAT_CONFIG_DIR; default ~/.jamat).
const cdIdx = process.argv.indexOf('--config-dir');
const STATS_DIR = join(resolveConfigDir({ explicit: cdIdx !== -1 ? process.argv[cdIdx + 1] : (process.env['JAMAT_CONFIG_DIR'] ?? null) }), 'stats');
const DATA_DIR = STATS_DIR;
const OUTPUT_DIR = STATS_DIR;

interface ModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

interface SessionUsage {
  sessionId: string;
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  lastActivity: string;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

interface HourlyUsage {
  hour: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  durationMs: number;
  modelsUsed: string[];
}

interface Hourly24hProjectBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  durationMs: number;
}

interface Hourly24hEntry {
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  durationMs: number;
  modelsUsed: string[];
  projects: string[];
  byProject: Record<string, Hourly24hProjectBreakdown>;
  byModel: Record<string, Hourly24hProjectBreakdown>;
}

interface ModelSummary24h {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  requestCount: number;
  sessionCount: number;
}

interface DetailedRequest {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  project: string;
  sessionId: string;
}

interface ProjectSummary {
  project: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  requestCount: number;
  sessionCount: number;
  modelsUsed: string[];
}

interface DetailedData {
  windowStart: string;
  windowEnd: string;
  requests: DetailedRequest[];
  projects: ProjectSummary[];
}

// One cell of the 24h project × model cross-breakdown (a project's usage of a single model).
interface ProjectModelCell {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  requestCount: number;
  sessionCount: number;
}

interface Stats {
  generatedAt: string;
  daily: DailyUsage[];
  sessions: SessionUsage[];
  hourly: HourlyUsage[];
  hourly24h: Hourly24hEntry[];
  projects24h: ProjectSummary[];
  models24h: ModelSummary24h[];
  projectModels24h: Record<string, Record<string, ProjectModelCell>>;
  detailed: DetailedData;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    totalTokens: number;
  };
}

function formatTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  const secs = ms / 1000;
  if (secs < 60) return secs.toFixed(1) + 's';
  const mins = secs / 60;
  if (mins < 60) return mins.toFixed(1) + 'm';
  const hours = mins / 60;
  return hours.toFixed(1) + 'h';
}

function getTotalTokensForDay(d: DailyUsage): number {
  return d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
}

function computeDashboardData(stats: Stats) {
  const daily = stats.daily; // sorted asc
  const today = daily.length > 0 ? daily[daily.length - 1] : null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayData = today && today.date === todayStr ? today : null;

  // All-time
  const allTimeTokens = stats.totals.totalTokens;
  const allTimeCost = stats.totals.totalCost;
  const totalRequests = stats.sessions.length;

  // Today
  const todayTokens = todayData ? getTotalTokensForDay(todayData) : 0;

  // 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysStr = thirtyDaysAgo.toISOString().slice(0, 10);
  const last30 = daily.filter(d => d.date >= thirtyDaysStr);
  const last30Tokens = last30.reduce((s, d) => s + getTotalTokensForDay(d), 0);

  // Peak day
  let peakDay = daily[0];
  let peakDayTokens = 0;
  for (const d of daily) {
    const t = getTotalTokensForDay(d);
    if (t > peakDayTokens) {
      peakDayTokens = t;
      peakDay = d;
    }
  }

  // Active days
  const activeDays = daily.filter(d => getTotalTokensForDay(d) > 0).length;
  const totalDaySpan = daily.length > 0
    ? Math.ceil((new Date(daily[daily.length - 1].date).getTime() - new Date(daily[0].date).getTime()) / 86400000) + 1
    : 0;

  // Current streak
  let streak = 0;
  const daySet = new Set(daily.map(d => d.date));
  const cur = new Date();
  for (let i = 0; i < 365; i++) {
    const ds = cur.toISOString().slice(0, 10);
    if (daySet.has(ds)) {
      streak++;
      cur.setDate(cur.getDate() - 1);
    } else {
      break;
    }
  }

  // Peak hour (aggregate tokens by day-of-week + hour from session data is not available,
  // so we'll use daily data to find peak day-of-week)
  const dayOfWeekTokens: Record<string, number> = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const d of daily) {
    const dow = dayNames[new Date(d.date + 'T00:00:00').getDay()];
    dayOfWeekTokens[dow] = (dayOfWeekTokens[dow] || 0) + getTotalTokensForDay(d);
  }
  let peakDow = 'Mon';
  let peakDowTokens = 0;
  for (const [dow, t] of Object.entries(dayOfWeekTokens)) {
    if (t > peakDowTokens) {
      peakDow = dow;
      peakDowTokens = t;
    }
  }

  // Model aggregation — per-model token split (input / output / cache write+read) + cost,
  // so the Model Breakdown table can show each component, not just the cache-inflated total.
  const modelAgg: Record<string, { input: number; output: number; cacheCreate: number; cacheRead: number; cost: number; total: number }> = {};
  for (const d of daily) {
    for (const mb of d.modelBreakdowns) {
      const name = mb.modelName;
      const a = modelAgg[name] || (modelAgg[name] = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, total: 0 });
      a.input += mb.inputTokens;
      a.output += mb.outputTokens;
      a.cacheCreate += mb.cacheCreationTokens;
      a.cacheRead += mb.cacheReadTokens;
      a.cost += mb.cost;
      a.total += mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens;
    }
  }
  const modelsSorted = Object.entries(modelAgg).sort((a, b) => b[1].total - a[1].total);

  // Heatmap data: last 6 months of daily tokens
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const heatmapStart = sixMonthsAgo.toISOString().slice(0, 10);
  const heatmapData = daily.filter(d => d.date >= heatmapStart);

  return {
    allTimeTokens,
    allTimeCost,
    totalRequests,
    todayTokens,
    last30Tokens,
    peakDay,
    peakDayTokens,
    activeDays,
    totalDaySpan,
    streak,
    peakDow,
    peakDowTokens,
    modelsSorted,
    daily,
    heatmapData,
  };
}

function generateHTML(stats: Stats): string {
  const d = computeDashboardData(stats);

  // Prepare chart data
  const chartLabels = JSON.stringify(d.daily.map(x => x.date));
  const chartTokens = JSON.stringify(d.daily.map(x => getTotalTokensForDay(x)));
  const chartInput = JSON.stringify(d.daily.map(x => x.inputTokens));
  const chartOutput = JSON.stringify(d.daily.map(x => x.outputTokens));
  const chartCost = JSON.stringify(d.daily.map(x => x.totalCost));

  // Per-model daily series for stacked chart
  const allModels = new Set<string>();
  for (const day of d.daily) {
    for (const mb of day.modelBreakdowns) allModels.add(mb.modelName);
  }
  const modelColors: Record<string, string> = {};
  const palette = [
    '#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8',
    '#4db6ac', '#ff8a65', '#aed581', '#f06292', '#7986cb',
    '#ffd54f', '#a1887f', '#90a4ae',
  ];
  let ci = 0;
  for (const m of allModels) {
    modelColors[m] = palette[ci++ % palette.length];
  }

  const modelSeries = Array.from(allModels).map(model => ({
    label: model,
    color: modelColors[model],
    data: d.daily.map(day => {
      const mb = day.modelBreakdowns.find(b => b.modelName === model);
      if (!mb) return 0;
      return mb.inputTokens + mb.outputTokens + mb.cacheCreationTokens + mb.cacheReadTokens;
    }),
  }));

  // Heatmap: build week-by-week grid
  const heatmapMap: Record<string, number> = {};
  let heatmapMax = 0;
  for (const hd of d.heatmapData) {
    const t = getTotalTokensForDay(hd);
    heatmapMap[hd.date] = t;
    if (t > heatmapMax) heatmapMax = t;
  }

  // Build daily duration map from hourly24h data
  const dailyDurationMap: Record<string, number> = {};
  for (const h of stats.hourly24h) {
    const date = h.label.slice(0, 10);
    dailyDurationMap[date] = (dailyDurationMap[date] || 0) + (h.durationMs || 0);
  }
  const todayDurationMs = dailyDurationMap[new Date().toISOString().slice(0, 10)] || 0;

  // Distinct models seen in the 5h window (drives the per-model filter dropdowns)
  const detailedModels = Array.from(new Set(stats.detailed.requests.map(r => r.model)))
    .sort()
    .map(m => ({ id: m, label: m.replace('anthropic/', '') }));

  // Per-token-type pricing for every model referenced anywhere, so the shared model-chip
  // widget can show rates next to each chip. Values are USD per million tokens.
  const allModelNames = new Set<string>();
  for (const day of stats.daily) for (const mb of day.modelBreakdowns) allModelNames.add(mb.modelName);
  for (const r of stats.detailed.requests) allModelNames.add(r.model);
  for (const h of stats.hourly24h) for (const m of h.modelsUsed) allModelNames.add(m);
  const modelPricing: Record<string, { input: number; output: number; cacheCreate: number; cacheRead: number } | null> = {};
  for (const name of allModelNames) modelPricing[name] = modelRates(name);

  const fmtRateS = (v: number) => v >= 1 ? '$' + (Number.isInteger(v) ? v : v.toFixed(2)) : '$' + v.toFixed(2);
  // Server-side hover tooltip (mirrors the client modelChip widget) for the overview table.
  const priceTitle = (model: string): string => {
    const p = modelPricing[model];
    if (!p) return 'Pricing per 1M tokens unavailable for this model';
    return ['Price — USD per 1M tokens',
      `Input:       ${fmtRateS(p.input)}`,
      `Output:      ${fmtRateS(p.output)}`,
      `Cache write: ${fmtRateS(p.cacheCreate)}`,
      `Cache read:  ${fmtRateS(p.cacheRead)}`].join('&#10;');
  };

  // Peak day formatted
  const peakDate = d.peakDay ? new Date(d.peakDay.date + 'T00:00:00') : new Date();
  const peakMonth = peakDate.toLocaleString('en-US', { month: 'short' });
  const peakDayNum = peakDate.getDate();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code Usage Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --bg: #0f1923;
    --bg2: #162230;
    --bg3: #1e3044;
    --card: #1a2a3a;
    --card-border: #2a3e52;
    --text: #e0e8f0;
    --text-dim: #8899aa;
    --text-bright: #ffffff;
    --accent: #4fc3f7;
    --accent2: #81c784;
    --warm: #ffb74d;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 24px;
  }
  .dashboard {
    max-width: 1400px;
    margin: 0 auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  .full-width { grid-column: 1 / -1; }

  /* Main content row: chart left, right panel right */
  .main-row {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 24px;
    align-items: start;
  }

  /* Top stats row */
  .stats-row {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 2fr 1fr 1fr 1fr 1fr;
    gap: 16px;
  }
  .stat-card {
    background: var(--bg2);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 20px 24px;
  }
  .stat-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .stat-value {
    font-size: 48px;
    font-weight: 800;
    color: var(--text-bright);
    line-height: 1;
  }
  .stat-value.medium { font-size: 32px; }
  .stat-sub {
    font-size: 13px;
    color: var(--text-dim);
    margin-top: 8px;
    line-height: 1.4;
  }
  .stat-card.primary {
    background: linear-gradient(135deg, var(--bg2) 0%, var(--bg3) 100%);
  }

  /* Chart section */
  .chart-section {
    background: var(--bg2);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 24px;
  }
  .chart-section h2 {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  .chart-section h3 {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-bright);
    margin-bottom: 16px;
  }
  .chart-info {
    font-size: 13px;
    color: var(--text-dim);
    margin-bottom: 16px;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    justify-content: center;
  }
  .tab {
    padding: 8px 20px;
    border-radius: 20px;
    border: 1px solid var(--card-border);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 14px;
    transition: all 0.2s;
  }
  .tab:hover { background: var(--bg3); color: var(--text); }
  .tab.active {
    background: var(--bg3);
    color: var(--text-bright);
    border-color: var(--accent);
  }

  /* Filter pills */
  .filters {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    justify-content: center;
  }
  .filter-pill {
    padding: 6px 16px;
    border-radius: 16px;
    border: 1px solid var(--card-border);
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 13px;
    transition: all 0.2s;
  }
  .filter-pill:hover { background: var(--bg3); }
  .filter-pill.active {
    background: var(--bg3);
    color: var(--text-bright);
    border-color: var(--accent);
  }

  .chart-container {
    position: relative;
    height: 300px;
  }

  /* Right panel */
  .right-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .heatmap-section {
    background: var(--bg2);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 24px;
  }
  .heatmap-section h2 {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  .heatmap-section h3 {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-bright);
    margin-bottom: 4px;
  }
  .heatmap-info {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 12px;
  }

  .heatmap-grid {
    display: flex;
    gap: 3px;
    overflow-x: auto;
  }
  .heatmap-col {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .heatmap-cell {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: var(--bg);
  }
  .heatmap-labels {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    padding: 0 4px;
  }
  .heatmap-labels span {
    font-size: 11px;
    color: var(--text-dim);
  }
  .heatmap-day-labels {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-right: 6px;
    justify-content: flex-start;
  }
  .heatmap-day-labels span {
    font-size: 10px;
    color: var(--text-dim);
    height: 14px;
    line-height: 14px;
  }
  .heatmap-wrapper {
    display: flex;
  }
  .heatmap-legend {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .legend-cell {
    width: 12px;
    height: 12px;
    border-radius: 2px;
  }

  /* Insight cards */
  .insights-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .insight-card {
    background: var(--bg2);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 20px;
  }
  .insight-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .insight-value {
    font-size: 28px;
    font-weight: 800;
    color: var(--text-bright);
    line-height: 1.1;
  }
  .insight-sub {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 6px;
  }

  /* Models table */
  .models-section {
    grid-column: 1 / -1;
    background: var(--bg2);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 24px;
  }
  .models-section h3 {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-bright);
    margin-bottom: 16px;
  }
  .models-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: auto;
  }
  .models-table th {
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-dim);
    padding: 8px 12px;
    border-bottom: 1px solid var(--card-border);
  }
  .models-table td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(42, 62, 82, 0.5);
    font-size: 14px;
  }
  .model-color {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 8px;
  }
  .daily-table td { font-variant-numeric: tabular-nums; }
  .daily-table td strong { color: var(--text-bright); }
  .models-cell {
    font-size: 12px;
    color: var(--text-dim);
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-bar {
    height: 6px;
    border-radius: 3px;
    background: var(--accent);
  }
  .bar-cell { width: 200px; }

  /* Footer */
  .footer {
    grid-column: 1 / -1;
    text-align: center;
    font-size: 12px;
    color: var(--text-dim);
    padding: 16px 0;
  }

  /* Page-level tabs */
  .page-tabs {
    grid-column: 1 / -1;
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .page-tab {
    padding: 12px 28px;
    border-radius: 12px 12px 0 0;
    border: 1px solid var(--card-border);
    border-bottom: none;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 15px;
    font-weight: 600;
    transition: all 0.2s;
  }
  .page-tab:hover { background: var(--bg2); color: var(--text); }
  .page-tab.active {
    background: var(--bg2);
    color: var(--text-bright);
    border-color: var(--accent);
  }
  .reload-btn {
    margin-left: auto;
    align-self: center;
    padding: 7px 16px;
    border-radius: 8px;
    border: 1px solid var(--card-border);
    background: var(--bg2);
    color: var(--text-dim);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    transition: all 0.2s;
  }
  .reload-btn:hover { background: var(--bg3); color: var(--accent); border-color: var(--accent); }
  .reload-btn.busy { opacity: 0.5; pointer-events: none; }
  .page-content {
    display: none;
    grid-column: 1 / -1;
  }
  .page-content.active {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    width: 100%;
  }
  .page-content.active.single-col {
    grid-template-columns: 1fr;
  }
  .page-content .models-section {
    overflow-x: auto;
  }

  /* Detailed view specific */
  .detail-header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
  }
  .detail-header h2 {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-bright);
    margin: 0;
  }
  .detail-header .window-badge {
    font-size: 13px;
    color: var(--text-dim);
    background: var(--bg3);
    padding: 4px 12px;
    border-radius: 8px;
  }
  .detail-stats-row {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
  }
  .cost-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--accent);
    margin-top: 8px;
  }
  .request-time {
    font-family: 'SF Mono', 'Consolas', monospace;
    font-size: 13px;
    color: var(--accent);
    white-space: nowrap;
  }
  .model-badge {
    display: inline-block;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 6px;
    background: var(--bg3);
    color: var(--text-dim);
    white-space: nowrap;
  }
  /* Model badge shows its per-1M pricing on hover via a native title tooltip */
  .model-badge[title] { cursor: help; }
  /* Wrapper that groups all filter combos together on the right of a detail header */
  .detail-filters {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-left: auto;
  }
  .project-filter {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .project-filter label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .project-filter select {
    background: var(--bg3);
    color: var(--text);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
    outline: none;
  }
  .project-filter select:focus {
    border-color: var(--accent);
  }
  .session-id {
    font-family: 'SF Mono', 'Consolas', monospace;
    font-size: 11px;
    color: var(--text-dim);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 1100px) {
    .dashboard { grid-template-columns: 1fr; }
    .stats-row { grid-template-columns: 1fr 1fr; }
    .main-row { grid-template-columns: 1fr; }
    .detail-stats-row { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 600px) {
    .stats-row { grid-template-columns: 1fr; }
    .insights-grid { grid-template-columns: 1fr; }
    .detail-stats-row { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="dashboard">

  <!-- Page-level tab switcher -->
  <div class="page-tabs">
    <button class="page-tab active" onclick="switchPage('overview')">Dashboard</button>
    <button class="page-tab" onclick="switchPage('24h')">Last 24h</button>
    <button class="page-tab" onclick="switchPage('detailed')">Detailed (5h)</button>
    <button class="page-tab" onclick="switchPage('detailed1h')">Detailed (1h)</button>
    <button class="reload-btn" onclick="reloadStats(this)" title="Regenerate stats from the latest session data">⟳ Reload</button>
  </div>

  <!-- ==================== OVERVIEW TAB ==================== -->
  <div class="page-content active" id="page-overview">

  <!-- Top stats row -->
  <div class="stats-row">
    <div class="stat-card primary">
      <div class="stat-label">All-Time Tokens</div>
      <div class="stat-value">${formatTokens(d.allTimeTokens)}</div>
      <div class="stat-sub">${d.daily.length} days recorded locally. $${d.allTimeCost.toFixed(2)} estimated cost.</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Today</div>
      <div class="stat-value medium">${formatTokens(d.todayTokens)}</div>
      <div class="stat-sub">Tokens today.</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">30 Days</div>
      <div class="stat-value medium">${formatTokens(d.last30Tokens)}</div>
      <div class="stat-sub">Recent volume.</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Sessions</div>
      <div class="stat-value medium">${formatTokens(stats.sessions.length)}</div>
      <div class="stat-sub">Total sessions.</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Spend</div>
      <div class="stat-value medium">$${d.allTimeCost.toFixed(2)}</div>
      <div class="stat-sub">Estimated from token usage.</div>
    </div>
  </div>

  <!-- Main content: chart + right panel side by side -->
  <div class="main-row">
    <div class="chart-section">
      <h2>Over Time</h2>
      <h3>Usage over time</h3>

      <div class="tabs">
        <button class="tab active" onclick="switchTab('tokens')">Tokens</button>
        <button class="tab" onclick="switchTab('cost')">Spend</button>
        <button class="tab" onclick="switchTab('models')">Models</button>
      </div>

      <div class="filters">
        <button class="filter-pill active" onclick="switchFilter('all')">All</button>
        <button class="filter-pill" onclick="switchFilter('1y')">1Y</button>
        <button class="filter-pill" onclick="switchFilter('90d')">90D</button>
        <button class="filter-pill" onclick="switchFilter('30d')">30D</button>
      </div>

      <!-- Token-series mode — only meaningful on the Tokens tab: "All" = total incl. cache,
           "In/Out" = just the fresh input+output (cache excluded). Hidden on other tabs. -->
      <div class="filters" id="tokenModePills">
        <button class="filter-pill active" onclick="switchTokenMode('all')">All</button>
        <button class="filter-pill" onclick="switchTokenMode('inout')">In/Out</button>
      </div>

      <div class="chart-info" id="chartInfo">
        All time &middot; ${formatTokens(d.allTimeTokens)} tokens total &middot; peak ${peakMonth} ${peakDayNum}
      </div>

      <div class="chart-container">
        <canvas id="mainChart"></canvas>
      </div>
    </div>

    <div class="right-panel">
    <div class="heatmap-section">
      <h2>Daily Map</h2>
      <h3>Daily usage</h3>
      <div class="heatmap-info">
        All time &middot; ${d.activeDays} active days &middot; ${formatTokens(d.todayTokens)} tokens today
      </div>
      <div class="heatmap-wrapper">
        <div class="heatmap-day-labels">
          <span>Mon</span>
          <span>&nbsp;</span>
          <span>Wed</span>
          <span>&nbsp;</span>
          <span>Fri</span>
          <span>&nbsp;</span>
          <span>&nbsp;</span>
        </div>
        <div>
          <div class="heatmap-grid" id="heatmapGrid"></div>
          <div class="heatmap-labels" id="heatmapLabels"></div>
        </div>
      </div>
      <div class="heatmap-legend">
        <span>Less</span>
        <div class="legend-cell" style="background: var(--bg);"></div>
        <div class="legend-cell" style="background: #1a3a4a;"></div>
        <div class="legend-cell" style="background: #1a5a6a;"></div>
        <div class="legend-cell" style="background: #2a8aaa;"></div>
        <div class="legend-cell" style="background: #4fc3f7;"></div>
        <span>More</span>
        <span style="margin-left: auto;">Tokens / day</span>
      </div>
    </div>

    <div class="insights-grid">
      <div class="insight-card">
        <div class="insight-label">Peak Day</div>
        <div class="insight-value">${peakMonth} ${peakDayNum}</div>
        <div class="insight-sub">${formatTokens(d.peakDayTokens)} tokens</div>
      </div>
      <div class="insight-card">
        <div class="insight-label">Active Days</div>
        <div class="insight-value">${d.activeDays}</div>
        <div class="insight-sub">Across ${d.totalDaySpan} calendar days.</div>
      </div>
      <div class="insight-card">
        <div class="insight-label">Current Streak</div>
        <div class="insight-value">${d.streak}d</div>
        <div class="insight-sub">Consecutive active days ending today.</div>
      </div>
      <div class="insight-card">
        <div class="insight-label">API Time Today</div>
        <div class="insight-value">${formatDurationMs(todayDurationMs)}</div>
        <div class="insight-sub">Cumulative response time.</div>
      </div>
    </div>
  </div><!-- /right-panel -->
  </div><!-- /main-row -->

  <!-- Models breakdown table -->
  <div class="models-section">
    <h3>Model Breakdown</h3>
    <table class="models-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cached</th>
          <th>Total</th>
          <th>Cost</th>
          <th>Share</th>
          <th class="bar-cell">Distribution</th>
        </tr>
      </thead>
      <tbody>
        ${d.modelsSorted.map(([name, m]) => {
          const pct = d.allTimeTokens > 0 ? (m.total / d.allTimeTokens * 100) : 0;
          const color = modelColors[name] || '#4fc3f7';
          const cached = m.cacheCreate + m.cacheRead;
          return `<tr>
            <td title="${priceTitle(name)}"><span class="model-color" style="background:${color}"></span>${name.replace('anthropic/', '')}</td>
            <td>${formatTokens(m.input)}</td>
            <td>${formatTokens(m.output)}</td>
            <td title="cache write ${formatTokens(m.cacheCreate)} &middot; cache read ${formatTokens(m.cacheRead)}">${formatTokens(cached)}</td>
            <td><strong>${formatTokens(m.total)}</strong></td>
            <td>$${m.cost.toFixed(2)}</td>
            <td>${pct.toFixed(1)}%</td>
            <td class="bar-cell"><div class="model-bar" style="width:${pct}%; background:${color}"></div></td>
          </tr>`;
        }).join('\n        ')}
      </tbody>
    </table>
  </div>

  <!-- Daily consumption table -->
  <div class="models-section">
    <h3>Daily Consumption</h3>
    <table class="models-table daily-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Total Tokens</th>
          <th>Input</th>
          <th>Output</th>
          <th>Cache Create</th>
          <th>Cache Read</th>
          <th>Cost</th>
          <th>API Time</th>
          <th>Models</th>
        </tr>
      </thead>
      <tbody>
        ${[...d.daily].reverse().map(day => {
          const total = getTotalTokensForDay(day);
          const dayDur = dailyDurationMap[day.date];
          const durStr = dayDur != null ? formatDurationMs(dayDur) : '-';
          return `<tr>
            <td>${day.date}</td>
            <td><strong>${formatTokens(total)}</strong></td>
            <td>${formatTokens(day.inputTokens)}</td>
            <td>${formatTokens(day.outputTokens)}</td>
            <td>${formatTokens(day.cacheCreationTokens)}</td>
            <td>${formatTokens(day.cacheReadTokens)}</td>
            <td>$${day.totalCost.toFixed(2)}</td>
            <td>${durStr}</td>
            <td class="models-cell">${day.modelsUsed.map(m => m.replace('anthropic/', '')).join(', ')}</td>
          </tr>`;
        }).join('\n        ')}
      </tbody>
    </table>
  </div>

  </div><!-- /page-overview -->

  <!-- ==================== LAST 24H TAB ==================== -->
  <div class="page-content single-col" id="page-24h">

    <div class="detail-header">
      <h2>Last 24 Hours – Hourly Breakdown</h2>
      <span class="window-badge">${new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleString()} – ${new Date().toLocaleString()}</span>
      <div class="detail-filters">
        <div class="project-filter">
          <label>Project</label>
          <select id="filter24h" onchange="apply24hFilter()">
            <option value="">All Projects</option>
            ${stats.projects24h.map(p => `<option value="${p.project}">${p.project}</option>`).join('\n            ')}
          </select>
        </div>
        <div class="project-filter">
          <label>Model</label>
          <select id="filter24hModel" onchange="apply24hModelFilter()">
            <option value="">All Models</option>
            ${stats.models24h.map(m => `<option value="${m.model}">${m.model.replace('anthropic/', '')}</option>`).join('\n            ')}
          </select>
        </div>
      </div>
    </div>

    <div id="stats24h"></div>

    <!-- 24h hourly bar chart -->
    <div class="chart-section full-width">
      <h2>Hourly Usage</h2>
      <h3>Tokens &amp; Cost per Hour</h3>
      <div class="tabs">
        <button class="tab h24-tab active" onclick="switch24hTab('tokens')">Tokens</button>
        <button class="tab h24-tab" onclick="switch24hTab('cost')">Cost</button>
      </div>
      <div class="chart-container" style="height: 320px;">
        <canvas id="chart24h"></canvas>
      </div>
    </div>

    <div id="models24hBreakdown"></div>
    <div id="projects24h"></div>
    <div id="hourlyTable24h"></div>

  </div><!-- /page-24h -->

  <!-- ==================== DETAILED TAB ==================== -->
  <div class="page-content single-col" id="page-detailed">

    <div class="detail-header">
      <h2>Detailed Usage (Last 5 Hours)</h2>
      <span class="window-badge">${new Date(stats.detailed.windowStart).toLocaleTimeString()} – ${new Date(stats.detailed.windowEnd).toLocaleTimeString()}</span>
      <div class="detail-filters">
        <div class="project-filter">
          <label>Project</label>
          <select id="filter5h" onchange="apply5hFilter()">
            <option value="">All Projects</option>
            ${stats.detailed.projects.map(p => `<option value="${p.project}">${p.project}</option>`).join('\n            ')}
          </select>
        </div>
        <div class="project-filter">
          <label>Model</label>
          <select id="filterModel5h" onchange="apply5hFilter()">
            <option value="">All Models</option>
            ${detailedModels.map(m => `<option value="${m.id}">${m.label}</option>`).join('\n            ')}
          </select>
        </div>
      </div>
    </div>

    <div id="stats5h"></div>
    <div id="models5h"></div>
    <div id="projects5h"></div>
    <div id="timeline5h"></div>

  </div><!-- /page-detailed -->

  <!-- ==================== DETAILED 1H TAB ==================== -->
  <div class="page-content single-col" id="page-detailed1h">

    <div class="detail-header">
      <h2>Detailed Usage (Last 1 Hour)</h2>
      <span class="window-badge">${new Date(new Date(stats.generatedAt).getTime() - 60 * 60 * 1000).toLocaleTimeString()} – ${new Date(stats.generatedAt).toLocaleTimeString()}</span>
      <div class="detail-filters">
        <div class="project-filter">
          <label>Project</label>
          <select id="filter1h" onchange="apply1hFilter()">
            <option value="">All Projects</option>
            ${stats.detailed.projects.map(p => `<option value="${p.project}">${p.project}</option>`).join('\n            ')}
          </select>
        </div>
        <div class="project-filter">
          <label>Model</label>
          <select id="filterModel1h" onchange="apply1hFilter()">
            <option value="">All Models</option>
            ${detailedModels.map(m => `<option value="${m.id}">${m.label}</option>`).join('\n            ')}
          </select>
        </div>
      </div>
    </div>

    <div id="stats1h"></div>
    <div id="models1h"></div>
    <div id="projects1h"></div>
    <div id="timeline1h"></div>

  </div><!-- /page-detailed1h -->

  <div class="footer">
    Generated ${new Date().toLocaleString()} &middot; Data from ccusage &middot; ${stats.daily.length} days
  </div>
</div>

<script>
const labels = ${chartLabels};
const tokensData = ${chartTokens};
const inputData = ${chartInput};
const outputData = ${chartOutput};
const costData = ${chartCost};
const modelSeries = ${JSON.stringify(modelSeries)};

// Cumulative tokens
const cumulativeTokens = [];
let cumSum = 0;
for (const t of tokensData) { cumSum += t; cumulativeTokens.push(cumSum); }

// Cumulative fresh input / output (cache excluded) for the In/Out token mode.
const cumulativeInput = [];
let inSum = 0;
for (const t of inputData) { inSum += t; cumulativeInput.push(inSum); }
const cumulativeOutput = [];
let outSum = 0;
for (const t of outputData) { outSum += t; cumulativeOutput.push(outSum); }

const cumulativeCost = [];
let costSum = 0;
for (const c of costData) { costSum += c; cumulativeCost.push(costSum); }

const ctx = document.getElementById('mainChart').getContext('2d');
let currentChart = null;
let currentTab = 'tokens';
let currentFilter = 'all';
let currentTokenMode = 'all'; // 'all' = total incl. cache, 'inout' = input+output only

function getFilteredRange() {
  const now = new Date();
  let cutoff = null;
  if (currentFilter === '30d') cutoff = new Date(now - 30 * 86400000);
  else if (currentFilter === '90d') cutoff = new Date(now - 90 * 86400000);
  else if (currentFilter === '1y') cutoff = new Date(now - 365 * 86400000);

  if (!cutoff) return { start: 0, end: labels.length };

  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let start = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] >= cutoffStr) { start = i; break; }
  }
  return { start, end: labels.length };
}

function buildChart() {
  if (currentChart) currentChart.destroy();

  const { start, end } = getFilteredRange();
  const filteredLabels = labels.slice(start, end);

  let datasets;
  if (currentTab === 'tokens') {
    if (currentTokenMode === 'inout') {
      // Fresh tokens only — input and output as two cumulative lines (cache excluded).
      datasets = [
        {
          label: 'Input',
          data: cumulativeInput.slice(start, end),
          borderColor: '#4fc3f7',
          backgroundColor: 'rgba(79, 195, 247, 0.1)',
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
        {
          label: 'Output',
          data: cumulativeOutput.slice(start, end),
          borderColor: '#81c784',
          backgroundColor: 'rgba(129, 199, 132, 0.1)',
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
      ];
    } else {
      datasets = [{
        label: 'Total Tokens',
        data: cumulativeTokens.slice(start, end),
        borderColor: '#e0e8f0',
        backgroundColor: 'rgba(79, 195, 247, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
      }];
    }
  } else if (currentTab === 'cost') {
    datasets = [{
      label: 'Cumulative Cost ($)',
      data: cumulativeCost.slice(start, end),
      borderColor: '#81c784',
      backgroundColor: 'rgba(129, 199, 132, 0.1)',
      fill: true,
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }];
  } else {
    // Models stacked
    datasets = modelSeries.map(s => ({
      label: s.label,
      data: s.data.slice(start, end),
      backgroundColor: s.color + '88',
      borderColor: s.color,
      borderWidth: 1,
      fill: true,
      tension: 0.3,
      pointRadius: 0,
    }));
  }

  currentChart = new Chart(ctx, {
    type: 'line',
    data: { labels: filteredLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: currentTab === 'models' || (currentTab === 'tokens' && currentTokenMode === 'inout'),
          labels: { color: '#8899aa', font: { size: 11 } },
          position: 'bottom',
        },
        tooltip: {
          backgroundColor: '#1a2a3a',
          titleColor: '#e0e8f0',
          bodyColor: '#8899aa',
          borderColor: '#2a3e52',
          borderWidth: 1,
          // Order tooltip rows by value, largest first (matters for the stacked Models view
          // and the In/Out token mode).
          itemSort: function(a, b) { return b.parsed.y - a.parsed.y; },
          callbacks: {
            label: function(ctx) {
              const val = ctx.parsed.y;
              if (currentTab === 'cost') return ctx.dataset.label + ': $' + val.toFixed(2);
              return ctx.dataset.label + ': ' + formatNum(val);
            }
          }
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(42, 62, 82, 0.5)' },
          ticks: {
            color: '#8899aa',
            maxTicksLimit: 8,
            font: { size: 11 },
          },
        },
        y: {
          stacked: currentTab === 'models',
          grid: { color: 'rgba(42, 62, 82, 0.5)' },
          ticks: {
            color: '#8899aa',
            font: { size: 11 },
            callback: function(val) { return currentTab === 'cost' ? '$' + formatNum(val) : formatNum(val); }
          },
        },
      },
    },
  });
}

function fmtDur(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = s / 60;
  if (m < 60) return m.toFixed(1) + 'm';
  return (m / 60).toFixed(1) + 'h';
}

function formatNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.querySelector('.tab[onclick*="' + tab + '"]').classList.add('active');
  // The All/In/Out token-series toggle only applies to the Tokens tab.
  const tm = document.getElementById('tokenModePills');
  if (tm) tm.style.display = (tab === 'tokens') ? 'flex' : 'none';
  buildChart();
}

function switchTokenMode(mode) {
  currentTokenMode = mode;
  document.querySelectorAll('#tokenModePills .filter-pill').forEach(el => el.classList.remove('active'));
  document.querySelector('#tokenModePills .filter-pill[onclick*="' + mode + '"]').classList.add('active');
  buildChart();
}

function switchFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-pill').forEach(el => el.classList.remove('active'));
  document.querySelector('.filter-pill[onclick*="' + filter + '"]').classList.add('active');
  buildChart();
}

// Build heatmap
(function buildHeatmap() {
  const grid = document.getElementById('heatmapGrid');
  const labelsDiv = document.getElementById('heatmapLabels');
  const heatmapData = ${JSON.stringify(heatmapMap)};
  const heatmapMax = ${heatmapMax};

  // Start from 26 weeks ago (aligned to Monday)
  const now = new Date();
  const start = new Date(now);
  const mondayOffset = (start.getDay() + 6) % 7; // Mon=0 … Sun=6
  start.setDate(start.getDate() - (26 * 7) - mondayOffset);

  const months = new Set();
  const monthPositions = [];
  let weekIndex = 0;

  for (let w = 0; w < 27; w++) {
    const col = document.createElement('div');
    col.className = 'heatmap-col';

    for (let d = 0; d < 7; d++) {
      const date = new Date(start);
      date.setDate(date.getDate() + w * 7 + d);
      const ds = date.toISOString().slice(0, 10);
      const tokens = heatmapData[ds] || 0;

      const cell = document.createElement('div');
      cell.className = 'heatmap-cell';
      cell.title = ds + ': ' + formatNum(tokens) + ' tokens';

      if (tokens === 0) {
        cell.style.background = 'var(--bg)';
      } else {
        const intensity = Math.min(tokens / (heatmapMax * 0.7), 1);
        if (intensity < 0.25) cell.style.background = '#1a3a4a';
        else if (intensity < 0.5) cell.style.background = '#1a5a6a';
        else if (intensity < 0.75) cell.style.background = '#2a8aaa';
        else cell.style.background = '#4fc3f7';
      }

      col.appendChild(cell);

      // Track month labels
      if (d === 0) {
        const monthKey = date.toLocaleString('en-US', { month: 'short' });
        if (!months.has(monthKey)) {
          months.add(monthKey);
          monthPositions.push({ label: monthKey, week: w });
        }
      }
    }
    grid.appendChild(col);
  }

  // Add month labels
  for (const mp of monthPositions) {
    const span = document.createElement('span');
    span.textContent = mp.label;
    span.style.position = 'absolute';
    span.style.left = (mp.week * 17) + 'px';
    labelsDiv.appendChild(span);
  }
  labelsDiv.style.position = 'relative';
  labelsDiv.style.height = '20px';
})();

// ===== 24H TAB: data + dynamic rendering =====
const raw24h = ${JSON.stringify(stats.hourly24h)};
const rawProjects24h = ${JSON.stringify(stats.projects24h)};
const rawModels24h = ${JSON.stringify(stats.models24h)};
const rawProjectModels24h = ${JSON.stringify(stats.projectModels24h)};
let current24hProject = '';
let current24hModel = '';
let current24hTab = 'tokens';
let chart24h = null;

// Project and model filters are mutually exclusive (picking one resets the other), so we never
// need per-project-per-model data: a model re-maps each hour to its byModel bucket, a project to
// its byProject bucket, exactly like the project filter always has.
function get24hFiltered() {
  const proj = current24hProject;
  const mdl = current24hModel;
  return raw24h.map(h => {
    if (mdl) {
      const bm = h.byModel[mdl];
      if (!bm) return { ...h, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, projects: [], modelsUsed: [] };
      return { ...h, inputTokens: bm.inputTokens, outputTokens: bm.outputTokens, cacheCreationTokens: bm.cacheCreationTokens, cacheReadTokens: bm.cacheReadTokens, cost: bm.cost, durationMs: bm.durationMs || 0, modelsUsed: [mdl] };
    }
    if (!proj) return h;
    const bp = h.byProject[proj];
    if (!bp) return { ...h, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, cost: 0, durationMs: 0, projects: [], modelsUsed: [] };
    return { ...h, inputTokens: bp.inputTokens, outputTokens: bp.outputTokens, cacheCreationTokens: bp.cacheCreationTokens, cacheReadTokens: bp.cacheReadTokens, cost: bp.cost, durationMs: bp.durationMs || 0, projects: [proj] };
  });
}

function render24hStats() {
  const data = get24hFiltered();
  const totalTokens = data.reduce((s, h) => s + h.inputTokens + h.outputTokens + h.cacheCreationTokens + h.cacheReadTokens, 0);
  const totalCost = data.reduce((s, h) => s + h.cost, 0);
  const totalDur = data.reduce((s, h) => s + (h.durationMs || 0), 0);
  const activeHours = data.filter(h => h.inputTokens + h.outputTokens + h.cacheCreationTokens + h.cacheReadTokens > 0).length;
  const reqCount = current24hModel
    ? (rawModels24h.find(m => m.model === current24hModel)?.requestCount || 0)
    : current24hProject
    ? (rawProjects24h.find(p => p.project === current24hProject)?.requestCount || 0)
    : rawProjects24h.reduce((s, p) => s + p.requestCount, 0);
  const lastSub = current24hModel ? current24hModel.replace('anthropic/', '')
    : current24hProject ? '1 project'
    : rawProjects24h.length + ' projects';
  // Unified with the Detailed (5h/1h) panels: Requests · Total Tokens · Cost · API Time.
  document.getElementById('stats24h').innerHTML = '<div class="detail-stats-row">' +
    '<div class="stat-card"><div class="stat-label">Requests (24h)</div><div class="stat-value medium">' + reqCount + '</div><div class="stat-sub">' + activeHours + ' active hours</div></div>' +
    '<div class="stat-card"><div class="stat-label">Total Tokens (24h)</div><div class="stat-value medium">' + formatNum(totalTokens) + '</div><div class="stat-sub">All token types</div></div>' +
    '<div class="stat-card"><div class="stat-label">Cost (24h)</div><div class="stat-value medium">$' + totalCost.toFixed(2) + '</div><div class="stat-sub">Per-token-type pricing</div></div>' +
    '<div class="stat-card"><div class="stat-label">API Time (24h)</div><div class="stat-value medium">' + fmtDur(totalDur) + '</div><div class="stat-sub">' + lastSub + '</div></div>' +
    '</div>';
}

function render24hChart() {
  const ctx24h = document.getElementById('chart24h')?.getContext('2d');
  if (!ctx24h) return;
  if (chart24h) chart24h.destroy();
  const data = get24hFiltered();
  const chartLabels24h = data.map(h => h.label.slice(11));
  const values = current24hTab === 'tokens'
    ? data.map(h => h.inputTokens + h.outputTokens + h.cacheCreationTokens + h.cacheReadTokens)
    : data.map(h => h.cost);
  const color = current24hTab === 'tokens' ? '#4fc3f7' : '#81c784';
  chart24h = new Chart(ctx24h, {
    type: 'bar',
    data: { labels: chartLabels24h, datasets: [{ label: current24hTab === 'tokens' ? 'Tokens' : 'Cost ($)', data: values, backgroundColor: values.map(v => v > 0 ? color + 'aa' : color + '22'), borderColor: color, borderWidth: 1, borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a2a3a', titleColor: '#e0e8f0', bodyColor: '#8899aa', borderColor: '#2a3e52', borderWidth: 1, callbacks: { label: function(c) { const v = c.parsed.y; return current24hTab === 'cost' ? '$' + v.toFixed(2) : formatNum(v) + ' tokens'; } } } },
      scales: { x: { grid: { color: 'rgba(42,62,82,0.3)' }, ticks: { color: '#8899aa', font: { size: 11 }, maxRotation: 45 } }, y: { grid: { color: 'rgba(42,62,82,0.5)' }, ticks: { color: '#8899aa', font: { size: 11 }, callback: function(v) { return current24hTab === 'cost' ? '$' + formatNum(v) : formatNum(v); } } } },
    },
  });
}

function projectRow24h(p, totalCost, modelsText) {
  const pct = totalCost > 0 ? (p.cost / totalCost * 100) : 0;
  return '<tr><td><strong>' + p.project + '</strong></td><td>' + p.requestCount + '</td><td>' + p.sessionCount + '</td><td><strong>' + formatNum(p.totalTokens) + '</strong></td><td>' + formatNum(p.inputTokens) + '</td><td>' + formatNum(p.outputTokens) + '</td><td>' + formatNum(p.cacheCreationTokens) + '</td><td>' + formatNum(p.cacheReadTokens) + '</td><td><strong>$' + p.cost.toFixed(2) + '</strong></td><td>' + fmtDur(p.durationMs || 0) + '</td><td class="models-cell">' + modelsText + '</td><td class="bar-cell"><div class="cost-bar" style="width:' + pct + '%"></div></td></tr>';
}
function projectTable24h(title, rowsHtml) {
  return '<div class="models-section full-width"><h3>' + title + '</h3><table class="models-table daily-table"><thead><tr><th>Project</th><th>Requests</th><th>Sessions</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th><th>Cost</th><th>API Time</th><th>Models</th><th class="bar-cell">Share</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function render24hProjects() {
  // A PROJECT filter collapses this per-project table to one redundant row → keep it hidden.
  if (current24hProject) { document.getElementById('projects24h').innerHTML = ''; return; }
  let list, title, fixedModel = null;
  if (current24hModel) {
    // A MODEL filter: show each project's consumption OF THAT MODEL (was previously blanked out).
    const mdl = current24hModel;
    const label = mdl.replace('anthropic/', '');
    list = Object.keys(rawProjectModels24h)
      .map(proj => { const c = rawProjectModels24h[proj][mdl]; return c ? Object.assign({ project: proj }, c) : null; })
      .filter(p => p && p.totalTokens > 0)
      .sort((a, b) => b.cost - a.cost);
    title = 'Per-Project Breakdown (24h · ' + label + ')';
    fixedModel = label;
  } else {
    list = rawProjects24h;
    title = 'Per-Project Breakdown (24h)';
  }
  const totalCost = list.reduce((s, p) => s + p.cost, 0);
  const rows = list.map(p => projectRow24h(p, totalCost, fixedModel != null ? fixedModel : p.modelsUsed.map(m => m.replace('anthropic/', '')).join(', '))).join('');
  document.getElementById('projects24h').innerHTML = projectTable24h(title, rows);
}

// Unified with the 5h/1h Per-Model Breakdown (modelSummaryHTML): same columns + modelChip pricing
// hover + Cost Share %.
function modelRow24h(m, totalCost) {
  const pct = totalCost > 0 ? (m.cost / totalCost * 100) : 0;
  return '<tr><td>' + modelChip(m.model) + '</td><td>' + m.requestCount + '</td><td><strong>' + formatNum(m.totalTokens) + '</strong></td><td>' + formatNum(m.inputTokens) + '</td><td>' + formatNum(m.outputTokens) + '</td><td>' + formatNum(m.cacheCreationTokens) + '</td><td>' + formatNum(m.cacheReadTokens) + '</td><td><strong>$' + m.cost.toFixed(2) + '</strong></td><td>' + pct.toFixed(1) + '%</td><td class="bar-cell"><div class="cost-bar" style="width:' + pct + '%"></div></td></tr>';
}
function modelTable24h(title, rowsHtml) {
  return '<div class="models-section full-width"><h3>' + title + '</h3><table class="models-table daily-table"><thead><tr><th>Model</th><th>Requests</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th><th>Cost</th><th>Cost Share</th><th class="bar-cell">Distribution</th></tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function render24hModels() {
  // A MODEL filter collapses this per-model table to one redundant row → keep it hidden.
  if (current24hModel) { document.getElementById('models24hBreakdown').innerHTML = ''; return; }
  let list, title;
  if (current24hProject) {
    // A PROJECT filter: show each model's consumption WITHIN THAT PROJECT (was previously blanked).
    const byModel = rawProjectModels24h[current24hProject] || {};
    list = Object.keys(byModel)
      .map(mdl => Object.assign({ model: mdl }, byModel[mdl]))
      .filter(m => m.totalTokens > 0)
      .sort((a, b) => b.cost - a.cost);
    title = 'Per-Model Breakdown (24h · ' + current24hProject + ')';
  } else {
    list = rawModels24h;
    title = 'Per-Model Breakdown (24h)';
  }
  const totalCost = list.reduce((s, m) => s + m.cost, 0);
  const rows = list.map(m => modelRow24h(m, totalCost)).join('');
  document.getElementById('models24hBreakdown').innerHTML = modelTable24h(title, rows);
}

function render24hTable() {
  const data = get24hFiltered().filter(h => h.inputTokens + h.outputTokens + h.cacheCreationTokens + h.cacheReadTokens > 0).reverse();
  let rows = data.map(h => {
    const total = h.inputTokens + h.outputTokens + h.cacheCreationTokens + h.cacheReadTokens;
    return '<tr><td class="request-time">' + h.label + '</td><td><strong>' + formatNum(total) + '</strong></td><td>' + formatNum(h.inputTokens) + '</td><td>' + formatNum(h.outputTokens) + '</td><td>' + formatNum(h.cacheCreationTokens) + '</td><td>' + formatNum(h.cacheReadTokens) + '</td><td><strong>$' + h.cost.toFixed(2) + '</strong></td><td>' + fmtDur(h.durationMs || 0) + '</td><td class="models-cell">' + h.projects.join(', ') + '</td><td class="models-cell">' + h.modelsUsed.map(m => m.replace('anthropic/', '')).join(', ') + '</td></tr>';
  }).join('');
  document.getElementById('hourlyTable24h').innerHTML = '<div class="models-section full-width"><h3>Hourly Consumption</h3><table class="models-table daily-table"><thead><tr><th>Hour</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th><th>Cost</th><th>API Time</th><th>Projects</th><th>Models</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function apply24hFilter() {
  current24hProject = document.getElementById('filter24h').value;
  // Project and model filters are mutually exclusive — picking one clears the other.
  if (current24hProject) { current24hModel = ''; document.getElementById('filter24hModel').value = ''; }
  render24hStats(); render24hChart(); render24hModels(); render24hProjects(); render24hTable();
}
function apply24hModelFilter() {
  current24hModel = document.getElementById('filter24hModel').value;
  if (current24hModel) { current24hProject = ''; document.getElementById('filter24h').value = ''; }
  render24hStats(); render24hChart(); render24hModels(); render24hProjects(); render24hTable();
}
function switch24hTab(tab) {
  current24hTab = tab;
  document.querySelectorAll('.h24-tab').forEach(el => el.classList.remove('active'));
  document.querySelector('.h24-tab[onclick*="' + tab + '"]').classList.add('active');
  render24hChart();
}
// NOTE: the initial apply24hFilter() call lives AFTER the modelChip / MODEL_PRICING definitions
// below — render24hModels now calls modelChip(), and MODEL_PRICING is a const (temporal dead
// zone), so kicking off the 24h render here would throw at init.

// ===== Shared model-chip widget (pricing shown only on hover, as a labelled tooltip) =====
const MODEL_PRICING = ${JSON.stringify(modelPricing)};
function fmtRate(v) { return v >= 1 ? '$' + (Number.isInteger(v) ? v : v.toFixed(2)) : '$' + v.toFixed(2); }
function priceTitle(p) {
  if (!p) return 'Pricing per 1M tokens unavailable for this model';
  return ['Price — USD per 1M tokens',
    'Input:       ' + fmtRate(p.input),
    'Output:      ' + fmtRate(p.output),
    'Cache write: ' + fmtRate(p.cacheCreate),
    'Cache read:  ' + fmtRate(p.cacheRead)].join('&#10;');
}
function modelChip(modelId) {
  const label = (modelId || 'unknown').replace('anthropic/', '');
  return '<span class="model-badge" title="' + priceTitle(MODEL_PRICING[modelId]) + '">' + label + '</span>';
}

// Kick off the 24h render now that modelChip + MODEL_PRICING exist (render24hModels uses them).
apply24hFilter();

// ===== Shared helpers for the detailed (5h / 1h) views =====
function aggregateByModel(reqs) {
  const map = {};
  for (const r of reqs) {
    const m = r.model || 'unknown';
    if (!map[m]) map[m] = { model: m, requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, cost: 0 };
    const a = map[m];
    a.requests++;
    a.inputTokens += r.inputTokens; a.outputTokens += r.outputTokens;
    a.cacheCreationTokens += r.cacheCreationTokens; a.cacheReadTokens += r.cacheReadTokens;
    a.totalTokens += r.totalTokens; a.cost += r.cost;
  }
  return Object.values(map).sort((a, b) => b.cost - a.cost);
}

function modelSummaryHTML(reqs, title) {
  const models = aggregateByModel(reqs);
  if (!models.length) return '';
  const totalCost = models.reduce((s, m) => s + m.cost, 0);
  const rows = models.map(m => {
    const pct = totalCost > 0 ? (m.cost / totalCost * 100) : 0;
    return '<tr><td>' + modelChip(m.model) + '</td><td>' + m.requests + '</td><td><strong>' + formatNum(m.totalTokens) + '</strong></td><td>' + formatNum(m.inputTokens) + '</td><td>' + formatNum(m.outputTokens) + '</td><td>' + formatNum(m.cacheCreationTokens) + '</td><td>' + formatNum(m.cacheReadTokens) + '</td><td><strong>$' + m.cost.toFixed(2) + '</strong></td><td>' + pct.toFixed(1) + '%</td><td class="bar-cell"><div class="cost-bar" style="width:' + pct + '%"></div></td></tr>';
  }).join('');
  return '<div class="models-section"><h3>' + title + '</h3><table class="models-table daily-table"><thead><tr><th>Model</th><th>Requests</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th><th>Cost</th><th>Cost Share</th><th class="bar-cell">Distribution</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function detailStatsHTML(reqs, label) {
  const totalTokens = reqs.reduce((s, r) => s + r.totalTokens, 0);
  const totalCost = reqs.reduce((s, r) => s + r.cost, 0);
  const totalDur = reqs.reduce((s, r) => s + (r.durationMs || 0), 0);
  const projs = new Set(reqs.map(r => r.project));
  return '<div class="detail-stats-row">' +
    '<div class="stat-card"><div class="stat-label">Requests (' + label + ')</div><div class="stat-value medium">' + reqs.length + '</div><div class="stat-sub">API calls in window</div></div>' +
    '<div class="stat-card"><div class="stat-label">Total Tokens (' + label + ')</div><div class="stat-value medium">' + formatNum(totalTokens) + '</div><div class="stat-sub">All token types</div></div>' +
    '<div class="stat-card"><div class="stat-label">Cost (' + label + ')</div><div class="stat-value medium">$' + totalCost.toFixed(2) + '</div><div class="stat-sub">Per-token-type pricing</div></div>' +
    '<div class="stat-card"><div class="stat-label">API Time (' + label + ')</div><div class="stat-value medium">' + fmtDur(totalDur) + '</div><div class="stat-sub">' + projs.size + ' projects</div></div>' +
    '</div>';
}

function timelineTableHTML(reqs) {
  const maxCost = reqs.reduce((m, r) => Math.max(m, r.cost), 0) || 1;
  const rows = reqs.map(r => {
    const time = new Date(r.timestamp).toLocaleTimeString();
    let style = '';
    if (r.cost >= maxCost * 0.5) style = 'background: rgba(229,115,115,0.25); color: #ffcdd2;';
    else if (r.cost >= maxCost * 0.2) style = 'background: rgba(255,183,77,0.2); color: #ffe0b2;';
    else if (r.cost >= maxCost * 0.05) style = 'background: rgba(255,213,79,0.1);';
    return '<tr style="' + style + '"><td class="request-time">' + time + '</td><td><strong>' + r.project + '</strong></td><td>' + modelChip(r.model) + '</td><td><strong>' + formatNum(r.totalTokens) + '</strong></td><td>' + formatNum(r.inputTokens) + '</td><td>' + formatNum(r.outputTokens) + '</td><td>' + formatNum(r.cacheCreationTokens) + '</td><td>' + formatNum(r.cacheReadTokens) + '</td><td><strong>$' + r.cost.toFixed(2) + '</strong></td><td>' + fmtDur(r.durationMs || 0) + '</td><td class="session-id" title="' + r.sessionId + '">' + (r.sessionId.split('/').pop() || r.sessionId) + '</td></tr>';
  }).join('');
  return '<table class="models-table daily-table"><thead><tr><th>Time</th><th>Project</th><th>Model</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th><th>Cost</th><th>Duration</th><th>Session</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function projectBreakdownHTML(reqs, title) {
  const map = {};
  for (const r of reqs) {
    const p = map[r.project] || (map[r.project] = { project: r.project, requests: 0, sessions: new Set(), inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0, cost: 0, durationMs: 0, models: new Set() });
    p.requests++; p.sessions.add(r.sessionId); p.models.add(r.model);
    p.inputTokens += r.inputTokens; p.outputTokens += r.outputTokens;
    p.cacheCreationTokens += r.cacheCreationTokens; p.cacheReadTokens += r.cacheReadTokens;
    p.totalTokens += r.totalTokens; p.cost += r.cost; p.durationMs += (r.durationMs || 0);
  }
  const projs = Object.values(map).sort((a, b) => b.cost - a.cost);
  if (!projs.length) return '';
  const totalCost = projs.reduce((s, p) => s + p.cost, 0);
  const rows = projs.map(p => {
    const pct = totalCost > 0 ? (p.cost / totalCost * 100) : 0;
    return '<tr><td><strong>' + p.project + '</strong></td><td>' + p.requests + '</td><td>' + p.sessions.size + '</td><td><strong>' + formatNum(p.totalTokens) + '</strong></td><td>' + formatNum(p.inputTokens) + '</td><td>' + formatNum(p.outputTokens) + '</td><td>' + formatNum(p.cacheCreationTokens) + '</td><td>' + formatNum(p.cacheReadTokens) + '</td><td><strong>$' + p.cost.toFixed(2) + '</strong></td><td>' + fmtDur(p.durationMs) + '</td><td class="models-cell">' + Array.from(p.models).map(m => m.replace('anthropic/', '')).join(', ') + '</td><td class="bar-cell"><div class="cost-bar" style="width:' + pct + '%"></div></td></tr>';
  }).join('');
  return '<div class="models-section"><h3>' + title + '</h3><table class="models-table daily-table"><thead><tr><th>Project</th><th>Requests</th><th>Sessions</th><th>Total Tokens</th><th>Input</th><th>Output</th><th>Cache Create</th><th>Cache Read</th><th>Cost</th><th>API Time</th><th>Models</th><th class="bar-cell">Share</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ===== 5H TAB: data + dynamic rendering =====
const raw5hRequests = ${JSON.stringify(stats.detailed.requests)};
let current5hProject = '';
let current5hModel = '';

function get5hFiltered() {
  return raw5hRequests.filter(r =>
    (!current5hProject || r.project === current5hProject) &&
    (!current5hModel || r.model === current5hModel));
}

function render5hStats() {
  document.getElementById('stats5h').innerHTML = detailStatsHTML(get5hFiltered(), '5h');
}

function render5hModels() {
  document.getElementById('models5h').innerHTML = modelSummaryHTML(get5hFiltered(), 'Per-Model Breakdown (5h)');
}

function render5hProjects() {
  if (current5hProject) { document.getElementById('projects5h').innerHTML = ''; return; }
  document.getElementById('projects5h').innerHTML = projectBreakdownHTML(get5hFiltered(), 'Per-Project Breakdown (5h)');
}

function render5hTimeline() {
  const reqs = get5hFiltered();
  document.getElementById('timeline5h').innerHTML = '<div class="models-section"><h3>Request Timeline (' + reqs.length + ' requests)</h3>' + timelineTableHTML(reqs) + '</div>';
}

function apply5hFilter() {
  current5hProject = document.getElementById('filter5h').value;
  current5hModel = document.getElementById('filterModel5h').value;
  render5hStats(); render5hModels(); render5hProjects(); render5hTimeline();
}
apply5hFilter();

// ===== 1H TAB: derived client-side from the 5h request set (1h ⊂ 5h) =====
const GEN_MS = new Date('${stats.generatedAt}').getTime();
const oneHourAgoMs = GEN_MS - 60 * 60 * 1000;
let current1hProject = '';
let current1hModel = '';

function get1hFiltered() {
  return raw5hRequests.filter(r =>
    new Date(r.timestamp).getTime() >= oneHourAgoMs &&
    (!current1hProject || r.project === current1hProject) &&
    (!current1hModel || r.model === current1hModel));
}

function render1hStats() {
  document.getElementById('stats1h').innerHTML = detailStatsHTML(get1hFiltered(), '1h');
}

function render1hModels() {
  document.getElementById('models1h').innerHTML = modelSummaryHTML(get1hFiltered(), 'Per-Model Breakdown (1h)');
}

function render1hProjects() {
  if (current1hProject) { document.getElementById('projects1h').innerHTML = ''; return; }
  document.getElementById('projects1h').innerHTML = projectBreakdownHTML(get1hFiltered(), 'Per-Project Breakdown (1h)');
}

function render1hTimeline() {
  const reqs = get1hFiltered();
  document.getElementById('timeline1h').innerHTML = '<div class="models-section"><h3>Request Timeline (' + reqs.length + ' requests)</h3>' + timelineTableHTML(reqs) + '</div>';
}

function apply1hFilter() {
  current1hProject = document.getElementById('filter1h').value;
  current1hModel = document.getElementById('filterModel1h').value;
  render1hStats(); render1hModels(); render1hProjects(); render1hTimeline();
}
apply1hFilter();

// Reload: signal the Electron host (UsageStatsPanel listens for this console message)
// to regenerate the stats data + HTML and reload the webview. We pass the current view
// state (active page + chart sub-tabs) so the host can restore it via the URL hash.
function currentViewState() {
  const pc = document.querySelector('.page-content.active');
  const page = pc ? pc.id.replace('page-', '') : 'overview';
  return 'page=' + page + '&otab=' + currentTab + '&omode=' + currentTokenMode + '&h24=' + current24hTab;
}
function reloadStats(btn) {
  if (btn) { btn.classList.add('busy'); btn.textContent = '⟳ Reloading…'; }
  console.log('__CLAUDE_STATS_RELOAD__:' + currentViewState());
}

// Restore view state passed back through the URL hash after a reload.
function restoreViewState() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return;
  const p = new URLSearchParams(h);
  const page = p.get('page'); if (page) switchPage(page);
  const otab = p.get('otab'); if (otab && otab !== 'tokens') switchTab(otab);
  const omode = p.get('omode'); if (omode && omode !== 'all') switchTokenMode(omode);
  const h24 = p.get('h24'); if (h24 && h24 !== 'tokens') switch24hTab(h24);
}

// Page tab switching
function switchPage(page) {
  document.querySelectorAll('.page-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.page-tab').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelector('.page-tab[onclick*="' + page + '"]').classList.add('active');
}

// Init chart
buildChart();

// Restore the active page + chart sub-tabs after a reload (state carried in the URL hash).
restoreViewState();
</script>
</body>
</html>`;
}

// Main
const statsPath = join(DATA_DIR, 'stats.json');
let rawData: string;
try {
  rawData = readFileSync(statsPath, 'utf-8');
} catch {
  console.error('No stats.json found. Run generate-stats first: npm run generate-stats');
  process.exit(1);
}
const stats: Stats = JSON.parse(rawData);

mkdirSync(OUTPUT_DIR, { recursive: true });
const html = generateHTML(stats);
const outPath = join(OUTPUT_DIR, 'dashboard.html');
writeFileSync(outPath, html);
console.log(`Dashboard generated: ${outPath}`);
