import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SessionRecord, SessionRecordSvnAction } from '../../sessionManager/worktreeSessionRecords'
import { SvnResolverLauncher } from './svnResolverLauncher'

describe('lib-orchestrator/sessionManager/lifecycle/svnResolverLauncher', () => {
  const rootConst = 'Q:\\Work\\App\\.worktrees\\014-fix-login'
  const briefConst = 'L:\\logs\\s1\\a1-conflicts.txt'
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function directory(): string {
    const made = mkdtempSync(join(tmpdir(), 'jamat-v3-svn-resolver-'))
    created.push(made)
    return made
  }

  function parentOf(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      sessionId: 's1',
      kind: 'agent',
      title: '014 - fix login',
      createdAt: 0,
      life: 'ended',
      directory: { mode: 'project', categoryId: 'work', projectPath: 'Q:\\Work\\App' },
      binding: null,
      agent: { agentId: 'claude', launchMode: 'new', nativeSessionId: 'native-1' },
      transcriptCwd: rootConst,
      ...overrides,
    }
  }

  function action(overrides: Partial<SessionRecordSvnAction> = {}): SessionRecordSvnAction {
    return {
      kind: 'finish', actionId: 'a1', stage: 'resolving', runId: 'r1', root: rootConst, checks: [], checkCursor: 0, rootCursor: 0,
      rounds: { incoming: 0, outOfDate: 0, lock: 0 }, evidence: [], requestedBy: 'window', startedAt: 0,
      conflicts: { paths: ['a.txt'], before: ['a.txt'], at: 1_000 }, resolverSpent: true,
      ...overrides,
    }
  }

  it('forks a Claude worker in the directory its conversation ran in', () => {
    expect(SvnResolverLauncher.specOf(parentOf(), { root: rootConst, briefFile: briefConst })).toEqual({
      kind: 'agent',
      directory: { mode: 'adHoc', path: rootConst },
      agent: { agentId: 'claude', mode: 'fork', forkParentId: 'native-1', initialPrompt: SvnResolverLauncher.promptOf(briefConst) },
      title: 'Resolve conflicts 014-fix-login',
    })
  })

  it('starts a fresh Claude for a Codex worker, a worker without a native id and a conversation from outside the worktree', () => {
    for (const parent of [
      parentOf({ agent: { agentId: 'codex', launchMode: 'new', nativeSessionId: 'codex-1' } }),
      parentOf({ agent: { agentId: 'claude', launchMode: 'continue' } }),
      parentOf({ transcriptCwd: 'Q:\\Work\\App' }),
      parentOf({ kind: 'shell', agent: undefined, transcriptCwd: undefined }),
    ])
      expect(SvnResolverLauncher.specOf(parent, { root: rootConst, briefFile: briefConst })).toEqual({
        kind: 'agent',
        directory: { mode: 'adHoc', path: rootConst },
        agent: { agentId: 'claude', mode: 'new', initialPrompt: SvnResolverLauncher.promptOf(briefConst) },
        title: 'Resolve conflicts 014-fix-login',
      })
  })

  it('in a main copy forks a coordinator that ran there, never a worker whose worktree below it is gone', () => {
    const mainCopy = 'Q:\\Work\\App'
    expect(SvnResolverLauncher.specOf(parentOf({ transcriptCwd: `${mainCopy}\\src` }), { root: mainCopy, briefFile: briefConst }))
      .toMatchObject({ directory: { mode: 'adHoc', path: `${mainCopy}\\src` }, agent: { mode: 'fork', forkParentId: 'native-1' } })
    expect(SvnResolverLauncher.specOf(parentOf(), { root: mainCopy, briefFile: briefConst }))
      .toMatchObject({ directory: { mode: 'adHoc', path: mainCopy }, agent: { mode: 'new' }, title: 'Resolve conflicts App' })

    const brief = SvnResolverLauncher.briefOf({ kind: 'update-main', title: '014 - fix login', root: mainCopy, paths: ['a.txt'] })
    expect(brief).toContain(`Main copy: ${mainCopy}`)
    expect(brief).toContain('local changes')
    expect(brief).toContain('shows the merge as a diff')
    expect(brief).not.toContain('commit review')
  })

  it('names the brief in a prompt of one line, and the brief lists the conflicts, the session and the rules', () => {
    const prompt = SvnResolverLauncher.promptOf(briefConst)
    expect(prompt).toContain(briefConst)
    expect(prompt).not.toMatch(/[\r\n]/)

    const brief = SvnResolverLauncher.briefOf({ kind: 'finish', title: '014 - fix login', root: rootConst, paths: ['a.txt', 'src/b.ts'] })
    expect(brief).toContain('Session: 014 - fix login')
    expect(brief).toContain(`Working copy: ${rootConst}`)
    expect(brief).toContain('- a.txt\n- src/b.ts\n')
    expect(brief).toMatch(/Run no command/)
    expect(brief).not.toContain('\r')
  })

  it('is overdue only past 20 minutes of a resolver nobody judged yet', () => {
    const limit = 1_000 + SvnResolverLauncher.limitMillisecondsConst
    expect(SvnResolverLauncher.overdue(action(), limit)).toBe(false)
    expect(SvnResolverLauncher.overdue(action(), limit + 1)).toBe(true)
    expect(SvnResolverLauncher.overdue(action({ verdict: { kind: 'succeeded' } }), limit + 1)).toBe(false)
    expect(SvnResolverLauncher.overdue(action({ needs: { kind: 'conflict', reason: 'x', at: 2 } }), limit + 1)).toBe(false)
    expect(SvnResolverLauncher.overdue(action({ stage: 'verifying' }), limit + 1)).toBe(false)
    expect(SvnResolverLauncher.overdue(action({ conflicts: undefined }), limit + 1)).toBe(false)
  })

  it('finds Claude on Windows as cmd.exe would, through every PATHEXT extension, and answers why not otherwise (UA1-J08-8)', () => {
    const image = directory()
    writeFileSync(join(image, 'claude.exe'), '')
    const shim = directory()
    writeFileSync(join(shim, 'claude.cmd'), '')
    writeFileSync(join(shim, 'claude.ps1'), '')
    // npm's own shim without its script, or a stand-in written by hand: the one-line prompt reaches it through cmd.exe.
    const bare = directory()
    writeFileSync(join(bare, 'claude.cmd'), '')
    const batch = directory()
    writeFileSync(join(batch, 'claude.bat'), '')
    const empty = directory()

    expect(SvnResolverLauncher.claudeProblem('win32', { PATH: image, PATHEXT: '.EXE;.CMD' })).toBeNull()
    expect(SvnResolverLauncher.claudeProblem('win32', { PATH: shim, PATHEXT: '.EXE;.CMD' })).toBeNull()
    expect(SvnResolverLauncher.claudeProblem('win32', { PATH: bare, PATHEXT: '.EXE;.CMD' })).toBeNull()
    expect(SvnResolverLauncher.claudeProblem('win32', { PATH: batch })).toBeNull()
    expect(SvnResolverLauncher.claudeProblem('win32', { PATH: batch, PATHEXT: '.EXE;.CMD' }))
      .toBe('claude was not found on PATH (searched for claude with the PATHEXT extensions .exe, .cmd)')
    expect(SvnResolverLauncher.claudeProblem('win32', { PATH: empty, PATHEXT: '.EXE;.CMD' }))
      .toBe('claude was not found on PATH (searched for claude with the PATHEXT extensions .exe, .cmd)')
    expect(SvnResolverLauncher.claudeProblem('linux', { PATH: empty })).toBeNull()
  })

  it('counts a file with a marker line, a binary file and a missing file as unresolved', async () => {
    const root = directory()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'clean.txt'), 'one\n========\nheading\n==\n')
    writeFileSync(join(root, 'mine.txt'), 'one\n<<<<<<< .mine\ntwo\n')
    writeFileSync(join(root, 'base.txt'), 'one\r\n||||||| .r4\r\n')
    writeFileSync(join(root, 'middle.txt'), 'one\r\n=======\r\ntwo\r\n')
    writeFileSync(join(root, 'src', 'theirs.txt'), 'one\n>>>>>>> .r5')
    writeFileSync(join(root, 'binary.bin'), Buffer.from([1, 0, 2]))

    const paths = ['clean.txt', 'mine.txt', 'base.txt', 'middle.txt', 'src/theirs.txt', 'binary.bin', 'gone.txt']
    expect(await SvnResolverLauncher.markersIn(root, paths))
      .toEqual(['mine.txt', 'base.txt', 'middle.txt', 'src/theirs.txt', 'binary.bin', 'gone.txt'])
  })
})
