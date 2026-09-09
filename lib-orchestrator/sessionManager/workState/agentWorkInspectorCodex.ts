import type {
  AgentWorkEvidence,
  AgentWorkEvidenceSource,
  AgentWorkFrame,
  AgentWorkInspection,
} from './agentWorkInspector.types'
import { ScreenTail } from './screenTail'

/**
 * Codex's screen, classified. The working row comes from AppJamat (V1)'s
 * `core/agents/codex/agentWorkDetectorCodex.ts`; current spinner phases and the background-terminal
 * forms are admitted by AppJamatV3 recordings. Every work pattern reads the rendered screen alone
 * and survives wrapping because its `\s` classes span the breaks the terminal put in it. **Every
 * pattern here names the corpus case that admits it**, and one written from memory ships never.
 *
 * **The ring is never read for what a session is DOING** *(2026-08-20)*. The rule was bought on the
 * Claude side by a frame whose screen was an empty prompt while its ring still held the tail of the
 * finished turn; it holds here for the same reason and is now one rule rather than two. It costs
 * nothing measurable: every working fixture carries the row on screen as well, and the one live
 * recording, `codex-live-working.json`, carries it ONLY there - the ring had already churned past
 * it, so the raw read was not even holding the live case.
 *
 * **Absence of a recognized status is still `unknown`, but absence is no longer all there is**
 * *(2026-08-20)*.
 * The rule used to read "Codex publishes no layout that means finished and waiting for you", and it
 * was true of the build V1 knew. This one closes a turn with a rule saying `Worked for 45m 12s` and
 * an input box reading `Ask Codex to do anything`, which is that layout exactly - so a finished
 * Codex session says so, and its row stops drawing a question mark it could never leave. What has
 * not changed is the refusal to read a fact out of an absence: a screen with neither a live status
 * nor the empty prompt is `unknown`, and the monitor is still the one that concludes idle from
 * silence.
 *
 * V1's third signal is deliberately not here. It treated any non-empty raw output as activity, which
 * was true of a stream that had just delivered it and is false of a rolling tail that merely still
 * holds it. Whether output is new is a question `outputSeq` answers exactly, and the monitor asks it.
 */
export class AgentWorkInspectorCodex {
  /**
   * The marker glyph is a CLASS. Codex 0.148.0 animates the row through `◦` and `•`, proven by
   * `codex-live-working.json` and `codex-live-working-bullet.json`. The optional suffix is the same
   * build with a yielded terminal, recorded in `codex-live-working-background-terminal.json`; the
   * terminal may clip that suffix with an ellipsis after its exact counter.
   * Visual gaps may be xterm cursor-forward commands and disappear when ANSI is stripped, so the
   * fixed words do not require whitespace between them.
   */
  private static readonly workingScreenConst =
    /(?:^|\n)\s*[›❯>◦•]\s*working\s*\(\s*(?:\d+\s*(?:h|m|s)\s*)+[•·]\s*esc\s*to\s*interrupt\s*\)(?:\s*[•·]\s*\d+\s*background\s*terminals?\s*running(?:\s*[•·]\s*\/ps\s*to\s*view\s*[•·]\s*\/stop\s*to\s*close|[^\n]*…))?\s*(?:\n|$)/i
  /**
   * A foreground turn can finish while its yielded terminal continues. Codex then replaces
   * `Working` with this status, and the current screen remains authority for as long as it stands.
   * `codex-live-background-terminal.json` admits the full structure. At 103 columns Codex 0.150.1
   * clips the navigation suffix with an ellipsis, recorded in
   * `codex-live-background-terminal-narrow.json`; both forms still require the exact counter, which
   * keeps the prose collision beside them from matching.
   */
  private static readonly backgroundTerminalScreenConst =
    /(?:^|\n)\s*[›❯>◦•]\s*waiting\s*for\s*background\s*terminal\s*\(\s*(?:\d+\s*(?:h|m|s)\s*)+[•·]\s*esc\s*to\s*interrupt\s*\)\s*[•·]\s*\d+\s*background\s*terminals?\s*running(?:\s*[•·]\s*\/ps\s*to\s*view\s*[•·]\s*\/stop\s*to\s*close|[^\n]*…)\s*(?:\n|$)/i
  /**
   * The empty input box, which is Codex saying it is waiting for a person rather than working.
   * Admitted by `codex-live-idle.json`. It is deliberately the placeholder text and not the `›`
   * marker: the marker is drawn whatever the box holds, and a box with something typed in it is
   * not this state.
   */
  private static readonly emptyPromptConst = /askcodextodoanything/
  /**
   * Codex's approval prompt. The array was empty until 2026-08-20 for the reason this file exists
   * to enforce: no frame of one had ever been captured, and a pattern written from memory is a
   * guess about somebody else's TUI. `codex-live-approval.json` is that frame, and it took `-a
   * untrusted` to produce - Codex approves inside its own sandbox without asking, so an ordinary
   * session never shows this screen.
   *
   * Both patterns are structural rather than wording: the marker plus the first option, and the
   * confirm footer. Between them they survive a reworded option list.
   */
  private static readonly approvalConst: readonly RegExp[] = [
    /[›❯>◦]\d+\.yes,proceed/,
    /pressentertoconfirmoresctocancel/,
  ]

