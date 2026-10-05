import { describe, expect, it } from 'vitest'

import type { SessionAgentId } from '../sessionManagerApi.types'
import { AgentComposerRowJoin } from './agentComposerRowJoin'
import { WorkFixtures } from './fixtures/workFixtures'
import { ScreenTail } from './screenTail'

describe('lib-orchestrator/sessionManager/workState/agentComposerRowJoin', () => {
  const colsConst = 120
  /** Claude's full row at 120 columns is 118 cells, gutter included, so 116 of text. */
  const claudeFullConst = 116
  /** Codex's is 119, so 117 of text. */
  const codexFullConst = 117

  function join(agentId: SessionAgentId, rows: string[]): string {
    return AgentComposerRowJoin.join(agentId, rows, colsConst)
  }

  /** A row of `cells` characters that ends in a word of `last` characters. */
  function rowOf(cells: number, last = 5): string {
    return `${'w'.repeat(cells - last - 1)} ${'x'.repeat(last)}`
  }

  it('keeps a blank row as the newline it was typed as, on either side', () => {
    for (const agent of ['claude', 'codex'] as const) {
      expect(join(agent, ['first', '', 'third'])).toBe('first\n\nthird')
      expect(join(agent, [rowOf(claudeFullConst), ''])).toBe(`${rowOf(claudeFullConst)}\n`)
    }
  })

  it('keeps a newline after a short row whose next word would have fitted', () => {
    for (const agent of ['claude', 'codex'] as const)
      expect(join(agent, ['fix the parser', 'and the tests'])).toBe('fix the parser\nand the tests')
  })

  it('restores the space a wrap swallowed when the next word could not have fitted', () => {
    const claudeRow = rowOf(claudeFullConst - 3)
    expect(join('claude', [claudeRow, 'four more'])).toBe(`${claudeRow} four more`)
    expect(join('claude', [claudeRow, 'to more'])).toBe(`${claudeRow}\nto more`)
    const codexRow = rowOf(codexFullConst - 3)
    expect(join('codex', [codexRow, 'four more'])).toBe(`${codexRow} four more`)
    expect(join('codex', [codexRow, 'to more'])).toBe(`${codexRow}\nto more`)
  })

  it('joins Codex rows broken after a hyphen or a slash without a space, and Claude rows with one', () => {
    const hyphen = `${'w'.repeat(codexFullConst - 8)} an-long-`
    expect(join('codex', [hyphen, 'pointer-path rest'])).toBe(`${hyphen}pointer-path rest`)
    const slash = `${'w'.repeat(codexFullConst - 7)} notes/`
    expect(join('codex', [slash, 'aVeryLongDirectory/x'])).toBe(`${slash}aVeryLongDirectory/x`)
    // A fragment that would have fitted means the row really ended there.
    expect(join('codex', ['short-', 'a b'])).toBe('short-\na b')
    // Claude never breaks after a hyphen: a row ending in one is a word that ended the row.
    const claudeHyphen = `${'w'.repeat(claudeFullConst - 9)} an-long-`
    expect(join('claude', [claudeHyphen, 'pointer-path rest'])).toBe(`${claudeHyphen} pointer-path rest`)
  })

  it('joins a token longer than a row without a space, wherever on the row it began', () => {
    const token = 't'.repeat(claudeFullConst)
    expect(join('claude', [token, 'tail of it'])).toBe(`${token}tail of it`)
    const started = `read ${'t'.repeat(claudeFullConst - 5)}`
    expect(join('claude', [started, 'tailofthesametoken rest'])).toBe(`${started}tailofthesametoken rest`)
    const codexToken = 't'.repeat(codexFullConst)
    expect(join('codex', [codexToken, 'tail'])).toBe(`${codexToken}tail`)
    // A full row whose last word fits a row with the next one was a word wrap, not a cut.
    const full = rowOf(claudeFullConst)
    expect(join('claude', [full, 'next'])).toBe(`${full} next`)
  })

  // The documented direction of the error: a wide character counts one cell, so the row looks
  // shorter than it is and the boundary stays a newline rather than becoming a join.
  it('keeps a newline after a row of wide characters that really was full', () => {
    const wide = '日'.repeat(57)
    expect(join('claude', [wide, 'abc'])).toBe(`${wide}\nabc`)
  })

  it.each([
    ['claude-live-composer-long-token-120.json', 118],
    ['claude-live-composer-long-token-80.json', 78],
    ['codex-live-composer-long-token-120.json', 119],
    ['codex-live-composer-long-token-80.json', 79],
  ])('takes the full row of %s to be exactly %i cells, its longest row', (file, full) => {
    const fixture = WorkFixtures.all().find((candidate) => candidate.file === file)
    if (fixture === undefined) throw new Error(`missing work fixture ${file}`)
    const viewport = WorkFixtures.viewportOf(fixture)
    const widths = viewport.rows
      .map((row) => ScreenTail.stripAnsi(row.replace(/\x1b\[(\d*)C/g, (_, count: string) => ' '.repeat(Number(count || '1')))).trimEnd())
      .filter((row) => /^[>›]\s|^ {2}\S/.test(row) && !row.includes(' · ') && !row.includes('⏵'))
      .map((row) => [...row].length)
    expect(Math.max(...widths)).toBe(full)
    // A one-token row is a cut exactly when it reaches that width, and a wrap one cell short of it.
    const token = (cells: number): string => 't'.repeat(cells - 2)
    expect(AgentComposerRowJoin.join(fixture.agent, [token(full), 'tail'], viewport.cols)).toBe(`${token(full)}tail`)
    expect(AgentComposerRowJoin.join(fixture.agent, [token(full - 1), 'tail'], viewport.cols))
      .toBe(`${token(full - 1)} tail`)
  })

  it('throws for an agent it does not know', () => {
    expect(() => AgentComposerRowJoin.join('gemini' as SessionAgentId, ['a', 'b'], colsConst)).toThrow('Unknown agent')
  })
})
