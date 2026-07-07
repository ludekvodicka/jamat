/**
 * Claude Code TUI output patterns. Used by the renderer's turn-indicator
 * state machine (`useTerminal.ts`) to classify what the agent is doing
 * right now. Migrated from inline literals in `useTerminal.ts:243-252`
 * so the renderer reads them via the adapter and the patterns live
 * next to the rest of the Claude-specific code.
 */

/**
 * Tool-call marker — Claude Code prints this glyph when invoking a
 * tool (Read, Write, Edit, Bash, etc.). Match → indicator goes
 * 'tool-use' for ~3s.
 */
export const CLAUDE_TOOL_USE_PATTERN: RegExp =
  /⏺ (Read|Write|Edit|MultiEdit|Bash|Glob|Grep|Task|NotebookEdit|WebFetch|WebSearch|TodoWrite)\(/

/**
 * Blocked-prompt patterns — Claude Code prints these when it needs the
 * user to confirm a tool invocation. ANY match → indicator goes
 * 'blocked' (red). Detected immediately on the data chunk that brings
 * them in, not on the 15s silence timer.
 */
export const CLAUDE_BLOCKED_PATTERNS: readonly RegExp[] = [
  /Do you want to (proceed|continue)/i,
  /\[y\/n\]/i,
  /Run \d+ shell command/i,
  /Press Enter to (continue|confirm)/i,
  /Allow this action\?/i,
  /❯ \d+\.\s+Yes\b/i, // Claude Code's arrow-key confirm menu (\b avoids matching "Yesterday")
]

/**
 * Collapse a raw TUI chunk to a match-friendly form: strip ANSI escape sequences
 * and ALL whitespace, then lowercase. Claude's TUI redraws its status line with
 * cursor/color escapes interspersed through the text and wraps it at the terminal
 * width, so the busy / question-menu markers below must be matched against this
 * collapsed form — never the raw bytes. (The old raw `/esc to interrupt/i` test
 * intermittently missed a working turn, so the tab dot fell back to idle/grey while
 * Claude was still generating.) The AI-bridge scenarios already normalized this way;
 * this is the single shared source.
 */
export function normalizeTty(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+/g, '').toLowerCase()
}

/**
 * Lighter normalization: strip ANSI + lowercase, but KEEP whitespace. Used for the spinner-glyph
 * marker, whose whole signal is the structural "<glyph> <single-word>…" (one space-separated token
 * then an ellipsis). Collapsing whitespace (normalizeTty) destroys that — "* install the deps…"
 * would collapse to "*installthedeps…" and look identical to the spinner "* Spinning…". On the
 * space-preserved form, a multi-word line ("* install the deps first") has a SPACE after the first
 * word, not the "…", so it correctly doesn't match. The spinner's "<glyph> <word>…" never wraps
 * (it's short), so keeping newlines/spaces here is safe (unlike "esc to interrupt", which can wrap
 * and therefore needs the fully-collapsed form).
 */
export function stripAnsiLower(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').toLowerCase()
}

/**
 * Per-signal "actively working" markers, each matched against `normalizeTty()` output (no spaces,
 * no ANSI, lowercased). Claude's TUI status line varies wildly by phase, so NO single marker is
 * always present — the classifier ORs them all (`CLAUDE_BUSY_PATTERN`), and `matchBusy()` reports
 * WHICH fired (for diagnostics / callers that want the breakdown). Each marker, and the
 * phase where it's the ONLY one present:
 *   • escToInterrupt — the "esc to interrupt" hint. Wraps / scrolls off-screen on a narrow terminal.
 *   • tokenCounter — "↓ 8.6k tokens" / "↑ 1.2k" / "4,234 tokens". ABSENT whenever no tokens flow:
 *     extended thinking, compaction, a long tool/network wait.
 *   • elapsedDot — the elapsed timer WITH a trailing "·": "(5m55s·". The "·" keeps it off prose
 *     "(5s)", but it misses the bare "(45s)" with nothing after.
 *   • elapsedEllipsis — the elapsed timer right after the spinner word's "…": "…(1m8s". Catches
 *     compaction ("Compacting conversation… (45s)") and narrow-wrap where only "(elapsed)" survives.
 *     Anchored on "…(" so prose "(5s)" can't match.
 *   • spinnerGlyph — the cycling spinner glyph + word + "…": "✻spinning…", "·hashing…". The
 *     LAST-RESORT marker for "thinking with xhigh effort" — "✻ Spinning… (8s · thinking with xhigh
 *     effort)" has no token counter and no esc hint — and for the first frame "· Spinning…" with no
 *     parens at all. The glyph cycles (· ✢ ✳ ✶ ✷ ✻ ✽ ∗ …), so we match the SET; the trailing "…"
 *     (right after the word) keeps it off the "·" used as the status-line separator and off prose.
 * The markers' COLLECTIVE absence is the turn-finished signal → fast idle edge (~1.2s) instead of
 * waiting out the 15s silence fallback.
 */
