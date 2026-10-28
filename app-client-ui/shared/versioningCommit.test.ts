import { describe, expect, it } from 'vitest'
import { VersioningCommitReceipts, type VersioningCommitDraftDto } from './versioningCommit'
import { versioningReviewSchema } from './versioningReviewSchemas'

describe('commit receipt omissions', () => {
  const draft: VersioningCommitDraftDto = {
    draftId: 'draft', sessionId: 'session', vcs: 'svn', source: 'svn', scopeRoot: 'C:/app', scopeTooltip: '',
    message: '[app] Fix selected paths', editedByPerson: true, proposedByAgent: false, revision: 2,
    phase: { kind: 'done', revision: '42', output: '', finishedAt: 100 },
    published: [{ scopeRoot: 'C:/app', revision: '42', paths: ['C:/app/a'], omittedPaths: ['C:/app/b'] }],
  }

  it('preserves the published revision and a visible warning for peers with the old strict receipt schema', () => {
    const legacyReceipt = versioningReviewSchema.shape.published.unwrap().element.omit({ omittedPaths: true })
    const legacy = versioningReviewSchema.extend({ published: legacyReceipt.array().optional() })
    expect(legacy.safeParse(draft).success).toBe(false)
    const projected = VersioningCommitReceipts.forLegacyPeer(draft)
    expect(legacy.safeParse(projected).success).toBe(true)
    expect(projected).toMatchObject({ phase: { kind: 'failed', detail: expect.stringContaining('Published 42.') },
      published: [{ revision: '42', paths: ['C:/app/a'] }] })
    expect(projected.phase).toMatchObject({ detail: expect.stringContaining('C:/app/b') })
    expect(draft.phase.kind).toBe('done')
    expect(draft.published?.[0].omittedPaths).toEqual(['C:/app/b'])
  })

  it('clears an old omission only when a later receipt includes that exact node', () => {
    const retried = { ...draft, published: [...draft.published!, { scopeRoot: 'C:/app', revision: '43', paths: ['C:\\app\\b'] }] }
    expect(VersioningCommitReceipts.unresolved(retried)).toEqual([])
    expect(VersioningCommitReceipts.forLegacyPeer(retried).phase.kind).toBe('done')
    retried.published[1].paths = ['C:/app/B']
    expect(VersioningCommitReceipts.unresolved(retried)).toHaveLength(1)
  })
})
