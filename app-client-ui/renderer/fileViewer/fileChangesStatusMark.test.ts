import { describe, expect, it } from 'vitest'

import type { FileChangeStatus } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileChangesStatusMark } from './fileChangesStatusMark'

describe('app-client-ui/renderer/fileViewer/fileChangesStatusMark', () => {
  const statuses: readonly FileChangeStatus[] = [
    'added', 'modified', 'deleted', 'renamed', 'replaced', 'copied', 'untracked',
    'conflicted', 'missing', 'obstructed',
  ]

  it('gives every status its distinct established git mark: R renamed, T a type change', () => {
    expect(statuses.map((status) => FileChangesStatusMark.of(status, 'git')))
      .toEqual(['A', 'M', 'D', 'R', 'T', 'C', '?', '!', '−', 'X'])
  })

  it('gives every status its distinct established svn mark: R replaced, as svn status and TortoiseSVN write it', () => {
    expect(statuses.map((status) => FileChangesStatusMark.of(status, 'svn')))
      .toEqual(['A', 'M', 'D', '→', 'R', 'C', '?', '!', '−', 'X'])
  })

  it('reads the conventions off the working tree source and the VCS', () => {
    expect(FileChangesStatusMark.ofSource('svn')).toBe('svn')
    expect(['checkpoint', 'worktree-base', 'git', null].map((source) => FileChangesStatusMark.ofSource(source as 'git' | null)))
      .toEqual(['git', 'git', 'git', 'git'])
    expect([FileChangesStatusMark.ofVcs('svn'), FileChangesStatusMark.ofVcs('git'), FileChangesStatusMark.ofVcs(null)])
      .toEqual(['svn', 'git', 'git'])
  })
})
