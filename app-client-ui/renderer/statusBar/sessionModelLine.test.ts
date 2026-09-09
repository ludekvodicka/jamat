import { describe, expect, it } from 'vitest'

import type {
  SessionModelInfo,
} from '../../../lib-orchestrator/sessionModelReader/sessionModelReaderApi.types'
import { SessionModelLine } from './sessionModelLine'
import type { ActiveAgentTerminal } from './useActiveAgentTerminal'

describe('app-client-ui/renderer/statusBar/sessionModelLine', () => {
  function infoOf(overrides: Partial<SessionModelInfo> = {}): SessionModelInfo {
    return {
      model: 'claude-sonnet-4-5-20260101',
      modelLabel: 'Sonnet 4.5',
      effortLevel: 'high',
      contextTokens: 90_000,
      contextWindow: 1_000_000,
      ...overrides,
    }
  }

  it('writes the model, the effort and how full the context is', () => {
    expect(SessionModelLine.lineOf(infoOf())).toBe('Sonnet 4.5 · high · 90k / 1M · 9%')
  })

  /**
   * The whole of answer 2: V1 answered a zero window for a model it did not recognise and the caller
   * hid the widget, so a new model family read as "nothing to say". Here the model and the tokens
   * stand and only the window and the percentage are missing.
   */
  it('keeps the model and the tokens when the window is unknown', () => {
    expect(SessionModelLine.lineOf(infoOf({ contextWindow: null })))
      .toBe('Sonnet 4.5 · high · 90k')
  })

  it('leaves out an effort nobody configured', () => {
    expect(SessionModelLine.lineOf(infoOf({ effortLevel: null })))
      .toBe('Sonnet 4.5 · 90k / 1M · 9%')
  })

  it('turns a fill into the level that colours it', () => {
    expect(SessionModelLine.levelOf(null)).toBe('none')
    expect(SessionModelLine.levelOf(0)).toBe('none')
    expect(SessionModelLine.levelOf(44)).toBe('none')
    expect(SessionModelLine.levelOf(45)).toBe('notice')
    expect(SessionModelLine.levelOf(74)).toBe('notice')
    expect(SessionModelLine.levelOf(75)).toBe('warn')
    expect(SessionModelLine.levelOf(84)).toBe('warn')
    expect(SessionModelLine.levelOf(85)).toBe('danger')
    expect(SessionModelLine.levelOf(100)).toBe('danger')
  })

  // The throwing `else` is not decoration: a percentage that compares false against every threshold
  // would otherwise fall through as `danger` and paint a line nobody can explain.
  it('refuses a fill that is no number at all', () => {
    expect(() => SessionModelLine.levelOf(Number.NaN)).toThrow('Unreachable context percent')
  })

  // The fill is no longer part of it: an empty context, a full one and a model with no known window
  // all offer the same button, and only the session's own life takes it away.
  it('offers compacting for as long as the session runs, whatever the fill', () => {
    expect(SessionModelLine.compactVisible('live')).toBe(true)
    expect(SessionModelLine.compactVisible('starting')).toBe(false)
    expect(SessionModelLine.compactVisible('ended')).toBe(false)
    expect(SessionModelLine.compactVisible('lost')).toBe(false)
  })

  // The state a fifth `life` would land in: loud here rather than a button over a session that has
  // no way to read what it is sent.
  it('refuses a life it does not know', () => {
    expect(() => SessionModelLine.compactVisible(
      'retired' as unknown as ActiveAgentTerminal['life'],
    )).toThrow('Unknown session life')
  })

  /** R6: the Claude number is the project's configuration, and the tooltip is where that is said. */
  it('says that a Claude effort is the project setting rather than the live state', () => {
    expect(SessionModelLine.tooltipOf(infoOf(), 'claude')).toBe([
      'Model: claude-sonnet-4-5-20260101',
      'Context: 90,000 / 1,000,000 tokens (9%)',
      "Effort: high · the project's setting, not the running agent's live state",
    ].join('\n'))
  })

  // Codex writes its own effort into the transcript, so what is drawn for it is the session's answer.
  it('carries no such caveat for Codex', () => {
    const tooltip = SessionModelLine.tooltipOf(infoOf({ model: 'gpt-5-codex' }), 'codex')

    expect(tooltip).toContain('Effort: high')
    expect(tooltip).not.toContain('project')
  })

  it('says in the tooltip why an unknown window carries no percentage', () => {
    const tooltip = SessionModelLine.tooltipOf(infoOf({ contextWindow: null }), 'claude')

    expect(tooltip).toContain('Context: 90,000 tokens')
    expect(tooltip).not.toContain('%')
  })
})
