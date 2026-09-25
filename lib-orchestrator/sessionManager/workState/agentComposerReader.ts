import type { SessionAgentId, TerminalComposerState } from '../sessionManagerApi.types'
import type { AgentWorkFrame } from './agentWorkInspector.types'
import { ScreenTail } from './screenTail'

export interface AgentComposerReading {
  composer: TerminalComposerState
  queuedRow: boolean
  echoHead: string | null
  pastePlaceholders: number
  onlyPlaceholders: boolean
}

/** One row of the wide window, kept twice: styled for the placeholder test, plain for the text. */
interface ComposerRow {
  raw: string
  plain: string
}

/**
 * What an agent's input box holds, read from the WIDE window of one frame. It is a pure function of
 * the frame, exactly like the two work inspectors, and it follows their discipline: **every pattern
 * names the recorded fixture that admits it**, and a pattern written from memory ships never.
 *
 * The box is found by STRUCTURE, never by wording, because what a delivery must not do is type over
 * a dialog. An unknown layout therefore reads `absent`, which makes a caller wait rather than write.
 *
 * **A placeholder is recognised by its style, not its words.** Both agents draw it dimmed (SGR 2)
 * right after the marker, and a typed draft is never dimmed: `claude-live-queued-while-working.json`
 * ("Press up to edit queued messages"), `codex-live-idle.json` and `codex-live-after-enter.json`
 * ("Ask Codex to do anything") against `claude-live-composer-text.json` and
 * `codex-live-composer-text.json`. Codex rotates its placeholder wording, and a list of the
 * sentences would read the next one as a foreign draft.
 */
