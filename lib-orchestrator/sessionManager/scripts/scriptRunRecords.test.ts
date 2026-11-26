import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SvnExecutable } from '../../svn/svnExecutable'
import { ScriptRunRecords } from './scriptRunRecords'

describe('lib-orchestrator/sessionManager/scripts/scriptRunRecords', () => {
  afterEach(() => vi.restoreAllMocks())
  const worktreePath = join('C:', 'project', '.worktrees', 'i12-fix')
  const link = { sessionId: 'p', phase: 'before', scriptId: 'declared', name: 'codegen', stepKey: 'k2' } as const

  it('writes a starting shell under its own pending pair, in the first step directory and with no worktree', () => {
    const commands = [
      { command: 'pnpm codegen', cwd: join(worktreePath, 'tools') },
      { command: 'pnpm lint', cwd: worktreePath },
    ]
    const run = ScriptRunRecords.shellRun({ runId: 'r', operationId: 'op', link, title: 'codegen i12-fix', commands, now: 7 })

    expect(run).toEqual({
      sessionId: 'r',
      kind: 'shell',
      title: 'codegen i12-fix',
      directory: { mode: 'adHoc', path: join(worktreePath, 'tools') },
      commands,
      scriptOf: link,
      binding: null,
      life: 'starting',
      pendingOperationId: 'op',
      pendingOperationKind: 'create',
      createdAt: 7,
    })
    expect(run.worktree).toBeUndefined()
  })

  // An empty list would be planned as an interactive shell that never exits.
  it('refuses a run with nothing to run', () => {
    expect(() => ScriptRunRecords.shellRun({ runId: 'r', operationId: 'op', link, title: 't', commands: [], now: 7 }))
      .toThrow('Script run r has no command to run')
  })

  it('writes a direct-process run in its own directory, with the tool and no shell commands', () => {
    const process = { tool: 'svn' as const, args: ['update', '-q', '--', '.'], cwd: worktreePath }
    const run = ScriptRunRecords.processRun({ runId: 'r', operationId: 'op', link, title: 'svn update', process, now: 7 })

    expect(run).toEqual({
      sessionId: 'r',
      kind: 'shell',
      title: 'svn update',
      directory: { mode: 'adHoc', path: worktreePath },
      process: { tool: 'svn', args: ['update', '-q', '--', '.'] },
      scriptOf: link,
      binding: null,
      life: 'starting',
      pendingOperationId: 'op',
      pendingOperationKind: 'create',
      createdAt: 7,
    })
    expect(run.commands).toBeUndefined()
    expect(run.worktree).toBeUndefined()
  })

  // Without UTF-8 activeCodePage, svn.exe reads its command line in the ANSI code page: `ř` would arrive as `r`.
  it('refuses an argument a direct process cannot take, and admits Unicode when UTF-8 svn is active', () => {
    const process = { tool: 'svn' as const, args: ['resolve', '--accept', 'working', '--', 'složka/ř.txt'], cwd: worktreePath }
    vi.spyOn(SvnExecutable, 'supportsUtf8Arguments').mockReturnValue(false)
    expect(() => ScriptRunRecords.processRun({ runId: 'r', operationId: 'op', link, title: 't', process, now: 7 }))
      .toThrow('Script run r has an argument a direct process cannot take: "složka/ř.txt"')
    vi.spyOn(SvnExecutable, 'supportsUtf8Arguments').mockReturnValue(true)
    expect(ScriptRunRecords.processRun({ runId: 'r', operationId: 'op', link, title: 't', process, now: 7 }).process)
      .toEqual({ tool: 'svn', args: process.args })
    expect(() => ScriptRunRecords.processRun({ runId: 'r', operationId: 'op', link, title: 't',
      process: { tool: 'svn', args: ['add', 'bad\nname.txt'], cwd: worktreePath }, now: 7 }))
      .toThrow('Script run r has an argument a direct process cannot take')
  })

  it('titles the install and a declared step after the worktree folder', () => {
    expect(ScriptRunRecords.titleOf({ scriptId: 'setup', name: 'setup' }, worktreePath)).toBe('Setup i12-fix')
    expect(ScriptRunRecords.titleOf({ scriptId: 'declared', name: 'codegen' }, worktreePath)).toBe('codegen i12-fix')
  })
})
