import { describe, expect, it } from 'vitest'

import { VersioningSettings } from './versioningSettings'

describe('app-client-ui/shared/versioningSettings', () => {
  it('migrates a mode-only document and validates external arguments before substituting paths', () => {
    const messages: string[] = []
    expect(VersioningSettings.coerce({ mode: 'git' }, (text) => messages.push(text)))
      .toEqual({ mode: 'git', diffTool: { kind: 'internal' } })
    expect(messages).toEqual([])
    const preset = VersioningSettings.tortoiseMerge()
    expect(VersioningSettings.isDiffTool(preset)).toBe(true)
    for (const argumentTemplate of ['%base', '%mine', '"%base %mine'])
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
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' } })
    expect(VersioningSettings.coerce({ mode: 'jj' }, (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' } })
    expect(VersioningSettings.coerce('not an object', (message) => messages.push(message)))
      .toEqual({ mode: 'checkpoints', diffTool: { kind: 'internal' } })
    // An absent section is not damage: it is a config nobody has written this key into yet.
    expect(messages).toHaveLength(2)
  })

  it('accepts only checkpoints or git while preserving unknown hand-written fields on read', () => {
    expect(VersioningSettings.isValid({ mode: 'checkpoints', diffTool: { kind: 'internal' } })).toBe(true)
    expect(VersioningSettings.isValid({ mode: 'git', diffTool: { kind: 'internal' } })).toBe(true)
    expect(VersioningSettings.isValid({ mode: 'jj' })).toBe(false)
    expect(VersioningSettings.isValid(undefined)).toBe(false)
    expect(VersioningSettings.coerce({ mode: 'git', note: 'keep', diffTool: { kind: 'internal' } }, () => undefined))
      .toEqual({ mode: 'git', note: 'keep', diffTool: { kind: 'internal' } })
  })
})