  static inspect(frame: AgentWorkFrame): AgentWorkInspection {
    const prompt: AgentWorkEvidence[] = []
    for (const [source, text] of AgentWorkInspectorCodex.normalizedWindows(frame))
      for (const pattern of AgentWorkInspectorCodex.approvalConst) {
        const match = text.match(pattern)?.[0]
        if (match) prompt.push({ source, signal: 'approvalPrompt', match })
      }
    // The same rule the Claude side bought on 2026-08-20, and the reason it is one rule rather than
    // two: a real prompt is drawn at the bottom, by the input box, so it always leaves something in
    // the SHALLOW window. An answered one scrolls up into the wide window and sits in the ring long
    // after. Deciding `blocked` from those alone pins the row on "a person has to answer" with
    // nothing left to un-pin it - `settleDue` only re-inspects a session whose activity is
    // `working`, and an answered prompt has stopped producing output. The wider windows still ride
    // along as evidence; they just cannot be the whole case.
    if (prompt.some((item) => item.source === 'screen')) return { hint: 'blocked', evidence: prompt }

    const backgroundTerminal = ScreenTail.stripAnsiLower(frame.screenTail)
      .match(AgentWorkInspectorCodex.backgroundTerminalScreenConst)?.[0]
    if (backgroundTerminal)
      return {
        hint: 'background',
        evidence: [{ source: 'screen', signal: 'backgroundTerminal', match: backgroundTerminal.trim() }],
      }

    const screen = ScreenTail.stripAnsiLower(frame.screenTail)
      .match(AgentWorkInspectorCodex.workingScreenConst)?.[0]
    if (screen)
      return { hint: 'working', evidence: [{ source: 'screen', signal: 'workingRow', match: screen.trim() }] }
    const wideScreen = ScreenTail.stripAnsiLower(frame.wideScreenTail)
      .match(AgentWorkInspectorCodex.workingScreenConst)?.[0]
    if (wideScreen)
      return {
        hint: 'working',
        evidence: [{ source: 'wide-screen', signal: 'workingRow', match: wideScreen.trim() }],
      }

    // After the background and working rows, never before them: Codex draws the input box under a
    // live status, so the placeholder remains on screen while it is working.
    const emptyPrompt = ScreenTail.normalizeTty(frame.screenTail)
      .match(AgentWorkInspectorCodex.emptyPromptConst)?.[0]
    if (emptyPrompt)
      return { hint: 'idle', evidence: [{ source: 'screen', signal: 'emptyPrompt', match: emptyPrompt }] }
    return { hint: 'unknown', evidence: [] }
  }

  /** Screen first, ring last: a prompt is on the screen long after the ring has churned past it. */
  private static normalizedWindows(
    frame: AgentWorkFrame,
  ): readonly (readonly [AgentWorkEvidenceSource, string])[] {
    return [
      ['screen', ScreenTail.normalizeTty(frame.screenTail)],
      ['wide-screen', ScreenTail.normalizeTty(frame.wideScreenTail)],
      ['raw', ScreenTail.normalizeTty(frame.rawTail)],
    ] as const
  }
}
