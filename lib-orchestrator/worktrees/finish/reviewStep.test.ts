import { describe, expect, it, vi } from 'vitest'
import { finishTestRecords, testAssembly } from '../worktreeTesting'
import type { WorktreeRepositoryReview, WorktreeReviewSnapshot } from '../worktreeState'
import { ReviewStep } from './reviewStep'

const rowOf = (root: string, message: string): WorktreeRepositoryReview => ({ root, repository: 'https://svn.test/app', repositoryName: 'app',
  expectedPrefix: '[app]', paths: ['a.txt'], message, source: message ? 'agent-proposal' : 'unknown', acknowledged: [] })

async function reviewWith(repositories: WorktreeRepositoryReview[], prepared = true) {
  const h = await finishTestRecords({ step: 'reviewing', ...prepared ? { preparation: { format: 1 as const, manifest: 'fixture', content: testAssembly().content,
    metadata: testAssembly().metadata, commands: testAssembly().content, checkedAt: 1, checks: 'none' as const, attempt: 0 } } : {} })
  const review: WorktreeReviewSnapshot = { version: 2, selection: ['a.txt'], hashes: { 'a.txt': 'node:1' }, repositories,
    message: '', source: 'unknown', acknowledged: [], headMovedBy: 0 }
  const messageWanted = vi.fn(async () => {})
  const write = vi.fn(async () => {})
  const step = new ReviewStep({ now: () => 1, records: h.records, svn: {} as never, handoffs: { messageWanted } as never },
    { write, wait: vi.fn(async () => {}) },
    { create: vi.fn(async () => ({ rows: [{ path: 'a.txt', origin: 'worker' as const, checked: true }], review })), approve: vi.fn() })
  await step.review('worker')
  return { messageWanted, write }
}

describe('ReviewStep', () => {
  // Mirabia 113 opened its review with an empty message and nobody asked the worker (2026-10-30).
  it('asks the worker for the message of each repository the review opened without one', async () => {
    const { messageWanted } = await reviewWith([rowOf('/tree', ''), rowOf('/tree/lib', '[app] '), rowOf('/tree/other', '[app] Fix')])
    expect(messageWanted).toHaveBeenCalledWith('worker', [expect.objectContaining({ root: '/tree' }), expect.objectContaining({ root: '/tree/lib' })])
  })

  // A preparation that found nothing to publish read no assembly; a change seen by the review prepares it fully.
  it('returns to the checks when the review finds a change its preparation did not see', async () => {
    const { messageWanted, write } = await reviewWith([rowOf('/tree', '')], false)
    expect(messageWanted).not.toHaveBeenCalled()
    const next = (write.mock.calls[0] as unknown as [string, (state: object) => object])[1]({ step: 'reviewing', review: {} })
    expect(next).toMatchObject({ phase: 'finishing', step: 'checking', review: undefined })
  })

  it('asks nothing when every repository has its message', async () => {
    const { messageWanted } = await reviewWith([rowOf('/tree', '[app] Fix the parser')])
    expect(messageWanted).not.toHaveBeenCalled()
  })
})
