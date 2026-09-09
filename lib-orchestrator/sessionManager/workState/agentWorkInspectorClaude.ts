import type {
  AgentWorkEvidence,
  AgentWorkEvidenceSource,
  AgentWorkFrame,
  AgentWorkInspection,
} from './agentWorkInspector.types'
import { ScreenTail } from './screenTail'

/**
 * Claude's screen, classified. **Every pattern names the corpus case that admits it** - a recorded
 * frame under `fixtures/`, a sanitized V1 case, or a wording case carrying its own retire trigger.
 * A pattern with no case does not ship. This replaces the commitment the file used to carry, that
 * V1's patterns were kept unchanged because they were evidence about somebody else's TUI: they were
 * evidence about V1's TUI, and it moved. The screens that proved it are
 * `claude-live-plan-approval.json` and `claude-live-question-menu.json`.
 *
 * Two things the recordings settled, and the prompt family is built on both:
 *
 * - **A prompt is a state of the SCREEN, not an event in the stream.** The blocking prompt used to
 *   be read from `rawTail` alone, so a person answering a menu while the ring churned past its
 *   footer was classified idle with the menu still in front of them. The three windows are now read
 *   in the order screen, wide screen, raw.
 * - **Only `normalizeTty` output is matched.** A repaint writes `ESC[1C` where a person sees a
 *   space, in the raw stream and in the serialized screen alike, so a prompt pattern carrying a
 *   literal space or `\s` is a lottery. Every pattern below is whitespace-free and lowercase, and
 *   the selection marker is a class - one build drew `>` where another drew `❯`, and a running
 *   agent keeps the binary it started with.
 *
 * The same then took the busy and tool families, on 2026-08-20, and the frame that settled it is
 * worth writing down. A session sat at an empty prompt with a background sub-agent still running.
 * Its screen carried no busy marker at all; its raw ring still held the tail of the last turn,
 * `hullaballooing... running stop hook - 2m23s - down-arrow 7.2k tokens`, and `tokenCounter`
 * matched it. So the classifier answered `working` off HISTORY. The monitor's settle rule could not
 * catch it either: that rule ages evidence by when output last ARRIVED, and the sub-agent kept
 * arriving, so a dead marker in the ring counted as live work for as long as anything at all was
 * printing. The row went green for fifteen seconds after every background breath, dropped back to
 * idle, and each drop was read as a turn finishing and raised an attention mark on a session
 * nobody had left.
 *
 * **So no family reads the ring for what a session is DOING.** V1 had the same problem and answered
 * it with a `settled` inspection mode that dropped the raw window; there are no modes here, the
 * window is simply not read for work. The prompt family still reads it, because a prompt that is on
 * screen and also in the ring is the same prompt, and the ring only ever adds reach. Work is the
 * opposite: the ring is where finished work goes to be remembered. The cost is at most one poll of
 * latency on the green glyph, against a false green and a false mark on every idle session that
 * has ever worked.
 *
 * The order of the questions is the priority: a prompt that blocks the turn outranks a menu, a menu
 * outranks a tool line, and only when none of them is on screen does the busy evidence decide.
 */
