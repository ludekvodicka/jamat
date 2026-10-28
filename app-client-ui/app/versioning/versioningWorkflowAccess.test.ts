import { describe, expect, it, vi } from 'vitest'

import type { SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { VersioningCommitDraftDto } from '../../shared/versioningCommit'
import { VersioningWorkflowAccess } from './versioningWorkflowAccess'

function fixture() {
  const section = { workflowId: 'finish', kind: 'finish', open: true, summary: 'Review files',
    actions: [{ id: 'finish-again', requiresCommit: true }],
    rounds: [{ steps: [{ state: 'waits', body: { kind: 'commit', vcs: 'svn', scopeRoot: 'Q:/source' } }] }] }
  const snapshot = { revision: 7, sessions: [{ sessionId: 'session', actions: { sections: [section] } }] } as unknown as SessionsSnapshot
  const finishWorktreeSession = vi.fn(async () => ({ ok: true as const, value: { sessionId: 'session', actionId: 'action' } }))
  const access = new VersioningWorkflowAccess({ snapshot: () => snapshot, finishWorktreeSession })
  const draft = { sessionId: 'session', scopeRoot: 'Q:/source', vcs: 'svn', message: 'Reviewed',
    workflow: { workflowId: 'finish', acceptedAt: 100 } } as VersioningCommitDraftDto
  const request = { workflowId: 'finish', revision: 7, actionId: 'finish-again' as const, agreement: {} }
  return { snapshot, section, finishWorktreeSession, access, draft, request }
}

describe('source Finish review binding', () => {
  it('keeps a bound review valid when unrelated session activity advances the global snapshot', async () => {
    const f = fixture()
    f.snapshot.sessions[0].worktreeView = { version: 2 } as NonNullable<typeof f.snapshot.sessions[0]['worktreeView']>
    f.snapshot.revision = 8
    expect(await f.access.start(f.draft, { ...f.request, reviewVersion: 2 }, [], {})).toMatchObject({ ok: true })
    expect(f.finishWorktreeSession).toHaveBeenCalledTimes(1)
    expect(f.access.check(f.draft, { ...f.request, reviewVersion: 1 })).toBe('This review is outdated')
    f.section.open = false
    expect(f.access.check(f.draft, { ...f.request, reviewVersion: 2 })).toContain('no longer belongs')
  })

  it('rejects stale worktree versions even if the source workflow still exists', async () => {
    const f = fixture()
    f.snapshot.sessions[0].worktreeView = { version: 2 } as NonNullable<typeof f.snapshot.sessions[0]['worktreeView']>
    expect(await f.access.start(f.draft, { ...f.request, reviewVersion: 1 }, [], {})).toMatchObject({ ok: false, code: 'stale', detail: 'This review is outdated' })
    expect(f.finishWorktreeSession).not.toHaveBeenCalled()
  })

  it('admits only the current source workflow scope, VCS, action and revision', async () => {
    const f = fixture()
    expect(f.access.offers('session', 'svn', 'Q:/source')).toBe(true)
    expect(f.access.offers('session', 'git', 'Q:/source')).toBe(false)
    expect(f.access.offers('other', 'svn', 'Q:/source')).toBe(false)
    expect(f.access.offers('session', 'svn', 'Q:/elsewhere')).toBe(false)
    for (const request of [{ ...f.request, revision: 6 }, { ...f.request, workflowId: 'other' }])
      expect(await f.access.start(f.draft, request, ['Q:/source/file'], { 'Q:/source/file': 'hash' })).toMatchObject({ ok: false, code: 'stale' })
    expect(f.finishWorktreeSession).not.toHaveBeenCalled()
    expect(await f.access.start(f.draft, f.request, ['Q:/source/file'], { 'Q:/source/file': 'hash' })).toMatchObject({ ok: true })
    expect(f.finishWorktreeSession).toHaveBeenCalledWith('session', { choice: 'commit', requestedBy: 'window',
      selection: ['Q:/source/file'], message: 'Reviewed', messageSource: 'unknown', acknowledgedFindings: undefined, reviewed: { 'Q:/source/file': 'hash' } })
  })

  it('marks a matching kept message, without relabelling a newer edit or another scope', () => {
    const f = fixture()
    const list = vi.fn(() => [{ sessionId: 'session', actionId: 'kept', message: 'Reviewed', messageSource: 'kept-attempt', removal: 'kept', at: 100, worktreePath: 'Q:/source' }])
    const access = new VersioningWorkflowAccess({ snapshot: () => f.snapshot, finishWorktreeSession: f.finishWorktreeSession }, { list } as never)
    expect(access.messageSource({ ...f.draft, messageAt: 50 })).toBe('kept-attempt')
    expect(access.messageSource({ ...f.draft, messageAt: 101 })).toBeUndefined()
    expect(access.messageSource({ ...f.draft, scopeRoot: 'Q:/other' })).toBeUndefined()
    expect(access.messageSource({ ...f.draft, message: 'Changed' })).toBeUndefined()
  })

  it('keeps waiting, running and proved outcomes separate from a missing source result', () => {
    const f = fixture()
    expect(f.access.state(f.draft)).toEqual({ kind: 'waiting', detail: 'Review files' })
    f.section.actions = []
    f.section.rounds[0].steps[0].state = 'running'
    expect(f.access.state(f.draft)).toEqual({ kind: 'running' })
    f.section.open = false
    expect(f.access.state(f.draft).kind).toBe('uncertain')
    f.snapshot.sessions[0].retiredWorktree = { worktreePath: 'Q:/source', revisions: ['repo:r43'] }
    expect(f.access.state(f.draft)).toEqual({ kind: 'done', revision: 'repo:r43', output: 'Review files' })
  })

  it('reads a closed Finish that a later Finish of the worktree replaced as replaced, not uncertain', () => {
    const f = fixture()
    const sections = f.snapshot.sessions[0].actions!.sections as unknown as Record<string, unknown>[]
    f.section.open = false
    f.section.actions = []
    sections.push({ workflowId: 'script:run', kind: 'script', open: true, summary: 'Running', actions: [], rounds: [] })
    expect(f.access.state(f.draft).kind).toBe('uncertain')
    sections.push({ ...f.section, workflowId: 'corrective', open: true, summary: 'Updating the worktree' })
    expect(f.access.state(f.draft)).toEqual({ kind: 'replaced', detail: expect.stringContaining('A later Finish') })
    sections.splice(0, 1)
    expect(f.access.state(f.draft).kind).toBe('replaced')
  })
})


it('finds the exact durable SVN receipt when the session was removed before the first review reread', () => {
  const f = fixture()
  const record = { actionId: 'finish', sessionId: 'session', worktreePath: 'Q:/source', at: 101,
    result: 'committed', lines: ['Published'], revisions: [{ repository: 'svn://source', revision: 43 }] }
  const list = vi.fn(() => [record])
  const access = new VersioningWorkflowAccess({ snapshot: () => f.snapshot, finishWorktreeSession: f.finishWorktreeSession }, { list } as never)
  f.snapshot.sessions = []
  expect(access.state(f.draft)).toEqual({ kind: 'done', revision: 'svn://source:r43', output: 'Published' })
  expect(list).toHaveBeenCalledWith({ sessionId: 'session' })
  record.actionId = 'another'
  expect(access.state(f.draft).kind).toBe('uncertain')
  record.actionId = 'finish'; record.at = 99
  expect(access.state(f.draft).kind).toBe('uncertain')
  record.at = 101; record.worktreePath = 'Q:/other'
  expect(access.state(f.draft).kind).toBe('uncertain')
})
