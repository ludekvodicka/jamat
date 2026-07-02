/**
 * Correlation ids + the answer-marker convention (pure; node:crypto only).
 *
 * Terminal answers (S2/S5) are bracketed by two marker lines so the local AI can
 * locate the answer in noisy scrollback. Subtlety: the injected prompt is echoed
 * back into the terminal, so if it contained a complete OPEN…END pair the parser
 * would match the echo prematurely. We therefore print the OPEN marker literally
 * but DESCRIBE the END marker in prose — only the remote's real answer ever
 * contains the literal END marker, so `lastIndexOf(END)` is unambiguous.
 */

import { randomBytes } from 'node:crypto'

export function makeCorrId(): string {
  return `abr-${randomBytes(6).toString('hex')}`
}

// The answer marker must survive TWO independent manglings by Claude's TUI, which renders
// the remote answer (markdown → ANSI) before it reaches the PTY byte ring we scan:
//   1. Markdown tag-stripping — `<…>` reads as an HTML tag and gets DROPPED, so the old
//      `<<<JAMAT-ANSWER id>>>` arrived as a bare `<<>>`. Fix: triple SQUARE brackets
//      `[[[ … ]]]` have no markdown tag/link meaning → emitted verbatim.
//   2. Space → cursor-move — the TUI's screen diff often renders an interior SPACE as a
//      cursor-forward escape (`\x1b[1C`) instead of a literal space, so `[[[JAMAT-END id]]]`
//      arrived as `[[[JAMAT-END\x1b[1Cid]]]` and a literal match failed (→ the delegate hung
//      to the quiet-heuristic timeout). Fix: the marker has NO interior space — `corrId` follows
//      a COLON, making the whole marker one contiguous, space-free token the diff won't split.
// parseTerminalAnswer also strips CSI escapes before matching as belt-and-suspenders.
const openMarker = (corrId: string): string => `[[[JAMAT-ANSWER:${corrId}]]]`
const endMarker = (corrId: string): string => `[[[JAMAT-END:${corrId}]]]`

/** Strip CSI escapes (colour `\x1b[…m`, cursor moves `\x1b[1C`/`\x1b[19;3H`, clears `\x1b[K`)
 *  that Claude's TUI interleaves into the PTY stream — so a literal marker match isn't broken
 *  by an escape landing mid-token and the extracted answer comes back clean. */
function stripCsi(s: string): string {
  // A cursor-forward (CUF, `\x1b[<n>C`) is how Claude's TUI usually renders a run of spaces
  // (move the cursor over blank cells rather than writing them), so turn it BACK into spaces —
  // else a multi-word answer comes back word-glued ("ThecapitalisParis"). Every OTHER CSI
  // (colour, absolute positioning `\x1b[r;cH`, line-clear `\x1b[K`) carries no text → drop it.
  return s
    .replace(/\x1b\[(\d*)C/g, (_m: string, n: string) => ' '.repeat(Math.min(parseInt(n || '1', 10), 200)))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

// IMPORTANT: every injected prompt below is a SINGLE line (no `\n`). A multi-line
// string injected via write-keys lands in the Claude REPL as a multi-line paste
// buffer and the trailing Enter does NOT submit it — it just sits in the input.
// So the instruction is one line; the remote still prints the markers on their own
// lines in its ANSWER (parseTerminalAnswer only needs the literal strings to appear).
// Anything genuinely multi-line (a real task body) is delivered as a file, not keys
// (see the terminal-task scenario + `buildTerminalTaskRef`).

/** The S2/S5 prompt (single line): the task + how to bracket the answer. */
export function buildTerminalTask(task: string, corrId: string): string {
  return `[JAMAT TASK ${corrId}] ${task} — When done, print on its own line the start marker ${openMarker(corrId)}, then your answer, then on its own line the end marker (the same triple-square-bracket form but with END in place of ANSWER and the same id ${corrId}).`
}

/** The file-drop variant of the S2 prompt for LARGE tasks: the task text lives in a
 * local file the bridge dropped on this machine (avoiding the 4 KB keystroke cap +
 * multi-line paste hazards). Short enough to inject; same answer-marker convention. */
export function buildTerminalTaskRef(filePath: string, corrId: string): string {
  const answerPath = filePath.replace(/\.md$/, '.answer.md')
  return `[JAMAT TASK ${corrId}] Your task is in this local file: ${filePath} — read it and do what it asks. When done, EITHER (preferred) write your answer to ${answerPath}, OR print on its own line ${openMarker(corrId)} then your answer then on its own line the end marker (the same triple-square-bracket form but with END in place of ANSWER and the same id ${corrId}).`
}

/** The S1 prompt (single line): point the remote AI at an issue-tracker issue + where to answer. */
export function buildIssueTask(repo: string, issue: number, corrId: string): string {
  return `[JAMAT TASK ${corrId}] An issue needs your attention: ${repo} #${issue}. Read it and do the work it asks for using your issue-tracker skill, then post your answer as a comment on that issue, beginning with this exact line: ${issueAnswerMarker(corrId)}`
}

/** S4 notify: a one-way message, clearly tagged as bridge-originated. */
export function buildNotify(message: string, corrId: string): string {
  return `[JAMAT NOTE ${corrId}] ${message}`
}

/** Marker line a remote answer-comment must start with (S1). */
export function issueAnswerMarker(corrId: string): string {
  return `<!-- jamat-answer:${corrId} -->`
}

/**
 * Extract a terminal answer bracketed by the markers, or null if not finished
 * yet. Anchors on the LAST END marker (only the real answer prints it) and the
 * OPEN marker just before it.
 */
export function parseTerminalAnswer(text: string, corrId: string): string | null {
  const clean = stripCsi(text) // immune to cursor-move/colour/clear escapes the TUI interleaves
  const open = openMarker(corrId)
  // Tolerant close marker: ANY `[[[ … ]]]` token carrying both END and this corrId (either
  // order). The canonical `[[[JAMAT-END:id]]]` matches, and so does a model that mis-formats
  // it as `[[[JAMAT-ANSWER:id:END]]]` (observed live) — both close the answer cleanly instead
  // of timing out. The OPEN marker (corrId but no END) never matches, so it's not mistaken for a
  // close. Anchors on the LAST such token, then the OPEN just before it (last complete pair wins).
  const id = corrId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const endRe = new RegExp(`\\[\\[\\[[^\\]]*?(?:END[^\\]]*?${id}|${id}[^\\]]*?END)[^\\]]*?\\]\\]\\]`, 'g')
  let lastEnd: RegExpExecArray | null = null
  for (let m = endRe.exec(clean); m; m = endRe.exec(clean)) lastEnd = m
  if (!lastEnd) return null
  const ei = lastEnd.index
  const oi = clean.lastIndexOf(open, ei)
  if (oi === -1) return null
  return clean.slice(oi + open.length, ei).trim()
}
