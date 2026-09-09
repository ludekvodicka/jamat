import { describe, expect, it } from 'vitest'

import type { FileChangeStatus } from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import { FileChangesStatusMark } from './fileChangesStatusMark'

describe('app-client-ui/renderer/fileViewer/fileChangesStatusMark', () => {
  it('gives every status its distinct established mark', () => {
    const statuses: readonly FileChangeStatus[] = [
      'added', 'modified', 'deleted', 'renamed', 'replaced', 'copied', 'untracked',
      'conflicted', 'missing', 'obstructed',
    ]
    expect(statuses.map((status) => FileChangesStatusMark.of(status)))
      .toEqual(['A', 'M', 'D', 'R', 'P', 'C', '?', '!', '_', 'X'])
  })
})
