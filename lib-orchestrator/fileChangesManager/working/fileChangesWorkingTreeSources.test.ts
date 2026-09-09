import { describe, expect, it } from 'vitest'

import type { GitCommandOutcome, GitCommandRunner, RepoCommandContext } from '../../git/git.types'
import type { GitCheckpointStore } from '../../git/gitCheckpointStore'
import type {
  FileChangesWorkingTreeContext,
  FileChangesVcsDetection,
} from '../fileChangesManagerApi.types'
import type { FileChangesVcs } from '../vcs/fileChangesVcs.types'
import { FileChangesVcsGit } from '../vcs/fileChangesVcsGit'
import { FileChangesWorkingTreeSources } from './fileChangesWorkingTreeSources'

describe('lib-orchestrator/fileChangesManager/working/fileChangesWorkingTreeSources', () => {
  const rootConst = 'Q:/repo'
  const cwdConst = 'Q:/repo/package'

  class Runner implements GitCommandRunner {
    readonly calls: string[][] = []

    async run(_cwd: string, args: string[]): Promise<GitCommandOutcome> {
      this.calls.push(args)
      if (args.includes('--show-toplevel')) return Runner.ok(`${rootConst}\n`)
      if (args.includes('--verify')) return Runner.ok('abcdef0123456789\n')
      return Runner.ok()
    }

    private static ok(stdout = ''): GitCommandOutcome {
      return { code: 0, stdout, stderr: '', failure: null }
    }
  }

  function context(worktree = false): FileChangesWorkingTreeContext {
    return {
      sessionId: 'session',
      cwd: cwdConst,
      agent: null,
      worktree: worktree
        ? { worktreePath: rootConst, repositoryRoot: 'Q:/main', baseCommit: 'creation-base' }
        : null,
    }
  }

  function detection(id: 'svn'): FileChangesVcsDetection {
    return {
      id,
      root: rootConst,
      cwd: cwdConst,
      scopeRelativePath: 'package',
      scopeUrl: 'svn://example/repo/package',
      repositoryPathPrefix: '/repo/package',
    }
  }

  function svn(asked: string[]): FileChangesVcs {
    return {
      id: 'svn',
      defaultBaselineRef: { kind: 'svn-base', revision: 'BASE' },
      historyBaselineRef: (revision) => ({ kind: 'svn-revision', revision }),
      detect: async (cwd) => { asked.push(cwd); return detection('svn') },
      status: async () => ({ ok: true, value: [] }),
      dirty: async () => ({ ok: true, value: false }),
      history: async () => ({ ok: true, value: [] }),
      readBaseline: async () => ({ kind: 'missing', detail: 'not used' }),
    }
  }

  function store(
    existing: RepoCommandContext | null,
    belongs: boolean,
  ): Pick<GitCheckpointStore, 'existingContextOf' | 'worktreeBelongsToStore'> {
    return {
      existingContextOf: async () => ({ ok: true, value: existing }),
      worktreeBelongsToStore: async () => belongs,
    }
  }

  function subject(input: {
    existing: RepoCommandContext | null
    belongs?: boolean
    svnAsked?: string[]
  }): FileChangesWorkingTreeSources {
    return new FileChangesWorkingTreeSources({
      checkpointStore: store(input.existing, input.belongs ?? false),
      gitOf: (args) => new FileChangesVcsGit(new Runner(), args),
      svn: svn(input.svnAsked ?? []),
    })
  }

  it('defaults a main copy to SVN BASE and lets the caller switch to checkpoint', async () => {
    const existing = {
      root: rootConst,
      gitDirArgs: ['--git-dir', 'Q:/repo/.checkpoints/store.git', '--work-tree', rootConst],
      storeDir: 'Q:/repo/.checkpoints/store.git',
    }
    const sources = subject({ existing })

    const initial = await sources.read(context(), null)
    const selectedCheckpoint = await sources.read(context(), 'checkpoint')

    expect(initial.selection).toEqual({
      requested: null,
      selected: 'svn',
      available: ['svn', 'checkpoint'],
      fallbackReason: null,
    })
    expect(initial.selected?.baselineLabel).toBe('SVN BASE')
    expect(selectedCheckpoint.selection.selected).toBe('checkpoint')
    expect(selectedCheckpoint.selected?.baseline).toEqual({ kind: 'git-head', revision: 'HEAD' })
  })

  it('prefers the persisted creation base in a checkpoint worktree', async () => {
    const asked: string[] = []
    const sources = subject({ existing: null, belongs: true, svnAsked: asked })

    const result = await sources.read(context(true), null)

    expect(result.selection.available).toEqual(['worktree-base', 'checkpoint', 'svn'])
    expect(result.selection.selected).toBe('worktree-base')
    expect(result.selected?.baseline).toEqual({
      kind: 'git-commit',
      revision: 'abcdef0123456789',
    })
    expect(asked).toEqual([cwdConst])
  })

  it('does not call a foreign worktree a checkpoint worktree', async () => {
    const result = await subject({ existing: null, belongs: false }).read(context(true), null)

    expect(result.selection.available).toEqual(['worktree-base', 'svn'])
    expect(result.selection.available).not.toContain('checkpoint')
  })

  it('falls back to SVN when no checkpoint store exists without creating one', async () => {
    const result = await subject({ existing: null }).read(context(), 'checkpoint')

    expect(result.selection).toEqual({
      requested: 'checkpoint',
      selected: 'svn',
      available: ['svn'],
      fallbackReason: `Checkpoint is not available in ${cwdConst}; using SVN BASE`,
    })
  })

  it('reports a selected source exception as a warning instead of a clean view', async () => {
    const brokenSvn = svn([])
    brokenSvn.status = async () => { throw new Error('status exploded') }
    const sources = new FileChangesWorkingTreeSources({
      checkpointStore: store(null, false),
      gitOf: (args) => new FileChangesVcsGit(new Runner(), args),
      svn: brokenSvn,
    })

    const result = await sources.read(context(), null)

    expect(result.selected).toBeNull()
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual(['SVN BASE: status exploded'])
  })
})
