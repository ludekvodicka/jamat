import { describe, expect, it } from 'vitest'
import { FileChangesLimits } from '../fileChangesManager/fileChangesLimits'
import { RemoteReviewSchemas } from '../remoteControl/remoteReviewSchemas'
import { VersioningCommitLimits, VersioningCommitPaths, VersioningCommitReceipts, type VersioningCommitDraftDto } from './versioningCommit'
import { versioningReviewSchema } from './versioningReviewSchemas'

describe('commit review targets', () => {
  const accepted = ['Q:/app/a.ts', { path: 'Q:/app', depth: 'empty' }, { path: 'Q:/app', depth: 'empty', checked: true },
    { path: 'Q:/app', depth: 'infinity' }, { path: 'Q:/app', depth: 'infinity', checked: true }, { path: 'Q:/app', depth: 'infinity', checked: false }]
  const refused = [{ path: 'Q:/app', depth: 'empty', checked: false }, { path: 'Q:/app', depth: 'infinity', checked: 'false' },
    { path: 'Q:/app', checked: false }, { path: 'Q:/app', depth: 'infinity', checked: false, recursive: true }, { path: '', depth: 'infinity', checked: false }]

  it('accepts checked: false only on an infinity target, in the helper and the review schema alike', () => {
    for (const target of accepted) {
      expect(VersioningCommitPaths.valid(target)).toBe(true)
      expect(versioningReviewSchema.shape.paths.safeParse([target]).success).toBe(true)
    }
    for (const target of refused) {
      expect(VersioningCommitPaths.valid(target)).toBe(false)
      expect(versioningReviewSchema.shape.paths.safeParse([target]).success).toBe(false)
    }
  })

  it('checks every form except checked: false', () => {
    expect(accepted.filter(VersioningCommitPaths.valid).map(VersioningCommitPaths.checked)).toEqual([true, true, true, true, true, false])
  })
})

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

describe('commit target limit', () => {
  // A list of 2,001 changed files used to open and then fail saving its selection (dto.selection.paths).
  it('lets every listed row be selected, saved and approved, and nothing more', () => {
    const max = VersioningCommitLimits.targetsMaxConst
    expect(max).toBe(FileChangesLimits.listingEntriesMax)
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `Q:/app/file-${index}.ts`)
    const selection = versioningReviewSchema.shape.selection.unwrap()
    expect(selection.safeParse({ snapshotId: 's', paths: paths(max) }).success).toBe(true)
    expect(selection.safeParse({ snapshotId: 's', paths: paths(max + 1) }).success).toBe(false)
    expect(versioningReviewSchema.shape.paths.safeParse(paths(max)).success).toBe(true)
    expect(versioningReviewSchema.shape.paths.safeParse(paths(max + 1)).success).toBe(false)
    const approve = (count: number) => RemoteReviewSchemas.decision.safeParse({ draftId: 'd', epoch: 'e', expectedRevision: 1,
      kind: 'approve', operationId: 'o', snapshotId: 's', fileIds: paths(count), message: 'm' }).success
    expect(approve(max)).toBe(true)
    expect(approve(max + 1)).toBe(false)
  })
})
