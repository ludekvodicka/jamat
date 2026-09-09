import { describe, expect, it } from 'vitest'

import { ClaudeContextWindows } from './claudeContextWindows'

describe('lib-orchestrator/sessionModelReader/claude/claudeContextWindows', () => {
  it('reads the million off the [1m] suffix only, whatever the family is', () => {
    expect(ClaudeContextWindows.windowOf('claude-opus-5[1m]')).toBe(1_000_000)
    expect(ClaudeContextWindows.windowOf('claude-haiku-4-5-20260101[1m]')).toBe(1_000_000)
  })

  // The suffix is what marks the million, so an id without it is the smaller window even for the
  // two families that used to answer a million on their own. Guessing the roomier one hid a full
  // session behind a percentage five times too low.
  it('reads a family with no stated tier as the two-hundred-thousand window', () => {
    expect(ClaudeContextWindows.windowOf('claude-opus-4-7-20260101')).toBe(200_000)
    expect(ClaudeContextWindows.windowOf('claude-sonnet-4-5-20260101')).toBe(200_000)
    expect(ClaudeContextWindows.windowOf('claude-haiku-4-5-20260101')).toBe(200_000)
    // Fable was the family this table did not list while the settings picker offered it, so a
    // bare `claude-fable-5` session drew no window and its `[1m]` twin drew a million.
    expect(ClaudeContextWindows.windowOf('claude-fable-5')).toBe(200_000)
  })

  // The case this second source exists for: Claude Code writes `claude-opus-5` for a session that
  // is running on the million-token tier, and only the settings it was started under say `[1m]`.
  it('takes the million off the configured model when the transcript id does not state it', () => {
    expect(ClaudeContextWindows.windowOf('claude-opus-5', 'opus[1m]')).toBe(1_000_000)
    expect(ClaudeContextWindows.windowOf('claude-opus-5', 'claude-opus-5[1m]')).toBe(1_000_000)
    expect(ClaudeContextWindows.windowOf('claude-opus-5-20260101', 'claude-opus-5[1m]'))
      .toBe(1_000_000)
    expect(ClaudeContextWindows.windowOf('claude-fable-5', 'fable[1m]')).toBe(1_000_000)
  })

  // Configuration, not the live state: `/model` moves a running session off it without touching a
  // file. A configured model that names something else is evidence about something else.
  it('ignores a configured model that does not name the model in the transcript', () => {
    expect(ClaudeContextWindows.windowOf('claude-sonnet-5', 'opus[1m]')).toBe(200_000)
    expect(ClaudeContextWindows.windowOf('claude-opus-4-8', 'claude-opus-5[1m]')).toBe(200_000)
    expect(ClaudeContextWindows.windowOf('claude-opus-5', 'opusplan[1m]')).toBe(200_000)
  })

  it('ignores a configured model that names no tier, and a missing one', () => {
    expect(ClaudeContextWindows.windowOf('claude-opus-5', 'opus')).toBe(200_000)
    expect(ClaudeContextWindows.windowOf('claude-opus-5', null)).toBe(200_000)
    expect(ClaudeContextWindows.windowOf('claude-opus-5', '')).toBe(200_000)
  })

  // A tier stated for a family the table does not list is still a stated tier: the window is known
  // even though the default for that family is not.
  it('answers a matching configured tier even for a family with no row in the table', () => {
    expect(ClaudeContextWindows.windowOf('claude-orion-9-1-20270101', 'orion[1m]')).toBe(1_000_000)
    expect(ClaudeContextWindows.windowOf('claude-orion-9-1-20270101', 'opus[1m]')).toBeNull()
  })

  it('answers null for a family it does not know instead of guessing a window', () => {
    expect(ClaudeContextWindows.windowOf('claude-orion-9-1-20270101')).toBeNull()
    expect(ClaudeContextWindows.windowOf('<synthetic>')).toBeNull()
    expect(ClaudeContextWindows.windowOf('')).toBeNull()
  })

  it('labels a model by family and version, and leaves an unrecognised id alone', () => {
    expect(ClaudeContextWindows.labelOf('claude-sonnet-4-5-20260101')).toBe('Sonnet 4.5')
    expect(ClaudeContextWindows.labelOf('claude-opus-4-7-20260101[1m]')).toBe('Opus 4.7')
    expect(ClaudeContextWindows.labelOf('claude-fable-9-1-20270101')).toBe('Fable 9.1')
    expect(ClaudeContextWindows.labelOf('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(ClaudeContextWindows.labelOf('')).toBe('unknown')
  })

  // Caught on screen, not in a test: the running client drew `claude-opus-5` because the pattern
  // demanded a minor the current ids no longer carry.
  it('labels a model whose id carries no minor version', () => {
    expect(ClaudeContextWindows.labelOf('claude-opus-5')).toBe('Opus 5')
    expect(ClaudeContextWindows.labelOf('claude-sonnet-5-20260101')).toBe('Sonnet 5')
    expect(ClaudeContextWindows.labelOf('claude-opus-5[1m]')).toBe('Opus 5')
  })
})
