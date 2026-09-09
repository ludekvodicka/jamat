import { describe, expect, it } from 'vitest'

import { Slug } from './slug'

/**
 * One rule, read by three surfaces that used to hold two rules between them: the category ids the
 * projects settings writes, the worktree directory git creates, and the preview the launcher draws
 * before either exists. What they disagreed about was accents, and nothing recorded why.
 */
describe('lib-orchestrator/shared/slug', () => {
  it('folds accents rather than dropping them', () => {
    expect(Slug.of('Zákazníci')).toBe('zakaznici')
    expect(Slug.of('Přehled účtů')).toBe('prehled-uctu')
  })

  it('lowercases, and turns every run of anything else into one hyphen', () => {
    expect(Slug.of('Fix   the __ build!!')).toBe('fix-the-build')
    expect(Slug.of('014 - Feature name')).toBe('014-feature-name')
  })

  it('carries no hyphen at either end', () => {
    expect(Slug.of('  --hello--  ')).toBe('hello')
  })

  // Empty is an answer, not a failure: what it MEANS is the caller's, and the two callers differ.
  // The settings tab falls back to `root`; the launcher refuses isolation rather than invent a name.
  it('answers empty for a name that folds to nothing', () => {
    expect(Slug.of('日本語')).toBe('')
    expect(Slug.of('---')).toBe('')
  })
})