/** The 4 markers matched against the WHITESPACE-COLLAPSED tail (`normalizeTty`) — they can wrap
 *  across the terminal width, so the collapsed form is what reliably reassembles them. */
export const BUSY_SIGNALS_COLLAPSED = {
  escToInterrupt: /esctointerrupt/,
  tokenCounter: /[↑↓][\d.,]+k?tokens/,
  elapsedDot: /\(\d+[hms](?:\d+[ms])*·/,
  elapsedEllipsis: /(?:…|\.\.\.)\(\d+[hms]/,
} as const

/**
 * The spinner-glyph marker, matched against the SPACE-PRESERVED tail (`stripAnsiLower`). Claude's
 * spinner is always "<glyph> <one-word>…" — a cycling glyph (· * ✢ ✳ ✶ ✷ ✻ ✽ ∗ …), one space, a
 * SINGLE word (no internal spaces), then the ellipsis. That structure is the signal: requiring a
 * lone word immediately followed by "…" rejects prose/markdown bullets ("* install the deps first"
 * has a space after the first word, not "…"), which is why we can safely include the ASCII "*" and
 * the middle dot "·" here even though they're common characters. It's the ONLY marker present for
 * the first frame "· Spinning…" (no parens yet) and during "thinking with xhigh effort" alongside
 * the elapsed timer. The leading "(?:^|\s)" keeps a mid-token "*"/"·" from anchoring it.
 */
export const CLAUDE_BUSY_SPACED_PATTERN: RegExp =
  /(?:^|\s)[·*✦✧✶✷✸✹✺✻✼✽✢✣✤✥✱✲✳✴✵∗]\s+[a-z]+(?:…|\.\.\.)/i

/** Every busy marker's name, collapsed ones first then the spaced spinner glyph. Defines the
 *  `matchBusy` report shape (and any diagnostic row order built from it). */
export const BUSY_SIGNAL_NAMES = [
  ...(Object.keys(BUSY_SIGNALS_COLLAPSED) as (keyof typeof BUSY_SIGNALS_COLLAPSED)[]),
  'spinnerGlyph',
] as const
export type BusySignalName = (typeof BUSY_SIGNAL_NAMES)[number]

/**
 * Union of the COLLAPSED busy markers — the agent `ttyPatterns.busy` regex, tested against
 * `normalizeTty()` output. The spinner glyph is a SEPARATE pattern (`ttyPatterns.busySpaced`,
 * tested against `stripAnsiLower`) because it needs whitespace preserved; the classifier ORs the
 * two. Built from `BUSY_SIGNALS_COLLAPSED` so it can't drift from the breakdown `matchBusy` reports.
 */
export const CLAUDE_BUSY_PATTERN: RegExp = new RegExp(
  Object.values(BUSY_SIGNALS_COLLAPSED).map((r) => r.source).join('|'),
  'i',
)

/**
 * The HIGH-SPECIFICITY subset of the collapsed busy markers — the two elapsed-timer forms
 * (`elapsedDot` "(1h25m33s·" and `elapsedEllipsis` "…(45s"). Both are anchored so tightly on the
 * timer shape that they essentially never occur in prose or code, which makes them safe to scan
 * against a DEEPER screen tail than the ambiguous markers (`spinnerGlyph` looks like a markdown
 * bullet; `escToInterrupt` / `tokenCounter` can appear in displayed content). The classifier uses
 * this to keep catching Claude's spinner status line during long "thinking with xhigh effort" turns,
 * when a rotating "Tip:" line + the bordered input box push that line ABOVE the shallow status
 * window — otherwise the tab flickered idle↔running and the context-fullness nudge blinked on/off.
 * Built from the same `BUSY_SIGNALS_COLLAPSED` entries so it can't drift from them.
 */
export const CLAUDE_BUSY_WIDE_PATTERN: RegExp = new RegExp(
  [BUSY_SIGNALS_COLLAPSED.elapsedDot, BUSY_SIGNALS_COLLAPSED.elapsedEllipsis].map((r) => r.source).join('|'),
  'i',
)

/** Per-signal result: the exact text each marker matched, or null if it didn't fire. */
export interface BusyReport {
  busy: boolean
  signals: Record<BusySignalName, string | null>
}

/**
 * Run every busy marker against a raw TUI tail and report which fired + the matched text. Computes
 * BOTH normalized forms internally (collapsed for the 4 status-line markers, space-preserved for the
 * spinner glyph), so callers just pass whatever raw/ANSI text they have. The classifier only needs
 * `.busy`; the full per-signal breakdown is there for diagnostics.
 */
export function matchBusy(raw: string): BusyReport {
  const spaced = stripAnsiLower(raw)
  const collapsed = spaced.replace(/\s+/g, '')
  const signals = {} as Record<BusySignalName, string | null>
  let busy = false
  for (const [name, re] of Object.entries(BUSY_SIGNALS_COLLAPSED) as [BusySignalName, RegExp][]) {
    const m = collapsed.match(re)
    signals[name] = m ? m[0] : null
    if (m) busy = true
  }
  const glyph = spaced.match(CLAUDE_BUSY_SPACED_PATTERN)
  signals.spinnerGlyph = glyph ? glyph[0].trim() : null
  if (glyph) busy = true
  return { busy, signals }
}

/**
 * Interactive selection menu — Claude renders a numbered option list for AskUserQuestion
 * and the ExitPlanMode approval prompt. Match (against `normalizeTty()` output) → the turn
 * paused for the user to PICK something, so the tab goes 'waiting' (needs interaction)
 * instead of plain idle. The y/n permission dialogs stay in CLAUDE_BLOCKED_PATTERNS
 * (checked first → 'blocked'/red); this only catches the softer "answer my question" menus.
 *
 * Alternatives, because the menu footer/glyphs changed across Claude Code versions. All anchor on
 * the navigation FOOTER (the stable signal — never appears in prose/code), NOT on the option markers
 * (`[ ]` collides with markdown checkboxes, `>N.` with blockquote lists):
 *   • `arrowkeystonavigate` — the CURRENT AskUserQuestion footer "Enter to select · Tab/Arrow keys
 *     to navigate · Esc to cancel". This menu uses plain `>` / `[ ] Header` chips + a horizontal
 *     "√ Submit" pill and NO ↑/↓ glyphs, so the two older anchors below both miss it and the tab
 *     fell back to idle (→ even a false "Claude finished" popup). "arrow keys to navigate" is the
 *     unambiguous part of its footer.
 *   • `esctocancel` — the same footer's "Esc to cancel"; a second independent anchor for that menu.
 *   • `↑/↓ to navigate` — an earlier footer that used the ↑/↓ glyphs.
 *   • `❯<n>.` — the oldest arrow-marked menu, kept for backward compatibility.
 */
export const CLAUDE_QUESTION_MENU_PATTERN: RegExp =
  /arrowkeystonavigate|esctocancel|↑\/↓tonavigate|❯\d+\./

/**
 * Tool names whose `tool_use` block represents a file edit. Used by the
 * JSONL parser to decide which turns to record file changes for.
 *
 * Adding `MultiEdit` here would treat it like Edit. Other tool names
 * (`Read`, `Bash`, `Glob`, `Grep`, `Task`, `WebFetch`, `WebSearch`,
 * `TodoWrite`) are recognized for the turn-indicator state machine
 * (`CLAUDE_TOOL_USE_PATTERN` above) but NOT surfaced as file edits in
 * the SessionChanges panel / RecentFiles overlay.
 */
export const CLAUDE_EDITED_FILE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit'])
