import { describe, expect, it } from 'vitest'

import type { FileChangesLogGroup, FileChangesLogMutation } from '../logs/fileChangesLogSource.types'
import { FileHistoryComposer } from './fileHistoryComposer'

describe('lib-orchestrator/fileChangesManager/history/fileHistoryComposer', () => {
  function mutation(
    id: string,
    overrides: Partial<FileChangesLogMutation>,
  ): FileChangesLogMutation {
    return {
      mutationId: id,
      kind: 'update',
      status: 'modified',
      path: 'Q:/Project/file.txt',
      previousPath: null,
      location: 'workspace',
      beforeContent: null,
      afterContent: null,
      oldText: null,
      newText: null,
      replaceAll: false,
      unifiedDiff: null,
      createdAt: 1,
      ...overrides,
    }
  }

  function group(id: string, mutations: FileChangesLogMutation[]): FileChangesLogGroup {
    return { groupId: id, message: id, createdAt: 1, mutations }
  }

  it('returns the exact content written by the selected message as a full anchor', () => {
    const result = new FileHistoryComposer().compose({
      currentPath: 'Q:/Project/file.txt',
      currentContent: 'later\n',
      selectedGroupId: 'selected',
      groups: [
        group('selected', [mutation('write', { kind: 'write', afterContent: 'then\n' })]),
        group('later', [mutation('edit', { oldText: 'then', newText: 'later' })]),
      ],
    })
    expect(result).toEqual({
      kind: 'available',
      path: 'Q:/Project/file.txt',
      content: 'then\n',
      completeness: 'full',
      detail: null,
    })
  })

  it('marks an anchored Edit chain as region data', () => {
    const result = new FileHistoryComposer().compose({
      currentPath: 'Q:/Project/file.txt',
      currentContent: 'prefix new suffix',
      selectedGroupId: 'selected',
      groups: [group('selected', [mutation('edit', { oldText: 'old', newText: 'new' })])],
    })
    expect(result).toEqual(expect.objectContaining({
      kind: 'available',
      content: 'prefix new suffix',
      completeness: 'region',
    }))
  })

  it('refuses a later Write because its prior state cannot be reconstructed', () => {
    const result = new FileHistoryComposer().compose({
      currentPath: 'Q:/Project/file.txt',
      currentContent: 'overwritten',
      selectedGroupId: 'selected',
      groups: [
        group('selected', [mutation('edit', { oldText: 'old', newText: 'new' })]),
        group('later', [mutation('write', { kind: 'write', afterContent: 'overwritten' })]),
      ],
    })
    expect(result).toEqual(expect.objectContaining({ kind: 'unavailable' }))
  })

  it('reverses a later Codex patch and move before validating the selected region', () => {
    const result = new FileHistoryComposer().compose({
      currentPath: 'Q:/Project/moved.txt',
      currentContent: 'three\n',
      selectedGroupId: 'selected',
      groups: [
        group('selected', [mutation('first', {
          oldText: 'one',
          newText: 'two',
          path: 'Q:/Project/file.txt',
        })]),
        group('later', [mutation('move', {
          kind: 'move',
          status: 'renamed',
          path: 'Q:/Project/moved.txt',
          previousPath: 'Q:/Project/file.txt',
          unifiedDiff: '@@ -1 +1 @@\n-two\n+three\n',
        })]),
      ],
    })
    expect(result).toEqual(expect.objectContaining({
      kind: 'available',
      path: 'Q:/Project/file.txt',
      content: 'two\n',
      completeness: 'region',
    }))
  })
})