export class AgentWorkInspectorClaude {
  private static readonly toolUseConst =
    /⏺(read|write|edit|multiedit|bash|glob|grep|task|notebookedit|webfetch|websearch|todowrite)\(/
  /**
   * `wouldyouliketoproceed` is the plan prompt's own wording, recorded. `doyouwantto(proceed|
   * continue)` was V1's, and on 2026-08-20 a recorded frame confirmed it:
   * `claude-live-permission-prompt.json` reads "Do you want to proceed?" over three options, so the
   * wording V1 shipped untested is now evidence rather than inheritance.
   *
   * The remaining three are still V1's, still normalized, and still carry their retire trigger:
   * that frame neither showed them nor contradicted them, so they keep their sanitized wording
   * cases until one does.
   */
  private static readonly blockedWordingConst = [
    /doyouwantto(proceed|continue)/,
    /wouldyouliketoproceed/,
    /\[y\/n\]/,
    /run\d+shellcommands?/,
    /pressenterto(continue|confirm)/,
    /allowthisaction\?/,
  ] as const
  /** The plan prompt's own footer. It never appears on an ordinary menu. */
  private static readonly planApprovalConst = [/shift\+tabtoapprove/] as const
  private static readonly selectedYesConst = /[>❯]\d+\.yes\b/
  /**
   * A menu is waiting for a person. `ctrl+gtoedit` belongs here rather than with the plan prompt:
   * it is the hint of an open text field, and the live capture of 2026-08-19 shows it on an
   * ordinary question menu too. On the plan prompt it costs nothing, blocked outranking waiting.
   */
  private static readonly menuFooterConst = [
    /arrowkeystonavigate/,
    /↑\/↓tonavigate/,
    /esctocancel/,
    /entertoselect/,
    /ctrl\+gtoedit/,
  ] as const
  /**
   * The selected option row. It is the collision-prone signal and it never decides alone: a reply
   * quoting a menu normalizes to the same `>1.text`, and so does Claude's echo of a user message
   * that opens with a numbered list, which is drawn `> 1. opraveno.` and normalizes to `>1.`. See
   * `promptEvidence`.
   */
  private static readonly selectedRowConst = /[>❯]\d+\./
  /**
   * The two signals that are a menu ROW and nothing else. Both are collision-prone in the same way,
   * and `selectedYes` is the one that proved it: `claude-live-quoted-menu-collision.json` quotes an
   * approval menu verbatim, so a reply about a prompt read as the prompt itself until this list
   * existed. Everything not named here is wording or a footer, and corroborates.
   */
  private static readonly rowSignalsConst: readonly string[] = ['selectedRow', 'selectedYes']
  /**
   * Claude's background-task footer, read from the SHALLOW window only: the footer lives in the
   * status region, and it is the one signal whose END must be seen - the TUI erases it the moment
   * the tasks finish, and an erase leaves the old text behind in the ring, so a ring read would
   * hold a footer that is gone.
   *
   * **`↓ to manage` is the signal, and measurement is why.** Four frames recorded on 2026-08-20
   * separate cleanly: a session with a background shell and a session with a running sub-agent both
   * carry it, a finished turn and a permission prompt carry neither. `ctrl+t to hide tasks` is the
   * older build's wording of the same hint, and the shell counter is kept beside them because it
   * says the same thing in a third way.
   *
   * **What is NOT here is the lesson.** The obvious-looking `· ← N agents` counts nothing: it is
   * drawn on every session, including one with an empty prompt and nothing running, so a signal
   * built on it would paint every Claude session green for ever. The running sub-agent shows up as
   * a strip under the footer instead (`● main ◯ general-purpose …`), and `↓ to manage` already
   * covers that frame, so the strip needs no pattern of its own.
   *
   * The shell counter carries a closing boundary because its collision is a transcript line:
   * `Baked for 1m 1s · 2 shells still running` normalizes to `·2shellsstillrunning`, while every
   * real footer carries a next segment (`·1shell·/taskstoseesubagents`).
   */
  private static readonly backgroundTasksConst = [
    /↓tomanage/,
    /ctrl\+ttohidetasks/,
    /·\d+shells?(?=·|$)/,
  ] as const
  private static readonly busyCollapsedConst = [
    { signal: 'escToInterrupt', pattern: /esctointerrupt/ },
    { signal: 'tokenCounter', pattern: /[↑↓][\d.,]+k?tokens/ },
    { signal: 'elapsedDot', pattern: /\(\d+[hms](?:\d+[ms])*·/ },
    { signal: 'elapsedEllipsis', pattern: /(?:…|\.\.\.)\(\d+[hms]/ },
  ] as const
  /**
   * The wide window is read for these two only: no reply text carries an elapsed timer. Selected out
   * of the list above by NAME rather than copied, so one pattern has one home: a recorded frame that
   * moves the elapsed timer used to be fixed in one copy, and the failure then showed only on a
   * session whose input box had pushed the timer out of the shallow window.
   */
  private static readonly wideSignalsConst = ['elapsedDot', 'elapsedEllipsis'] as const
  private static readonly busyWideConst = AgentWorkInspectorClaude.busyCollapsedConst
    .filter((item) => (AgentWorkInspectorClaude.wideSignalsConst as readonly string[])
      .includes(item.signal))
  private static readonly busySpacedConst =
    /(?:^|\s)[·*✦✧✶✷✸✹✺✻✼✽✢✣✤✥✱✲✳✴✵∗]\s+[a-z]+(?:…|\.\.\.)/i

  static inspect(frame: AgentWorkFrame): AgentWorkInspection {
    const prompt = AgentWorkInspectorClaude.promptEvidence(frame)
    if (prompt.blocked.length) return { hint: 'blocked', evidence: prompt.blocked }
    if (prompt.waiting.length) return { hint: 'waiting', evidence: prompt.waiting }

    // Before tool-use and busy: the green families differ only in how they age, and a quiet tool
    // line or a dead busy marker beside a live footer must not be what decides the row.
    const background: AgentWorkEvidence[] = []
    const shallow = ScreenTail.normalizeTty(frame.screenTail)
    for (const pattern of AgentWorkInspectorClaude.backgroundTasksConst)
      AgentWorkInspectorClaude.addEvidence(
        background, 'screen', 'backgroundTasks', shallow, pattern)
    if (background.length) return { hint: 'background', evidence: background }

    const tool: AgentWorkEvidence[] = []
    for (const [source, text] of AgentWorkInspectorClaude.screenWindows(frame))
      AgentWorkInspectorClaude.addEvidence(
        tool, source, 'toolUse', text, AgentWorkInspectorClaude.toolUseConst)
    if (tool.length) return { hint: 'tool-use', evidence: tool }

    const busy: AgentWorkEvidence[] = []
    AgentWorkInspectorClaude.addBusy(busy, 'screen', frame.screenTail)
    const wide = ScreenTail.normalizeTty(frame.wideScreenTail)
    for (const item of AgentWorkInspectorClaude.busyWideConst)
      AgentWorkInspectorClaude.addEvidence(busy, 'wide-screen', item.signal, wide, item.pattern)

    return { hint: busy.length ? 'working' : 'idle', evidence: busy }
  }

  /**
   * The one prompt pass, over all three windows, screen first. Everything it matches is normalized
   * text, which is the only form a repaint cannot break.
   *
   * The corroboration rule is the whole subtlety, and it has two halves that are asked in order.
   *
   * A prompt is drawn at the bottom, by the input box, so a real one always leaves something in the
   * SHALLOW window; text that merely quotes a prompt scrolls up out of it. Nothing above the
   * shallow window may decide on its own.
   *
   * And a selected row never decides on its own either, wherever it was seen. `[>❯]\d+\.` is not a
   * menu, it is a chevron in front of a number, and Claude draws one in front of every user message
   * it echoes: a message opening `1. opraveno.` normalizes to exactly the same `>1.` as `❯1. Yes`.
   * The row therefore keeps its verdict only beside a footer or a wording signal. Every real prompt
   * in the corpus carries one - `claude-live-question-menu.json` its three footers,
   * `claude-live-permission-prompt.json` and `claude-live-plan-approval.json` their wording as well
   * - so nothing here rests on a bare row, and the two `*-collision.json` frames are the negatives.
   *
   * The shallow window used to be allowed to decide on a bare row, and until 2026-08-27 that looked
   * safe, because the shallow window was believed to hold the status region only. It did not: the
   * screen was cut into rows by its line breaks, and a serialized screen has none inside a wrapped
   * line, so on a session whose transcript was wider than the terminal the shallow window was the
   * whole screen. `ScreenTail` measures rows in cells now, and this half of the rule is what covers
   * the case that survives it - the echo sitting in the genuine bottom rows, seconds after a person
   * pressed enter on a numbered list.
   */
  private static promptEvidence(frame: AgentWorkFrame): {
    blocked: AgentWorkEvidence[]
    waiting: AgentWorkEvidence[]
  } {
    const windows = [
      ['screen', ScreenTail.normalizeTty(frame.screenTail)],
      ['wide-screen', ScreenTail.normalizeTty(frame.wideScreenTail)],
      ['raw', ScreenTail.normalizeTty(frame.rawTail)],
    ] as const
    const blocked: AgentWorkEvidence[] = []
    const waiting: AgentWorkEvidence[] = []
    for (const [source, text] of windows) {
      for (const pattern of AgentWorkInspectorClaude.blockedWordingConst)
        AgentWorkInspectorClaude.addEvidence(blocked, source, 'blockedPrompt', text, pattern)
      for (const pattern of AgentWorkInspectorClaude.planApprovalConst)
        AgentWorkInspectorClaude.addEvidence(blocked, source, 'planApproval', text, pattern)
      AgentWorkInspectorClaude.addEvidence(
        blocked, source, 'selectedYes', text, AgentWorkInspectorClaude.selectedYesConst)
      for (const pattern of AgentWorkInspectorClaude.menuFooterConst)
        AgentWorkInspectorClaude.addEvidence(waiting, source, 'menuFooter', text, pattern)
      AgentWorkInspectorClaude.addEvidence(
        waiting, source, 'selectedRow', text, AgentWorkInspectorClaude.selectedRowConst)
    }
    // On 2026-08-20 a session whose reply quoted a captured permission prompt verbatim - wording,
    // selected row and all - classified as being AT one. Evidence from the wider windows still
    // rides along, it just cannot be the whole case.
    const decided = [...blocked, ...waiting].some((item) => item.source === 'screen')
    if (!decided) return { blocked: [], waiting: [] }
    // On 2026-08-27 a working session drew the waiting diamond off its own echoed user message,
    // `> 1. opraveno.`, for as long as that message stayed on screen. A row is a shape, not a menu.
    const corroborated = [...blocked, ...waiting]
      .some((item) => !AgentWorkInspectorClaude.rowSignalsConst.includes(item.signal))
    if (!corroborated) return { blocked: [], waiting: [] }
    return { blocked, waiting }
  }

  /**
   * What a session is DOING is read here and only here: the rendered screen. Never the ring - see
   * the note above the class about the frame that proved it.
   */
  private static screenWindows(
    frame: AgentWorkFrame,
  ): readonly (readonly [AgentWorkEvidenceSource, string])[] {
    return [
      ['screen', ScreenTail.normalizeTty(frame.screenTail)],
      ['wide-screen', ScreenTail.normalizeTty(frame.wideScreenTail)],
    ] as const
  }

  private static addBusy(
    evidence: AgentWorkEvidence[],
    source: AgentWorkEvidenceSource,
    text: string,
  ): void {
    const collapsed = ScreenTail.normalizeTty(text)
    for (const item of AgentWorkInspectorClaude.busyCollapsedConst)
      AgentWorkInspectorClaude.addEvidence(evidence, source, item.signal, collapsed, item.pattern)
    AgentWorkInspectorClaude.addEvidence(
      evidence,
      source,
      'spinnerGlyph',
      ScreenTail.stripAnsiLower(text),
      AgentWorkInspectorClaude.busySpacedConst,
    )
  }

  private static addEvidence(
    evidence: AgentWorkEvidence[],
    source: AgentWorkEvidenceSource,
    signal: string,
    text: string,
    pattern: RegExp,
  ): void {
    const match = text.match(pattern)?.[0]
    if (match) evidence.push({ source, signal, match: match.trim() })
  }
}
