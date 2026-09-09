import { describe, expect, it } from 'vitest'

import type { FileChangeBaseline, FileChangeGroup } from '../fileChangesManagerApi.types'
import { FileChangesSnapshotStore } from './fileChangesSnapshotStore'

describe('lib-orchestrator/fileChangesManager/snapshots/fileChangesSnapshotStore', () => {
  const baselineConst: FileChangeBaseline = {
    baselineId: 'baseline-one',
    kind: 'git-head',
    label: 'HEAD',
    revision: 'HEAD',
    createdAt: null,
  }

  function group(id: string): FileChangeGroup {
    return {
      groupId: id,
      baseline: { ...baselineConst, baselineId: `baseline-${id}` },
      label: id,
      message: null,
      author: null,
      createdAt: 1,
      entries: [],
    }
  }

  function input(groups: FileChangeGroup[] = []) {
    const files = new Map([['file-one', {
      fileId: 'file-one',
      currentPath: 'Q:/Project/file.ts',
      nodeKind: 'file' as const,
      status: 'modified' as const,
    }]])
    const baselines = new Map([['baseline-one', {
      public: baselineConst,
      kind: 'vcs' as const,
      ref: { kind: 'git-head' as const, revision: 'HEAD' as const },
      files: new Map([['file-one', {
        currentPath: 'Q:/Project/file.ts',
        baselinePath: 'Q:/Project/file.ts',
        repositoryPath: 'file.ts',
        status: 'modified' as const,
      }]]),
    }]])
    return {
      context: {
        sessionId: 'session',
        cwd: 'Q:/Project',
        agent: { agentId: 'codex' as const, nativeSessionId: 'native' },
      },
      selectedVcs: null,
      logGroups: [],
      files,
      baselines,
      vcs: { requested: 'git' as const, selected: null, available: [], root: null, fallbackReason: null },
      defaultBaseline: baselineConst,
      entries: [],
      groups,
      warnings: [],
      pageSize: 1,
    }
  }

  it('pages with opaque cursors and rejects tokens from another snapshot', () => {
    const store = new FileChangesSnapshotStore()
    const first = store.put(input([group('one'), group('two')]))
    const second = store.put(input())
    expect(first.history.groups.map((entry) => entry.groupId)).toEqual(['one'])
    expect(first.history.nextCursor).not.toBeNull()
    expect(store.nextPage(first.snapshotId, first.history.nextCursor!)).toEqual({
      ok: true,
      value: { groups: [expect.objectContaining({ groupId: 'two' })], nextCursor: null },
    })
    expect(store.lookupDiff(second.snapshotId, 'file-one', 'baseline-from-first'))
      .toEqual(expect.objectContaining({ ok: false, code: 'unknown-baseline' }))
  })

  it('expires snapshots and refuses cross-file baseline pairs', () => {
    let now = 10
    const store = new FileChangesSnapshotStore(() => now)
    const snapshot = store.put(input())
    expect(store.lookupDiff(snapshot.snapshotId, 'file-one', 'baseline-one').ok).toBe(true)
    expect(store.lookupDiff(snapshot.snapshotId, 'other', 'baseline-one'))
      .toEqual(expect.objectContaining({ code: 'unknown-file' }))
    now += 16 * 60_000
    expect(store.lookup(snapshot.snapshotId).ok).toBe(false)
  })

  it('puts a current-only snapshot into the same runtime lookup', () => {
    const store = new FileChangesSnapshotStore(() => 42)
    const current = input()
    const snapshot = store.putWorking({
      context: current.context,
      selectedVcs: current.selectedVcs,
      logGroups: current.logGroups,
      files: current.files,
      baselines: current.baselines,
      source: {
        requested: null,
        selected: 'checkpoint',
        available: ['checkpoint', 'svn'],
        fallbackReason: null,
      },
      defaultBaseline: baselineConst,
      entries: current.entries,
      warnings: [],
    })

    expect(snapshot).toEqual(expect.objectContaining({
      createdAt: 42,
      source: expect.objectContaining({ selected: 'checkpoint' }),
    }))
    expect(store.lookupDiff(snapshot.snapshotId, 'file-one', 'baseline-one').ok).toBe(true)
  })
})
