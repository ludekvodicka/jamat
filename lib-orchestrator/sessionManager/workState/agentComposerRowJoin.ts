import type { SessionAgentId } from '../sessionManagerApi.types'

/**
 * How the rows of a draft go back together. Both agents wrap their box themselves and write every
 * row explicitly, so nothing on screen tells a wrap from a line the person broke, and the space a
 * wrap swallowed is gone. This decides each boundary from the row lengths alone, in a fixed order:
 * a blank row, Codex's break after a hyphen or a slash, a token longer than a row cut where the row
 * ended, a next word that would not have fitted, and otherwise a newline the person typed.
 *
 * **The error runs one way.** A width is counted in graphemes, a lower bound of the cells a row
 * takes, so a wide character makes a row look shorter than it is and keeps a newline rather than
 * inventing a join. A row filled almost to the edge and ended with Shift+Enter still joins with a
 * space: the accepted trade-off of reading a draft off the screen.
 */
export class AgentComposerRowJoin {
  /** Both agents draw a two-cell marker or indent in front of every draft row. */
  private static readonly gutterCellsConst = 2
  /**
   * A full row reaches `cols` minus this, gutter included: a token longer than a row is cut at 118
   * cells in `claude-live-composer-long-token-120.json` and at 78 in `-80.json`.
   */
  private static readonly claudeMarginConst = 2
  /** 119 cells in `codex-live-composer-long-token-120.json`, 79 in `-80.json`. */
  private static readonly codexMarginConst = 1
  /**
   * Where Codex breaks inside a token that does not fit: after a hyphen
   * (`codex-live-composer-wrapped.json`, `an-intentionally-long-` / `pointer-path`) and after a
   * slash (`codex-live-composer-long-token-80.json`, `fixture-notes/` / `aVeryLong...`). Claude
   * breaks after neither: `claude-live-composer-long-token-120.json` moves a hyphenated name that
   * fits a row to the next row whole, and `-80.json` cuts one longer than a row at the row's end.
   */
  private static readonly codexBreakAfterConst = /[-/]/
  private static readonly graphemesConst = new Intl.Segmenter('en', { granularity: 'grapheme' })

  /** Draft rows without marker or indent, joined the way the person most likely typed them. */
  static join(agentId: SessionAgentId, rows: readonly string[], cols: number): string {
    const limit = cols - AgentComposerRowJoin.marginOf(agentId)
    let text = rows[0] ?? ''
    for (let index = 1; index < rows.length; index += 1)
      text += AgentComposerRowJoin.separator(agentId, rows[index - 1], rows[index], limit) + rows[index]
    return text
  }

  private static separator(
    agentId: SessionAgentId,
    previous: string,
    next: string,
    limit: number,
  ): '' | ' ' | '\n' {
    if (previous === '' || next === '') return '\n'
    const used = AgentComposerRowJoin.gutterCellsConst + AgentComposerRowJoin.cellsAtLeast(previous)
    if (AgentComposerRowJoin.breaksAfterPunctuation(agentId)
      && AgentComposerRowJoin.codexBreakAfterConst.test(previous.at(-1) ?? '')
      && used + AgentComposerRowJoin.cellsAtLeast(AgentComposerRowJoin.breakFragment(next)) > limit)
      return ''
    // A full row whose last word and the next row's first word could not share any row: one token
    // was cut where the row ended. A word wrap would have moved a token that fits a row whole.
    if (used >= limit && AgentComposerRowJoin.cellsAtLeast(AgentComposerRowJoin.lastWord(previous))
      + AgentComposerRowJoin.cellsAtLeast(AgentComposerRowJoin.firstWord(next))
      > limit - AgentComposerRowJoin.gutterCellsConst)
      return ''
    if (used + 1 + AgentComposerRowJoin.cellsAtLeast(AgentComposerRowJoin.firstWord(next)) > limit)
      return ' '
    return '\n'
  }

  private static firstWord(text: string): string {
    const space = text.indexOf(' ')
    return space < 0 ? text : text.slice(0, space)
  }

  private static lastWord(text: string): string {
    return text.slice(text.lastIndexOf(' ') + 1)
  }

  /** What a break inside a token would have had to fit: the next row up to its first break. */
  private static breakFragment(text: string): string {
    const word = AgentComposerRowJoin.firstWord(text)
    const at = word.search(AgentComposerRowJoin.codexBreakAfterConst)
    return at < 0 ? word : word.slice(0, at + 1)
  }

  private static cellsAtLeast(text: string): number {
    let count = 0
    for (const _segment of AgentComposerRowJoin.graphemesConst.segment(text)) count += 1
    return count
  }

  private static marginOf(agentId: SessionAgentId): number {
    if (agentId === 'claude') return AgentComposerRowJoin.claudeMarginConst
    else if (agentId === 'codex') return AgentComposerRowJoin.codexMarginConst
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }

  private static breaksAfterPunctuation(agentId: SessionAgentId): boolean {
    if (agentId === 'claude') return false
    else if (agentId === 'codex') return true
    else throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
