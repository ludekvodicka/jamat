import { homedir } from 'node:os'

import { describe, expect, it } from 'vitest'

import type { SessionRecord } from './records/sessionRecord.types'
import type { SessionInfo } from './sessionManagerApi.types'
import { SessionWorkingDirectory } from './sessionWorkingDirectory'

describe('lib-orchestrator/sessionManager/sessionWorkingDirectory', () => {
  it('reads the effective snapshot directory and lets a worktree win', () => {
    expect(SessionWorkingDirectory.of(SessionWorkingDirectoryTest.info({
      directory: { mode: 'project', categoryId: 'code', projectPath: 'Q:/Repo' },
    }))).toBe('Q:/Repo')
    expect(SessionWorkingDirectory.of(SessionWorkingDirectoryTest.info({
      directory: { mode: 'adHoc', path: 'Q:/Scratch' },
    }))).toBe('Q:/Scratch')
    expect(SessionWorkingDirectory.of(SessionWorkingDirectoryTest.info({
      directory: { mode: 'default' },
    }))).toBeNull()
    expect(SessionWorkingDirectory.of(SessionWorkingDirectoryTest.info({
      directory: { mode: 'project', categoryId: 'code', projectPath: 'Q:/Repo' },
      worktree: {
        worktreePath: 'Q:/Repo/.worktrees/task',
        branch: 'jamat/task',
        baseCommit: 'abc',
        diff: null,
        baseMoved: false,
      },
    }))).toBe('Q:/Repo/.worktrees/task')
  })

  it('reads the launch-effective record directory, including the local default', () => {
    expect(SessionWorkingDirectory.ofRecord(SessionWorkingDirectoryTest.record({
      directory: { mode: 'default' },
    }))).toBe(homedir())
    expect(SessionWorkingDirectory.ofRecord(SessionWorkingDirectoryTest.record({
      directory: { mode: 'adHoc', path: 'Q:/Scratch' },
      worktree: {
        worktreePath: 'Q:/Repo/.worktrees/task',
        repositoryRoot: 'Q:/Repo',
        branch: 'jamat/task',
        baseCommit: 'abc',
      },
    }))).toBe('Q:/Repo/.worktrees/task')
  })
})

class SessionWorkingDirectoryTest {
  static info(overrides: Partial<SessionInfo>): SessionInfo {
    return {
      sessionId: 'session-1',
      kind: 'shell',
      title: '001 shell',
      titleParts: { number: '001', name: 'shell' },
      tabTitle: 'Project - 001 shell',
      directory: { mode: 'default' },
      project: { kind: 'none' },
      life: 'ended',
      activity: null,
      admits: [],
      ...overrides,
    }
  }

  static record(overrides: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: 'session-1',
      kind: 'shell',
      title: '001 shell',
      directory: { mode: 'default' },
      binding: null,
      life: 'ended',
      createdAt: 1,
      ...overrides,
    }
  }
}
