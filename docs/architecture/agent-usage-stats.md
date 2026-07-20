# Agent usage statistics

Jamat builds one local usage report from Claude Code transcripts and Codex rollout files. The
report is project-aware because both sources retain the working directory that owned a session.
It is separate from account quota and rate-limit status shown in the terminal status bar.

## Pipeline

| Stage | Claude | Codex |
|---|---|---|
| Local source | Claude JSONL project transcripts | `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Loader | `app-stats/claudeUsageLoader.ts` | `app-stats/codex-usage-loader.ts` |
| Incremental cache | Per-file `claude-usage-cache.json` | Per-file `codex-usage-cache.json` |
| Cost | Anthropic API-equivalent estimate | OpenAI API-equivalent estimate for models with a current local price entry |
| Common output | `StatsView` | `StatsView` |

Both loaders inherit the fingerprint/cache lifecycle from
`app-stats/cache/usageFileCacheLoaderBase.ts`. `generate-stats.ts` rebuilds moving windows against
the current clock, merges both views, and atomically writes `<config-dir>/stats/stats.json`. The root
aggregate is the `all` view; `byAgent.claude` and `byAgent.codex` hold complete source slices.
Canonical contracts live in `core/types/stats.ts`.

## Multi-day cache

Each source-file entry is keyed by absolute path and stores its pre-read `size` and `mtimeMs` plus
only compact usage fields. Calendar dates are not part of validity. Every generation discovers the
current tree, reuses matching files, parses new or changed files once, and drops deleted paths.
Cache replacement uses a sibling temporary file followed by rename. A corrupt or version-mismatched
cache rebuilds that provider only.

Claude deduplication remains global after all cached file contributions are combined. The cache
stores token/cost inputs rather than a frozen final price, so a local price-table correction does
not require transcript parsing. Daily/session grouping retains ccusage's file-path and
`message.id + requestId` semantics. Rolling today/24h/5h data is rebuilt every run from the compact
records. The obsolete `historical-cache.json` is no longer read or written and is deliberately left
untouched during migration.

Measured on 2026-07-15 with 3,078 Claude files (3.06 GiB), 146k usage records, and 25,215 warm Codex
rollouts: the first Claude-cache build took 37.7 s inside the generator and produced a 121 MB cache.
A following run while two Claude files and one Codex rollout were actively changing took 21.0 s and
parsed only those three files. A direct ccusage daily scan alone took 70.6 s; the removed pipeline
also performed a separate session scan.

## Codex token semantics

Codex reports cumulative and last-call values in `event_msg` rows whose payload type is
`token_count`. The loader tracks the current model from `turn_context`, rejects negative deltas,
skips duplicate cumulative totals, and treats a lower cumulative total as a reset.

Codex counters overlap:

- `cached_input_tokens` is included in `input_tokens`.
- `reasoning_output_tokens` is included in `output_tokens`.

The normalized view therefore stores fresh input as `input - cached input`, cached input as cache
read, cache creation as zero, and output unchanged. `reasoningTokens` is informational only. It is
never added to `totalTokens`, so cache and reasoning cannot be double-counted.

Current local data shows token events for `codex-tui` and `codex_exec`. `codex_sdk_ts` rollouts are
metadata-indexed but not parsed fully because the observed files contain no token events; this keeps
a cold scan of tens of thousands of files bounded.

## Coverage and cost

Every view declares `costCoverage` and `durationCoverage` as `full`, `partial`, or `none`.

- Claude is `full` for the existing cost and duration metrics.
- Codex cost is `full` when every token-bearing record uses a priced model, `partial` for a mix of
  priced and unknown models, and `none` when none can be priced. Codex duration remains `none`.
- All merges cost and duration coverage independently. It can therefore have full cost coverage
  while API time remains partial and Claude-only.

`core/pricing.ts` contains the versioned local price table. As verified on 2026-07-14,
`gpt-5.6-sol` and `gpt-5.5` use $5 per million fresh input tokens, $0.50 per million cached input
tokens, and $30 per million output tokens. Cache writes use 1.25 times the fresh-input rate. A
request above 272K total input tokens applies 2x input and 1.5x output pricing to the full request.
Reasoning is already included in output and is never priced again.

Claude parity uses the same current families as ccusage: Opus 4.5+ uses $5 / $25 / $6.25 / $0.50
per million input/output/cache-write/cache-read tokens, Opus fast mode is 2x, and Sonnet 5 uses
$2 / $10 / $2.50 / $0.20. Fixture and live old-day aggregates are compared against ccusage.

Costs remain API-equivalent estimates in the data model. The React panel does not render a persistent
disclaimer banner. Unknown future model IDs remain unpriced instead of inheriting a guessed family
rate; unavailable values render as an em dash, never `$0.00`.

## UI surfaces

`UsageStatsPanel` owns one `All / Claude / Codex` segmented control and resolves a single `StatsView`
before rendering Overview, 24h, 5h, or 1h. Changing the source remounts the active view so its local
project/model filters reset coherently. A Codex-only view hides API-time cards and columns because
rollout token events do not provide a suitable duration metric.

Initial loading shows a fixed `Loading usage statistics…` title, a provider phase with file counts,
and an elapsed-seconds line. Refresh keeps existing data visible and adds the same phase/timer below
the toolbar.

`StatsGenerationRunner` is the single main-process path for React `stats:data` and
`debug:generate-stats`. Concurrent callers join one data job. Progress JSON is framed from drained
stdout and sent only to the calling renderer/request id. The runner uses a 120-second inactivity
watchdog and a 15-minute absolute cap.

## Constraints

- The Codex JSONL format is observed local CLI behavior, not a promised public storage API. Parsing
  must remain tolerant and fixture-tested.
- Project labels intentionally retain the existing basename behavior. Codex sessions also keep the
  full cwd as `projectPath`.
- Demo generation must set both `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; otherwise a demo refresh could
  read the real user's local histories.
- Account quota/rate-limit collection belongs to the agent-aware status-bar subsystem, not this
  transcript report.

Key entry points: `app-stats/generate-stats.ts`, `app-stats/claudeUsageLoader.ts`,
`app-stats/codex-usage-loader.ts`, `app-electron/src/main/statsGenerationRunner.ts`,
`app-stats/stats-view.ts`, `core/pricing.ts`, `core/types/stats.ts`, and the React usage panel.
