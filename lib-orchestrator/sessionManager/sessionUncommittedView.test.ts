import { describe, expect, it } from 'vitest'

import type { SessionRecord } from './records/sessionRecord.types'
import type { SessionInfo } from './sessionManagerApi.types'
import { SessionUncommittedCandidates } from './sessionUncommittedView'

describe('lib-orchestrator/sessionManager/sessionUncommittedView', () => {
  const directory = { mode: 'project', categoryId: 'code', projectPath: 'Q:/Repo/app' } as const

  function record(sessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId,
      kind: 'agent',
      title: `${sessionId} agent`,
      directory,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: `native-${sessionId}` },
      binding: null,
      life: 'live',
      createdAt: 1,
      ...overrides,
    }
  }

  function info(sessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      sessionId,
      kind: 'agent',
      title: `${sessionId} agent`,
      titleParts: { number: sessionId, name: 'agent' },
      tabTitle: `app - ${sessionId} agent`,
      directory,
      project: { kind: 'none' },
      life: 'live',
      activity: 'idle',
      admits: [],
      ...overrides,
    }
  }

  const ids = (records: SessionRecord[], infos: SessionInfo[]) =>
    SessionUncommittedCandidates.of(records, infos).map((candidate) => candidate.sessionId)

  it('takes live and ended agent sessions that name their conversation, with the transcript directory apart', () => {
    const candidates = SessionUncommittedCandidates.of(
      [record('live'), record('ended', { life: 'ended', transcriptCwd: 'Q:/Repo' })],
      [info('live'), info('ended', { life: 'ended' })],
    )
    expect(candidates).toEqual([
      { sessionId: 'live', agentId: 'claude', nativeSessionId: 'native-live', cwd: 'Q:/Repo/app', transcriptCwd: 'Q:/Repo/app', life: 'live' },
      { sessionId: 'ended', agentId: 'claude', nativeSessionId: 'native-ended', cwd: 'Q:/Repo/app', transcriptCwd: 'Q:/Repo', life: 'ended' },
    ])
  })

  it('never takes a worktree, retired worktree, script, setup or resolve session', () => {
    const worktree = { worktreePath: 'Q:/Repo/.worktrees/task', repositoryRoot: 'Q:/Repo', branch: 'jamat/task', baseCommit: 'abc' }
    expect(ids(
      [record('worktree', { worktree }), record('retired'), record('script'), record('setup'), record('resolve')],
      [
        info('worktree'),
        info('retired', { retiredWorktree: {} as NonNullable<SessionInfo['retiredWorktree']> }),
        info('script', { script: {} as NonNullable<SessionInfo['script']> }),
        info('setup', { setupFor: 'parent' }),
        info('resolve', { resolveFor: 'parent' }),
      ],
    )).toEqual([])
  })

  it('never takes a shell, a starting or lost session, one without a conversation id, or a record no longer composed', () => {
    const shell = record('shell', { kind: 'shell', agent: undefined })
    const noId = record('no-id', { agent: { agentId: 'codex', launchMode: 'new' } })
    expect(ids(
      [shell, record('starting'), record('lost'), noId, record('gone')],
      [info('shell', { kind: 'shell', activity: null }), info('starting', { life: 'starting' }), info('lost', { life: 'lost' }), info('no-id')],
    )).toEqual([])
  })
})
