import { describe, expect, it } from 'vitest'

import type {
  FileChangeBaseline,
  FileChangeEntry,
  FileChangesSnapshot,
  FileChangesWorkingTreeSnapshot,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileViewerDiffTargets } from './fileViewerControls'

describe('app-client-ui/renderer/fileViewer/fileViewerControls', () => {
  /*
   * `baselineId` is a token minted with randomUUID at every list(), so it says which LISTING a
   * baseline came from and never which baseline it is. Pairing the chosen one by that id therefore
   * matched nothing the moment anything rebuilt the listing - Refresh, a second reader of the same
   * hook - and the selection fell back to HEAD with nothing said, while the control still read as
   * the question that had been asked.
   */
  describe('the baseline a person chose, across a rebuilt listing', () => {
    const baselineOf = (
      kind: FileChangeBaseline['kind'],
      revision: string | null,
      baselineId: string,
    ): FileChangeBaseline => ({ baselineId, kind, label: revision ?? kind, revision, createdAt: null })

    const entryOf = (fileId: string): FileChangeEntry => ({
      fileId,
      path: 'C:/work/a.ts',
      displayPath: 'a.ts',
      nodeKind: 'file',
      location: 'workspace',
      status: 'modified',
      previousPath: null,
      previousDisplayPath: null,
      modifiedAt: null,
      sources: ['vcs'],
      gitState: null,
    })

    const listingOf = (mint: string): {
      snapshot: FileChangesSnapshot
      groups: FileChangesSnapshot['history']['groups']
    } => {
      const groups = [
        {
          groupId: `group-${mint}`,
          baseline: baselineOf('git-commit', 'abc123', `baseline-commit-${mint}`),
          kind: 'git-commit' as const,
          label: 'last week',
          message: null,
          author: null,
          createdAt: 1,
          entries: [entryOf(`file-commit-${mint}`)],
        },
      ]
      const snapshot = {
        snapshotId: `snapshot-${mint}`,
        sessionId: 's1',
        createdAt: 1,
        vcs: { vcsId: 'git', available: [] },
        defaultBaseline: baselineOf('git-head', 'HEAD', `baseline-head-${mint}`),
        entries: [entryOf(`file-head-${mint}`)],
        history: { groups, nextCursor: null },
        warnings: [],
      } as unknown as FileChangesSnapshot
      return { snapshot, groups }
    }

    it('finds the same baseline again under a fresh id', () => {
      const first = listingOf('one')
      const chosen = FileViewerDiffTargets.of(first.snapshot, first.groups, 'C:/work/a.ts')[1]
      expect(chosen?.baseline.revision).toBe('abc123')

      const second = listingOf('two')
      const targets = FileViewerDiffTargets.of(second.snapshot, second.groups, 'C:/work/a.ts')
      const matched = FileViewerDiffTargets.sameAs(targets, chosen!.hint)

      expect(matched?.baseline.revision).toBe('abc123')
      // The ids moved with the listing, which is exactly why they cannot be the identity.
      expect(matched?.baseline.baselineId).toBe('baseline-commit-two')
      expect(matched?.fileId).toBe('file-commit-two')
      expect(matched?.snapshotId).toBe('snapshot-two')
    })

    it('says a baseline that is genuinely gone is gone', () => {
      const listing = listingOf('one')
      const targets = FileViewerDiffTargets.of(listing.snapshot, listing.groups, 'C:/work/a.ts')

      expect(FileViewerDiffTargets.sameAs(targets, { kind: 'git-commit', revision: 'dead99' }))
        .toBeNull()
      // A different chat message is a different baseline even though both carry the same kind.
      expect(FileViewerDiffTargets.sameAs(targets, { kind: 'chat-message', revision: 'g-2' }))
        .toBeNull()
    })

    it('tells two baselines apart by what they name, not by which listing minted them', () => {
      expect(FileViewerDiffTargets.identityOf({ kind: 'git-commit', revision: 'abc123' }))
        .toBe(FileViewerDiffTargets.identityOf({ kind: 'git-commit', revision: 'abc123' }))
      expect(FileViewerDiffTargets.identityOf({ kind: 'git-commit', revision: 'abc123' }))
        .not.toBe(FileViewerDiffTargets.identityOf({ kind: 'git-commit', revision: 'def456' }))
      expect(FileViewerDiffTargets.identityOf({ kind: 'chat-message', revision: 'g-1' }))
        .not.toBe(FileViewerDiffTargets.identityOf({ kind: 'git-commit', revision: 'g-1' }))
      expect(FileViewerDiffTargets.identityOf({
        kind: 'git-head', revision: 'HEAD', workingTreeSource: 'checkpoint',
      })).not.toBe(FileViewerDiffTargets.identityOf({ kind: 'git-head', revision: 'HEAD' }))
    })

    it('drops a baseline the listing offered twice', () => {
      const listing = listingOf('one')
      const twice = [...listing.groups, { ...listing.groups[0]!, groupId: 'group-again' }]
      const targets = FileViewerDiffTargets.of(listing.snapshot, twice, 'C:/work/a.ts')

      expect(targets.map((target) => target.baseline.kind)).toEqual(['git-head', 'git-commit'])
    })

    it('keeps what was chosen across a rebuild and only then falls back', () => {
      const first = listingOf('one')
      const chosen = FileViewerDiffTargets.of(first.snapshot, first.groups, 'C:/work/a.ts')[1]!
      const second = listingOf('two')
      const targets = FileViewerDiffTargets.of(second.snapshot, second.groups, 'C:/work/a.ts')

      // The chosen commit survives the rebuild, under the new listing's ids.
      expect(FileViewerDiffTargets.keep(chosen, targets, undefined))
        .toEqual(targets.find((target) => target.baseline.revision === 'abc123'))
      // Nothing chosen yet: the hint decides.
      expect(FileViewerDiffTargets.keep(null, targets, { kind: 'git-commit', revision: 'abc123' })
        ?.baseline.revision).toBe('abc123')
      // A baseline that is genuinely gone falls back, and the hint is asked before HEAD.
      const gone = {
        ...chosen,
        baseline: { ...chosen.baseline, revision: 'dead99' },
        hint: { ...chosen.hint, revision: 'dead99' },
      }
      expect(FileViewerDiffTargets.keep(gone, targets, undefined)?.baseline.kind).toBe('git-head')
      expect(FileViewerDiffTargets.keep(gone, targets, { kind: 'git-commit', revision: 'abc123' })
        ?.baseline.revision).toBe('abc123')
    })

    it('composes a working source with its own snapshot and durable source hint', () => {
      const listing = listingOf('one')
      const checkpoint = {
        snapshotId: 'checkpoint-snapshot',
        sessionId: 's1',
        createdAt: 1,
        source: {
          requested: 'checkpoint', selected: 'checkpoint', available: ['checkpoint'],
          fallbackReason: null,
        },
        defaultBaseline: baselineOf('git-head', 'HEAD', 'checkpoint-baseline'),
        entries: [entryOf('checkpoint-file')],
        warnings: [],
      } as FileChangesWorkingTreeSnapshot

      const targets = FileViewerDiffTargets.of(
        listing.snapshot,
        listing.groups,
        'C:/work/a.ts',
        [checkpoint],
      )
      const target = targets.find((item) => item.hint.workingTreeSource === 'checkpoint')

      expect(target).toEqual(expect.objectContaining({
        snapshotId: 'checkpoint-snapshot',
        fileId: 'checkpoint-file',
        hint: { kind: 'git-head', revision: 'HEAD', workingTreeSource: 'checkpoint' },
      }))
    })

    it('falls back to the open hint, and then to the first target', () => {
      const listing = listingOf('one')
      const targets = FileViewerDiffTargets.of(listing.snapshot, listing.groups, 'C:/work/a.ts')

      expect(FileViewerDiffTargets.initial(targets, { kind: 'git-commit', revision: 'abc123' })
        ?.baseline.revision).toBe('abc123')
      expect(FileViewerDiffTargets.initial(targets, { kind: 'git-commit', revision: 'gone' })
        ?.baseline.kind).toBe('git-head')
      expect(FileViewerDiffTargets.initial([], undefined)).toBeNull()
    })
  })
})
