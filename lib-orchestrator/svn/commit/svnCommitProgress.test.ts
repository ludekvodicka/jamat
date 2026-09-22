import { describe, expect, it } from 'vitest'

import type { CommitProgress } from '../../shared/commitProgress.types'
import { SvnCommitProgress } from './svnCommitProgress'

describe('lib-orchestrator/svn/commit/svnCommitProgress', () => {
  it('reads split notifications and live dots before a newline without claiming a committed result', () => {
    const events: CommitProgress[] = []
    const parser = new SvnCommitProgress(4, (value) => events.push(value))
    const output = 'Sending        žluťoučký.txt\r\nAdding  (bin)  binary.dat\nDeleting       old\nReplacing      next\nTransmitting file data '
    for (const character of output) parser.accept(character)
    expect(events.filter((event) => event.stage === 'sending').map((event) => event.completed)).toEqual([1, 2, 3, 4])
    parser.accept('..')
    expect(events.at(-1)).toEqual({ stage: 'transmitting', completed: 2, total: null })
    parser.accept('.done\nCommitting trans')
    parser.accept('action...')
    expect(events.at(-1)).toEqual({ stage: 'committing', completed: 0, total: null })
    parser.accept('\nCommitted revision 42.\n')
    expect(events.at(-1)?.stage).toBe('verifying')
  })

  it('handles property-only and deletion commits without inventing a file-data total', () => {
    const events: CommitProgress[] = []
    const parser = new SvnCommitProgress(1, (value) => events.push(value))
    parser.accept('Deleting       directory\nCommitting transaction...')
    expect(events).toEqual([
      { stage: 'sending', completed: 1, total: 1 },
      { stage: 'committing', completed: 0, total: null },
    ])
  })

  it('ignores unrelated output and bounds unexpected lines', () => {
    const events: CommitProgress[] = []
    const parser = new SvnCommitProgress(1, (value) => events.push(value))
    parser.accept('x'.repeat(70_000))
    parser.accept('\nWarning: some text...\nSending        file\n')
    expect(events).toEqual([{ stage: 'sending', completed: 1, total: 1 }])
  })
})
