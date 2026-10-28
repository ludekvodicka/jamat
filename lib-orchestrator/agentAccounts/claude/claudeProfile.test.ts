import { describe, expect, it } from 'vitest'
import { claudeShareTable } from './claudeProfile'

describe('Claude profile sharing', () => {
  it('shares only the specified content and keeps identity and runtime files private', () => {
    const shared = [...claudeShareTable.directories, ...claudeShareTable.files]
    expect(claudeShareTable.directories).toContain('projects')
    expect(claudeShareTable.files).toContain('settings.json')
    for (const name of claudeShareTable.neverShared) expect(shared).not.toContain(name)
    expect(claudeShareTable.neverShared).toEqual(expect.arrayContaining(['.credentials.json', '.claude.json', 'sessions']))
    expect(new Set(shared).size).toBe(shared.length)
  })
})
