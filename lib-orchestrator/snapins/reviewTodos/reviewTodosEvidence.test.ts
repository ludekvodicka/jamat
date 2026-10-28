import { expect, it, vi } from 'vitest'
import type { SessionInfo, WorktreeResultDto, WorktreeView } from '../../sessionManager/sessionManagerApi.types'
import { ReviewTodosSnapin } from './reviewTodosSnapin'
import { attempt, context } from './reviewTodosTestFixtures'

it('requires a terminal HEAD filename and no pending or ready filename', async () => {
  const ctx = context()
  const snapin = new ReviewTodosSnapin()
  vi.mocked(ctx.svn.listAtHead).mockResolvedValue({ ok: true, value: ['900-complete-p1-x.md'] })
  expect(await snapin.evidence(ctx, attempt())).toEqual({ published: true, detail: '900-complete-p1-x.md' })
  vi.mocked(ctx.svn.listAtHead).mockResolvedValue({ ok: true, value: ['900-complete-p1-x.md', '900-pending-p1-x.md'] })
  expect(await snapin.evidence(ctx, attempt())).toEqual({ published: false })
})
it.each([
  ['never-started', 'removed', true], ['never-started', 'landed', true], ['never-started', 'waiting', false],
  ['nothing', 'removed', true], ['nothing', 'landed', true], ['nothing', 'waiting', false],
  ['discarded', 'removed', true], ['discarded', 'landed', true], ['discarded', 'waiting', false],
  ['kept', 'removed', false], ['committed', 'landed', false],
] as const)('checks %s results against %s lifecycle', async (result, phase, discarded) => {
  const ctx = context()
  const worktreeView: WorktreeView = { version: 1, phase, outOfDate: 0, conflicts: 0, summary: '' }
  const session: SessionInfo = { sessionId: 's', callerOperationId: attempt().attemptId, kind: 'agent', title: 'Test', titleParts: { number: '', name: 'Test' },
    tabTitle: 'Test', directory: { mode: 'adHoc', path: 'project' }, project: { kind: 'adHoc', path: 'project' }, life: 'ended', activity: 'idle', admits: [], worktreeView }
  const snapshot = ctx.sessions.snapshot()
  vi.mocked(ctx.sessions.snapshot).mockReturnValue({ ...snapshot, sessions: [session] })
  const dto: WorktreeResultDto = { actionId: 'a', action: 'discard', result, sessionId: 's', title: 'Test', tag: attempt().attemptId,
    worktreePath: 'wt', mainCopy: 'project', directoryId: null, removal: 'removed', revisions: [], lines: [], logs: [], notify: null, holdsLanded: null, at: 1, acknowledgedAt: null }
  vi.mocked(ctx.sessions.worktreeResults).mockResolvedValue({ ok: true, value: { results: [dto] } })
  expect(await new ReviewTodosSnapin().evidence(ctx, attempt())).toEqual(discarded ? { discarded: true } : { published: false })
})
