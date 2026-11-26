import { describe, expect, it } from 'vitest'

import type { FileChangeEntry, FileChangesWorkingTreeSnapshot } from '../fileChangesManager/fileChangesManagerApi.types'
import { CommitTargets } from './commitTargets'

function entryOf(
  displayPath: string,
  status: FileChangeEntry['status'] = 'modified',
  nodeKind: FileChangeEntry['nodeKind'] = 'file',
): FileChangeEntry {
  return {
    fileId: displayPath,
    path: `Q:/app/${displayPath}`,
    displayPath,
    nodeKind,
    status,
    location: 'workspace',
    previousPath: null,
    previousDisplayPath: null,
    modifiedAt: 1,
    sources: ['vcs'],
    gitState: null,
  }
}

function snapshotOf(entries: readonly FileChangeEntry[], externalRoots: FileChangesWorkingTreeSnapshot['externalRoots'] = []): FileChangesWorkingTreeSnapshot {
  return {
    snapshotId: 'snap',
    sessionId: 'session',
    createdAt: 1,
    source: { requested: 'svn', selected: 'svn', available: ['svn'], fallbackReason: null },
    defaultBaseline: null,
    entries,
    externalRoots,
    warnings: [],
  }
}

describe('lib-orchestrator/clientApi/commitTargets', () => {
  it('resolves deleted-dir, copied-dir, required-parent and external-root lookups in O(N)', () => {
    const entries: FileChangeEntry[] = [
      entryOf('deleted-dir', 'deleted', 'directory'),
      entryOf('deleted-dir/nested', 'deleted', 'directory'),
      entryOf('copied-dir', 'added', 'directory'),
      entryOf('new-dir', 'untracked', 'directory'),
      entryOf('new-dir/sub', 'added', 'directory'),
      entryOf('conflict.txt', 'conflicted', 'file'),
    ]
    const externalFileIds: string[] = []
    for (let i = 0; i < 1_000; i += 1) {
      entries.push(entryOf(`deleted-dir/nested/keep-${i}.txt`, 'untracked'))
      entries.push(entryOf(`copied-dir/item-${i}.txt`, 'copied'))
      const file = entryOf(`new-dir/sub/file-${i}.txt`, 'untracked')
      entries.push(file)
      if (i % 10 === 0) externalFileIds.push(file.fileId)
    }

    const index = CommitTargets.index(entries)
    expect(index.removedBy(entryOf('deleted-dir/nested/keep-0.txt', 'untracked'))?.displayPath).toBe('deleted-dir/nested')
    expect(index.carrier(entryOf('copied-dir/item-0.txt', 'copied'))?.displayPath).toBe('copied-dir')

    const snapshot = snapshotOf(entries, [{ path: 'Q:/app/new-dir', displayPath: 'new-dir', fileIds: externalFileIds }])
    const eligible = CommitTargets.eligible(snapshot)
    // Only deleted-dir, deleted-dir/nested, copied-dir, new-dir, new-dir/sub + 1000 new-dir/sub files are eligible.
    expect(eligible).toHaveLength(1_005)
    expect(eligible.some((entry) => entry.status === 'conflicted')).toBe(false)
    expect(eligible.some((entry) => entry.status === 'copied')).toBe(false)

    const checked = new Set(['new-dir/sub/file-42.txt'])
    const required = index.requiredParents(checked)
    expect([...required].sort()).toEqual(['new-dir', 'new-dir/sub'])
    expect(CommitTargets.selected(entries, checked).map((entry) => entry.fileId).sort())
      .toEqual(['new-dir', 'new-dir/sub', 'new-dir/sub/file-42.txt'])

    const extMap = CommitTargets.externalRootMap(snapshot.externalRoots)
    expect(extMap.size).toBe(externalFileIds.length)
    expect(extMap.get('new-dir/sub/file-0.txt')?.displayPath).toBe('new-dir')
  })
})
