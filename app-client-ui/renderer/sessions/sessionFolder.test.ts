import { describe, expect, it } from 'vitest'

import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionFolder } from './sessionFolder'

const infoOf = (over: Partial<SessionInfo>): SessionInfo =>
  ({ sessionId: 's-1', directory: { mode: 'default' }, ...over }) as SessionInfo

describe('app-client-ui/renderer/sessions/sessionFolder', () => {
  it('names the project path of a project session', () => {
    expect(SessionFolder.ofDirectory({ mode: 'project', categoryId: 'c', projectPath: 'Q:/x' }))
      .toBe('Q:/x')
  })

  it('names the path of an ad-hoc session', () => {
    expect(SessionFolder.ofDirectory({ mode: 'adHoc', path: 'Q:/scratch' })).toBe('Q:/scratch')
  })

  // The library resolves this arm to `homedir()`, on the machine that spawns the child. This client
  // may not be that machine, so it has no path to draw and says so rather than naming its own home.
  it('has no path for the default directory, which is the Host machine to decide', () => {
    expect(SessionFolder.ofDirectory({ mode: 'default' })).toBeNull()
  })

  it('refuses a directory mode it does not know', () => {
    expect(() => SessionFolder.ofDirectory(
      { mode: 'elsewhere' } as unknown as SessionInfo['directory']))
      .toThrow('Unknown session directory: {"mode":"elsewhere"}')
  })

  // Where the session RUNS, not where it came from: a worktree session's repo is not its folder.
  it('prefers the worktree over the directory it was cut from', () => {
    expect(SessionFolder.ofSession(infoOf({
      directory: { mode: 'project', categoryId: 'c', projectPath: 'Q:/repo' },
      worktree: { worktreePath: 'Q:/repo/.worktrees/s-1' } as SessionInfo['worktree'],
    }))).toBe('Q:/repo/.worktrees/s-1')
  })

  it('falls back to the directory when there is no worktree', () => {
    expect(SessionFolder.ofSession(infoOf({
      directory: { mode: 'adHoc', path: 'Q:/scratch' },
    }))).toBe('Q:/scratch')
  })
})
