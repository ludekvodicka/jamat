import { describe, expect, it } from 'vitest'

import { VersioningSettings } from './versioningSettings'

describe('app-client-ui/shared/versioningSettings', () => {
  it('preserves a saved commit split and rejects invalid ratios without mutating the input', () => {
    const reports: string[] = []
    const report = (message: string): void => { reports.push(message) }
    expect(VersioningSettings.coerce({ mode: 'git', commitSplitRatio: 0.4 }, report).commitSplitRatio).toBe(0.4)
    expect(VersioningSettings.fieldsOf('commitSplitRatio')).toEqual(['commitSplitRatio'])
    for (const commitSplitRatio of [null, '0.5', Number.NaN, Infinity, 0.1, 0.9]) {
      const input = Object.freeze({ ...VersioningSettings.defaultValue(), commitSplitRatio })
      expect(VersioningSettings.coerce(input, report).commitSplitRatio).toBe(0.75)
      expect(VersioningSettings.isValid(input)).toBe(false)
    }
    expect(reports).toHaveLength(6)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), commitSplitRatio: 0.15 })).toBe(true)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), commitSplitRatio: 0.85 })).toBe(true)
  })
  it('defaults session return on for old configs and preserves or validates explicit values', () => {
    const report = (message: string) => messages.push(message)
    const messages: string[] = []
    expect(VersioningSettings.defaultValue().returnToPreviousSessionAfterCommit).toBe(true)
    expect(VersioningSettings.coerce({ mode: 'git', activateSessionOnCommit: false }, report).returnToPreviousSessionAfterCommit).toBe(true)
    expect(VersioningSettings.coerce({ mode: 'git', returnToPreviousSessionAfterCommit: false }, report).returnToPreviousSessionAfterCommit).toBe(false)
    expect(messages).toEqual([])
    expect(VersioningSettings.coerce({ mode: 'git', returnToPreviousSessionAfterCommit: 'no' }, report).returnToPreviousSessionAfterCommit).toBe(true)
    expect(messages).toHaveLength(1)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), returnToPreviousSessionAfterCommit: 'no' })).toBe(false)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), returnToPreviousSessionAfterCommit: false })).toBe(true)
  })

  /**
   * The window is what keeps a long review in front. It is read as minutes because that is what the
   * person types, and 0 is the old behaviour rather than a fourth state to explain: return whenever
   * the review ends, however long it ran.
   */
  it('defaults the return window to five minutes and takes only whole minutes in range', () => {
    const messages: string[] = []
    const report = (message: string) => messages.push(message)
    expect(VersioningSettings.defaultValue().returnToPreviousSessionWithinMinutes).toBe(5)
    expect(VersioningSettings.returnWindowMilliseconds(VersioningSettings.defaultValue())).toBe(300_000)
    expect(VersioningSettings.returnWindowMilliseconds({ ...VersioningSettings.defaultValue(), returnToPreviousSessionWithinMinutes: 0 })).toBeNull()
    expect(VersioningSettings.coerce({ mode: 'git', returnToPreviousSessionWithinMinutes: 30 }, report).returnToPreviousSessionWithinMinutes).toBe(30)
    expect(messages).toEqual([])
    for (const unusable of [-1, 2.5, 1_441, '5', null])
      expect(VersioningSettings.coerce({ mode: 'git', returnToPreviousSessionWithinMinutes: unusable }, report).returnToPreviousSessionWithinMinutes).toBe(5)
    expect(messages).toHaveLength(5)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), returnToPreviousSessionWithinMinutes: 2.5 })).toBe(false)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), returnToPreviousSessionWithinMinutes: 0 })).toBe(true)
    expect(VersioningSettings.fieldsOf('commitReview')).toContain('returnToPreviousSessionWithinMinutes')
  })

  it('defaults automatic closing on, preserves disabled settings and rejects invalid values', () => {
    const messages: string[] = []
    expect(VersioningSettings.defaultValue().closeCommitOnSuccess).toBe(true)
    expect(VersioningSettings.coerce({ mode: 'checkpoints', closeCommitOnSuccess: false }, (message) => messages.push(message)).closeCommitOnSuccess).toBe(false)
    expect(messages).toEqual([])
    expect(VersioningSettings.coerce({ mode: 'checkpoints', closeCommitOnSuccess: 'no' }, (message) => messages.push(message)).closeCommitOnSuccess).toBe(true)
    expect(messages).toHaveLength(1)
    expect(VersioningSettings.isValid({ ...VersioningSettings.defaultValue(), closeCommitOnSuccess: 'no' })).toBe(false)
  })
  it('migrates a mode-only document and validates external arguments before substituting paths', () => {
    const messages: string[] = []
    expect(VersioningSettings.coerce({ mode: 'git' }, (text) => messages.push(text)))
      .toEqual({ mode: 'git', diffTool: { kind: 'internal' }, activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: true, returnToPreviousSessionWithinMinutes: 5, closeCommitOnSuccess: true })
    expect(messages).toEqual([])
    const preset = VersioningSettings.tortoiseMerge()
    expect(VersioningSettings.isDiffTool(preset)).toBe(true)
    expect(VersioningSettings.isDiffTool({ kind: 'external', command: 'tool', argumentTemplate: '"$1" "$2"' })).toBe(true)
    expect(VersioningSettings.isDiffTool({ kind: 'external', command: 'tool', argumentTemplate: '"%base" "%mine"' })).toBe(true)
    for (const argumentTemplate of ['%base', '%mine', '"%base %mine', '$1', '$2', '$10 $2', '$1 $20', '"$1 $2'])
      expect(VersioningSettings.isDiffTool({ kind: 'external', command: 'tool', argumentTemplate })).toBe(false)
    expect(VersioningSettings.isDiffTool({ kind: 'external', command: '', argumentTemplate: '%base %mine' })).toBe(false)
    expect(VersioningSettings.argumentsOf('"--label=two words" "%base" %mine ""'))
      .toEqual(['--label=two words', '%base', '%mine', ''])
    expect(VersioningSettings.coerce({ mode: 'git', diffTool: { kind: 'nope' } }, (text) => messages.push(text)).diffTool)
      .toEqual({ kind: 'internal' })
    expect(messages).toHaveLength(1)
  })
  it('defaults a missing or unusable section to checkpoints and reports only real damage', () => {
    const messages: string[] = []
    expect(VersioningSettings.coerce(undefined, (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' }, activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: true, returnToPreviousSessionWithinMinutes: 5, closeCommitOnSuccess: true })
    expect(VersioningSettings.coerce({ mode: 'jj' }, (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' }, activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: true, returnToPreviousSessionWithinMinutes: 5, closeCommitOnSuccess: true })
    expect(VersioningSettings.coerce('not an object', (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' }, activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: true, returnToPreviousSessionWithinMinutes: 5, closeCommitOnSuccess: true })
    // An absent section is not damage: it is a config nobody has written this key into yet.
    expect(messages).toHaveLength(2)
  })

  it('accepts only checkpoints or git while preserving unknown hand-written fields on read', () => {
    expect(VersioningSettings.isValid({ mode: 'checkpoints', diffTool: { kind: 'internal' } })).toBe(true)
    expect(VersioningSettings.isValid({ mode: 'git', diffTool: { kind: 'internal' } })).toBe(true)
    expect(VersioningSettings.isValid({ mode: 'jj' })).toBe(false)
    expect(VersioningSettings.isValid(undefined)).toBe(false)
    expect(VersioningSettings.coerce({ mode: 'git', note: 'keep', diffTool: { kind: 'internal' } }, () => undefined))
      .toEqual({ mode: 'git', note: 'keep', diffTool: { kind: 'internal' }, activateSessionOnCommit: true, returnToPreviousSessionAfterCommit: true, returnToPreviousSessionWithinMinutes: 5, closeCommitOnSuccess: true })
  })
})