export class AgentComposerReader {
  /**
   * The rule drawn above and below Claude's box. A frame recorded before `ScreenTail` counted rows
   * in cells (`claude-live-idle.json`, 2026-08-19) carries the rule and the marker on ONE row, so a
   * rule with something after it is split back into the two rows it was.
   */
  private static readonly claudeRuleConst = /^─{8,}$/
  private static readonly ruleThenRowConst = /^((?:\x1b\[[0-9;]*m)*─{8,})((?:\x1b\[[0-9;]*m)*[^\x1b\s─].*)$/
  /**
   * `>` in the current build, `❯` in 2.1.235 (`claude-live-idle.json`). The current build follows
   * the marker with a NO-BREAK space (`claude-live-composer-text.json`), so `\s` rather than a space.
   */
  private static readonly claudeMarkerConst = /^[>❯](?:\s|$)/
  /**
   * The suggestion a freshly booted Claude shows in its empty box for about a second,
   * `Try "refactor <filepath>"` (`claude-live-composer-suggestion.json`). The one placeholder read by
   * its words: that recording carries no SGR at all, not even on the rule, so the style rule above
   * has nothing to see, and the cursor the serializer parks before the hint is also where a draft
   * edited from Home would put it. Normalized, and the whole box must be this one quoted sentence.
   */
  private static readonly claudeSuggestionConst = /^try"[^"]+"$/
  /** `claude-live-queued-while-working.json`: the hint under a queued message. */
  private static readonly claudeQueuedConst = /ctrl\+xctrl\+stosendnow/
  /** `claude-live-composer-pasted.json`: `[Pasted text #1 +14 lines]`, normalized. */
  private static readonly claudePastedConst = /\[pastedtext#\d+(?:\+\d+lines)?\]/g
  /** `codex-live-composer-text.json` and `codex-live-idle.json`: the box opens with `›`. */
  private static readonly codexMarkerConst = /^›(?:\s|$)/
  /**
   * The placeholder as words, for a frame that lost its styling: the sanitized one-line corpus
   * (`codex-compacting-context.json`) and the hand-trimmed `codex-live-background-terminal-narrow.json`.
   * The same wording `AgentWorkInspectorCodex.emptyPromptConst` admits from `codex-live-idle.json`.
   */
  private static readonly codexPlaceholderConst = /^askcodextodoanything$/
  /**
   * `codex-live-booting.json`: the update prompt Codex shows before its box draws its options with
   * the same `›`, as `› 1. Update now`. A numbered row under the marker is a menu, not a draft.
   */
  private static readonly codexMenuRowConst = /^\d+\.\s/
  /** `codex-live-composer-pasted.json`: `[Pasted Content 1129 chars]`, normalized. */
  private static readonly codexPastedConst = /\[pastedcontent\d+chars\]/g
  /**
   * `codex-live-queued-while-working.json`: the header over messages queued with Tab, a row of its
   * own as `• Queued follow-up inputs`. A message sent with Enter during a turn is a steer that Codex
   * echoes into the history instead, and draws no such row.
   */
  private static readonly codexQueuedConst = /^•queuedfollow-upinputs$/
  /** A wrapped or pasted continuation row is indented by two cells in both agents. */
  private static readonly continuationIndentConst = '  '
  /** The filler xterm's serializer writes to force a wrap, then backs over (see `ScreenTail`). */
  private static readonly wrapFillerConst = /[^\x1b]\x1b\[1D\x1b\[1X/g
  private static readonly cursorForwardConst = /\x1b\[(\d*)C/g
  private static readonly sgrAtConst = /\x1b\[([0-9;]*)m/y
  /** Every escape but SGR, which the placeholder test still needs. */
  private static readonly nonSgrEscapeConst = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-ln-~])/g
  private static readonly absentConst: AgentComposerReading = {
    composer: { state: 'absent' },
    queuedRow: false,
    echoHead: null,
    pastePlaceholders: 0,
    onlyPlaceholders: false,
  }

  static read(agentId: SessionAgentId, frame: AgentWorkFrame): AgentComposerReading {
    const rows = AgentComposerReader.rowsOf(frame.wideScreenTail)
    if (agentId === 'claude') return AgentComposerReader.claude(rows)
    else if (agentId === 'codex') return AgentComposerReader.codex(rows)
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  /**
   * Claude: the LAST row that opens with the marker, has a rule row directly above it and, after its
   * continuation rows, a rule row below. The trust dialog's `> No, exit` has no rule above it
   * (`claude-live-trust-dialog.json`), and an echoed `> text` has none below it
   * (`claude-live-after-enter.json`), so neither reads as the box.
   */
  private static claude(rows: readonly ComposerRow[]): AgentComposerReading {
    const isRule = (index: number): boolean =>
      AgentComposerReader.claudeRuleConst.test(rows[index]?.plain.trim() ?? '')
    for (let at = rows.length - 1; at > 0; at -= 1) {
      if (!AgentComposerReader.claudeMarkerConst.test(rows[at].plain) || !isRule(at - 1)) continue
      const end = AgentComposerReader.continuationEnd(rows, at)
      if (!isRule(end)) continue
      const read = AgentComposerReader.composerOf(rows, at, end)
      const composer: TerminalComposerState = read.state === 'text'
        && AgentComposerReader.claudeSuggestionConst.test(ScreenTail.normalizeTty(read.text))
        ? { state: 'empty' }
        : read
      return {
        composer,
        queuedRow: AgentComposerReader.claudeQueuedConst.test(
          ScreenTail.normalizeTty(rows.slice(0, at).map((row) => row.plain).join('\n'))),
        echoHead: AgentComposerReader.claudeEcho(rows, at - 1),
        pastePlaceholders: AgentComposerReader.placeholders(
          composer, AgentComposerReader.claudePastedConst),
        onlyPlaceholders: AgentComposerReader.onlyPlaceholders(
          composer, AgentComposerReader.claudePastedConst),
      }
    }
    return AgentComposerReader.absentConst
  }

  /**
   * Claude echoes each submitted message as `> text` above the box, and a queued one the same way
   * (`claude-live-after-enter.json`, `claude-live-queued-while-working.json`). The newest is the
   * lowest such row above the box's top rule.
   */
  private static claudeEcho(rows: readonly ComposerRow[], topRule: number): string | null {
    for (let index = topRule - 1; index >= 0; index -= 1) {
      const plain = rows[index].plain
      if (AgentComposerReader.claudeMarkerConst.test(plain) && plain.length > 2)
        return ScreenTail.normalizeTty(plain.slice(1))
    }
    return null
  }

  /**
   * Codex: the LAST row that opens with `›`. Codex echoes submitted messages with the same marker
   * (`codex-live-after-enter.json`), but its box is always drawn below them. The box ends at the
   * first row that is not an indented continuation, which is the blank row above its footer.
   */
  private static codex(rows: readonly ComposerRow[]): AgentComposerReading {
    for (let at = rows.length - 1; at >= 0; at -= 1) {
      if (!AgentComposerReader.codexMarkerConst.test(rows[at].plain)) continue
      if (AgentComposerReader.codexMenuRowConst.test(rows[at].plain.slice(1).trimStart()))
        return AgentComposerReader.absentConst
      const read = AgentComposerReader.composerOf(
        rows, at, AgentComposerReader.continuationEnd(rows, at))
      const composer: TerminalComposerState = read.state === 'text'
        && AgentComposerReader.codexPlaceholderConst.test(ScreenTail.normalizeTty(read.text))
        ? { state: 'empty' }
        : read
      return {
        composer,
        queuedRow: rows.slice(0, at).some((row) =>
          AgentComposerReader.codexQueuedConst.test(ScreenTail.normalizeTty(row.plain))),
        echoHead: null,
        pastePlaceholders: AgentComposerReader.placeholders(
          composer, AgentComposerReader.codexPastedConst),
        onlyPlaceholders: AgentComposerReader.onlyPlaceholders(
          composer, AgentComposerReader.codexPastedConst),
      }
    }
    return AgentComposerReader.absentConst
  }

  /** The index of the first row after the marker row that is not an indented continuation. */
  private static continuationEnd(rows: readonly ComposerRow[], at: number): number {
    let end = at + 1
    while (end < rows.length
      && rows[end].plain.startsWith(AgentComposerReader.continuationIndentConst)
      && rows[end].plain.trim() !== '') end += 1
    return end
  }

  private static composerOf(rows: readonly ComposerRow[], at: number, end: number): TerminalComposerState {
    const first = rows[at]
    const lead = first.plain.slice(1).trimStart()
    if (lead === '' || AgentComposerReader.dimmedAfterMarker(first.raw)) return { state: 'empty' }
    const continuation = rows.slice(at + 1, end)
      .map((row) => row.plain.slice(AgentComposerReader.continuationIndentConst.length))
    return { state: 'text', text: [lead, ...continuation].join('\n') }
  }

  /**
   * Whether the text after the marker starts in SGR 2. The colour forms `38;2;r;g;b` and `48;2;...`
   * carry a 2 that is not dim, so the parameters are walked rather than searched.
   */
  private static dimmedAfterMarker(raw: string): boolean {
    let dim = false
    let markerSeen = false
    let index = 0
    while (index < raw.length) {
      AgentComposerReader.sgrAtConst.lastIndex = index
      const match = AgentComposerReader.sgrAtConst.exec(raw)
      if (match !== null) {
        dim = AgentComposerReader.dimAfter(dim, match[1])
        index += match[0].length
      }
      else if (!markerSeen) {
        markerSeen = true
        index += 1
      }
      else if (/\s/.test(raw[index])) index += 1
      else return dim
    }
    return false
  }

  private static dimAfter(dim: boolean, parameters: string): boolean {
    const codes = parameters === '' ? [0] : parameters.split(';').map(Number)
    let result = dim
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]
      if (code === 38 || code === 48 || code === 58) index += codes[index + 1] === 5 ? 2 : 4
      else if (code === 0 || code === 22) result = false
      else if (code === 2) result = true
    }
    return result
  }

  private static placeholders(composer: TerminalComposerState, pattern: RegExp): number {
    if (composer.state !== 'text') return 0
    return ScreenTail.normalizeTty(composer.text).match(pattern)?.length ?? 0
  }

  /** A draft that is placeholders and nothing else, so no foreign text sits around a paste. */
  private static onlyPlaceholders(composer: TerminalComposerState, pattern: RegExp): boolean {
    return AgentComposerReader.placeholders(composer, pattern) > 0
      && composer.state === 'text'
      && ScreenTail.normalizeTty(composer.text).replace(pattern, '') === ''
  }

  /**
   * The wide window as rows with every non-SGR escape resolved: the wrap filler removed, a cursor
   * forward turned back into the spaces a person sees, and the rest stripped from the plain copy.
   */
  private static rowsOf(wideScreenTail: string): ComposerRow[] {
    const rows: ComposerRow[] = []
    for (const line of wideScreenTail.split('\n')) {
      const raw = line
        .replace(AgentComposerReader.wrapFillerConst, '')
        .replace(AgentComposerReader.cursorForwardConst, (_, count: string) => ' '.repeat(Number(count || '1')))
        .replace(AgentComposerReader.nonSgrEscapeConst, '')
      const split = raw.match(AgentComposerReader.ruleThenRowConst)
      const parts = split === null ? [raw] : [split[1], split[2]]
      for (const part of parts) rows.push({ raw: part, plain: ScreenTail.stripAnsi(part).trimEnd() })
    }
    return rows
  }
}
