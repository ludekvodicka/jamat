import { describe, expect, it } from 'vitest'

import { FileChangesSettings } from './fileChangesSettings'

describe('app-client-ui/shared/fileChangesSettings', () => {
  it('defaults a missing or unusable section to git and reports damage', () => {
    const messages: string[] = []
    expect(FileChangesSettings.coerce(undefined, (message) => messages.push(message)))
      .toEqual({ primaryVcs: 'git' })
    expect(FileChangesSettings.coerce({ primaryVcs: 'mercurial' }, (message) => messages.push(message)))
      .toEqual({ primaryVcs: 'git' })
    expect(messages).toHaveLength(1)
  })

  it('accepts only git or svn while preserving unknown hand-written fields on read', () => {
    expect(FileChangesSettings.isValid({ primaryVcs: 'git' })).toBe(true)
    expect(FileChangesSettings.isValid({ primaryVcs: 'svn' })).toBe(true)
    expect(FileChangesSettings.isValid({ primaryVcs: 'hg' })).toBe(false)
    expect(FileChangesSettings.coerce({ primaryVcs: 'svn', note: 'keep' }, () => undefined))
      .toEqual({ primaryVcs: 'svn', note: 'keep' })
  })
})
