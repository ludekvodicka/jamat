import { expect, it } from 'vitest'
import type { WorktreeView } from '../../sessionManager/sessionManagerApi.types'
import { WorktreeEnding } from './worktreeEnding'

it.each(['landed', 'removed', 'active', 'finishing', 'waiting', 'kept'] as const)('classifies %s', (phase) => {
  const worktreeView: WorktreeView = { phase, version: 1, outOfDate: 0, conflicts: 0, summary: '' }
  expect(WorktreeEnding.of({ worktreeView })).toBe(phase === 'landed' || phase === 'removed' ? 'terminal' : 'open')
})
it('distinguishes a missing session from one without worktree facts', () => {
  expect(WorktreeEnding.of(undefined)).toBe('missing')
  expect(WorktreeEnding.of({})).toBe('open')
})
