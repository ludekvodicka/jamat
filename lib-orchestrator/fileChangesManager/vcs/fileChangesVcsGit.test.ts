import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GitCommandOutcome, GitCommandRunner } from '../../git/git.types'
import { FileChangesVcsGit } from './fileChangesVcsGit'

describe('lib-orchestrator/fileChangesManager/vcs/fileChangesVcsGit', () => {
  /*
   * Which revision a tool means by "the working copy's own baseline" is knowledge the tool has about
   * itself. It used to be two `adapter.id` branches in the manager, so a third VCS meant four files
   * to edit with only a runtime throw to catch a miss.
   */
  it('names its own default and history baselines', () => {
    const adapter = new FileChangesVcsGit()

    expect(adapter.defaultBaselineRef).to.deep.equal({ kind: 'git-head', revision: 'HEAD' })
    expect(adapter.historyBaselineRef('abc123'))
      .to.deep.equal({ kind: 'git-commit', revision: 'abc123' })
  })

  const created: string[] = []

  class Runner implements GitCommandRunner {
    readonly calls: { cwd: string; args: string[] }[] = []

    constructor(private readonly answer: (args: string[]) => GitCommandOutcome) {}

    async run(cwd: string, args: string[]): Promise<GitCommandOutcome> {
      this.calls.push({ cwd, args })
      return this.answer(args)
    }
  }

  afterEach(() => {
    for (const directory of created.splice(0))
      rmSync(directory, { recursive: true, force: true })
  })

  function repository(): { root: string; cwd: string } {
    const root = mkdtempSync(join(tmpdir(), 'jamat-git-vcs-'))
    const cwd = join(root, 'nested')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'changed.ts'), 'current\n', 'utf8')
    created.push(root)
    return { root, cwd }
  }

  function ok(stdout = ''): GitCommandOutcome {
    return { code: 0, stdout, stderr: '', failure: null }
  }

  it('scopes porcelain status to the cwd and preserves rename and staged state', async () => {
    const { root, cwd } = repository()
    const runner = new Runner((args) => args[0] === 'rev-parse'
      ? ok(`${root}\n`)
      : ok('M  nested/changed.ts\0R  nested/new.ts\0nested/old.ts\0?? nested/new-file.ts\0'))
    const vcs = new FileChangesVcsGit(runner)
    const detected = await vcs.detect(cwd)
    expect(detected).not.toBeNull()

    const result = await vcs.status(detected!)
    expect(result).toEqual({
      ok: true,
      value: [
        expect.objectContaining({
          repositoryPath: 'nested/changed.ts',
          status: 'modified',
          gitState: { index: 'M', worktree: ' ' },
        }),
        expect.objectContaining({
          repositoryPath: 'nested/new.ts',
          previousRepositoryPath: 'nested/old.ts',
          status: 'renamed',
        }),
        expect.objectContaining({ repositoryPath: 'nested/new-file.ts', status: 'untracked' }),
      ],
    })
    expect(runner.calls[1].args.at(-1)).toBe(':(literal)nested')
  })

  it('combines an explicit base diff with index, worktree, conflicts and untracked files', async () => {
    const { root, cwd } = repository()
    for (const name of ['committed.ts', 'untracked.ts', 'conflict.ts'])
      writeFileSync(join(cwd, name), `${name}\n`, 'utf8')
    const runner = new Runner((args) => {
      const command = args.findIndex((argument) => argument === 'rev-parse'
        || argument === 'diff' || argument === 'status')
      if (args[command] === 'rev-parse' && args.includes('--show-toplevel')) return ok(`${root}\n`)
      if (args[command] === 'rev-parse') return ok('abcdef0123456789\n')
      if (args[command] === 'diff')
        return ok('A\0nested/committed.ts\0M\0nested/changed.ts\0')
      if (args[command] === 'status')
        return ok(' M nested/changed.ts\0?? nested/untracked.ts\0UU nested/conflict.ts\0'
          + ' D nested/reverted-to-base.ts\0')
      throw new Error(JSON.stringify(args))
    })
    const prefix = ['--git-dir', join(root, 'store.git'), '--work-tree', root]
    const vcs = new FileChangesVcsGit(runner, prefix)
    const detected = await vcs.detect(cwd)

    const result = await vcs.statusAgainst(detected!, 'creation-base')

    expect(result).toEqual({
      ok: true,
      value: {
        revision: 'abcdef0123456789',
        entries: [
          expect.objectContaining({ repositoryPath: 'nested/committed.ts', status: 'added' }),
          expect.objectContaining({
            repositoryPath: 'nested/changed.ts',
            status: 'modified',
            gitState: { index: ' ', worktree: 'M' },
          }),
          expect.objectContaining({ repositoryPath: 'nested/untracked.ts', status: 'untracked' }),
          expect.objectContaining({ repositoryPath: 'nested/conflict.ts', status: 'conflicted' }),
        ],
      },
    })
    if (result.ok)
      expect(result.value.entries.some((entry) =>
        entry.repositoryPath === 'nested/reverted-to-base.ts')).toBe(false)
    const verify = runner.calls.find((call) => call.args.includes('--verify'))
    expect(verify?.args).toEqual([
      ...prefix, 'rev-parse', '--verify', '--end-of-options', 'creation-base^{commit}',
    ])
    const diff = runner.calls.find((call) => call.args.includes('diff'))
    expect(diff?.args.at(-1)).toBe(':(literal)nested')
  })

  it('reports an invalid explicit base instead of treating it as a clean tree', async () => {
    const { root, cwd } = repository()
    const runner = new Runner((args) => args.includes('--show-toplevel')
      ? ok(`${root}\n`)
      : { code: 128, stdout: '', stderr: 'fatal: Needed a single revision', failure: null })
    const vcs = new FileChangesVcsGit(runner)
    const detected = await vcs.detect(cwd)

    expect(await vcs.statusAgainst(detected!, 'missing')).toEqual({
      ok: false,
      detail: 'fatal: Needed a single revision',
    })
    expect(runner.calls.some((call) => call.args.includes('diff'))).toBe(false)
  })

  /**
   * Everything after `--` is a pathspec, and a pathspec is a pattern: `[`, `]`, `*` and `?` are legal
   * in a directory name. A session in `app [old]` asked git about a class matching one character out
   * of {o,l,d}, so git answered about nothing - and an empty answer here reads as `0 changed` in the
   * panel and a CLEAN mark on the session, which is what Finish reads before throwing work away.
   */
  it('asks git about the scope as a path, never as a pattern', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jamat-git-vcs-'))
    const cwd = join(root, 'app [old]')
    mkdirSync(cwd)
    created.push(root)
    const runner = new Runner((args) => args[0] === 'rev-parse' ? ok(`${root}\n`) : ok(''))
    const vcs = new FileChangesVcsGit(runner)
    const detected = await vcs.detect(cwd)

    await vcs.status(detected!)
    await vcs.dirty(detected!)

    for (const call of runner.calls.slice(1))
      expect(call.args.at(-1)).toBe(':(literal)app [old]')
  })

  /**
   * One commit that cannot be read used to throw from inside the fan-out, which discarded the other
   * ninety-nine - and this method's own contract returns a result on failure rather than throwing,
   * the way `status` and `dirty` beside it do.
   */
  /**
   * More than one commit, which nothing checked: the mock returned a single record without the
   * trailing newline, and the smoke repository has one commit. Splitting on the record separator and
   * stripping the newline that follows it are needed for exactly the case neither of them had, so
   * merging every commit into one stayed green.
   */
  it('reads every commit the log returned, in the order it returned them', async () => {
    const { root, cwd } = repository()
    const runner = new Runner((args) => {
      if (args[0] === 'rev-parse') return ok(`${root}\n`)
      if (args[0] === 'log')
        return ok('\x1eaaaaaaaaaaaa\x00Ada\x002026-08-01T10:00:00Z\x00first\x00\n'
          + '\x1ebbbbbbbbbbbb\x00Bob\x002026-08-02T10:00:00Z\x00second\x00\n')
      return ok('')
    })
    const vcs = new FileChangesVcsGit(runner)
    const detected = await vcs.detect(cwd)

    const result = await vcs.history(detected!, 10)

    if (!result.ok) throw new Error('history refused')
    expect(result.value.map((group) => group.revision))
      .to.deep.equal(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    expect(result.value.map((group) => group.author)).to.deep.equal(['Ada', 'Bob'])
    expect(result.value.map((group) => group.message)).to.deep.equal(['first', 'second'])
  })

  it('keeps the commits it could read when one of them fails', async () => {
    const { root, cwd } = repository()
    const runner = new Runner((args) => {
      if (args[0] === 'rev-parse') return ok(`${root}\n`)
      if (args[0] === 'log')
        // Two records, the way real `git log` prints them: a record separator, four
        // NUL-delimited fields, and a newline between one record and the next.
        return ok('\x1eaaaaaaaaaaaa\x00Ada\x002026-08-01T10:00:00Z\x00first\x00\n'
          + '\x1ebbbbbbbbbbbb\x00Ada\x002026-08-02T10:00:00Z\x00second\x00\n')
      if (args.includes('bbbbbbbbbbbb'))
        return { code: 128, stdout: '', stderr: 'fatal: bad object', failure: null }
      return ok('')
    })
    const vcs = new FileChangesVcsGit(runner)
    const detected = await vcs.detect(cwd)

    const result = await vcs.history(detected!, 10)

    expect(result.ok).to.equal(true)
    if (!result.ok) throw new Error('history refused')
    expect(result.value.map((group) => group.revision)).to.deep.equal(['aaaaaaaaaaaa'])
  })

  it('returns commit metadata and changed paths, including old rename path', async () => {
    const { root, cwd } = repository()
    const runner = new Runner((args) => {
      if (args[0] === 'rev-parse') return ok(`${root}\n`)
      if (args[0] === 'log')
        return ok('\x1eabcdef0123456789\x00Ada\x002026-08-14T10:00:00+02:00\x00message\x00')
      if (args[0] === 'diff-tree')
        return ok('R100\0nested/old.ts\0nested/changed.ts\0')
      throw new Error(JSON.stringify(args))
    })
    const vcs = new FileChangesVcsGit(runner)
    const detected = (await vcs.detect(cwd))!

    const result = await vcs.history(detected, 10)
    expect(result).toEqual({
      ok: true,
      value: [expect.objectContaining({
        revision: 'abcdef0123456789',
        label: 'abcdef012345',
        message: 'message',
        entries: [expect.objectContaining({
          status: 'renamed',
          previousRepositoryPath: 'nested/old.ts',
          repositoryPath: 'nested/changed.ts',
        })],
      })],
    })
  })

  // Real git wording, checked against `git show HEAD:<absent>`: this exact sentence is the whole
  // difference between "the file was added here" and "the baseline could not be read".
  it('returns missing when a baseline path does not exist in the ref', async () => {
    const { root, cwd } = repository()
    const message = "fatal: path 'nested/new.ts' does not exist in 'HEAD'"
    const runner = new Runner((args) => args[0] === 'rev-parse'
      ? ok(`${root}\n`)
      : { code: 128, stdout: '', stderr: message, failure: null })
    const vcs = new FileChangesVcsGit(runner)
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.readBaseline(detected, 'nested/new.ts', {
      kind: 'git-head',
      revision: 'HEAD',
    })).toEqual({ kind: 'missing', detail: message })
  })

  /**
   * Anything else that exits non-zero is NOT "the file was not there": a repository with no commit
   * yet, a broken object, a rename resolved to the wrong side. Reported as missing, the diff drew
   * the whole file as added - a picture of the working copy that is simply untrue.
   */
  it('returns unavailable when git failed for any other reason', async () => {
    const { root, cwd } = repository()
    const message = 'fatal: this operation must be run in a work tree'
    const runner = new Runner((args) => args[0] === 'rev-parse'
      ? ok(`${root}\n`)
      : { code: 128, stdout: '', stderr: message, failure: null })
    const vcs = new FileChangesVcsGit(runner)
    const detected = (await vcs.detect(cwd))!

    expect(await vcs.readBaseline(detected, 'nested/new.ts', {
      kind: 'git-head',
      revision: 'HEAD',
    })).toEqual({ kind: 'unavailable', detail: message })
  })

  it('answers dirty from whether the cheap porcelain probe printed anything', async () => {
    const { root, cwd } = repository()
    const runner = new Runner((args) => args[0] === 'rev-parse'
      ? ok(`${root}\n`)
      : ok(' M nested/changed.ts\0'))
    const vcs = new FileChangesVcsGit(runner)
    const detected = await vcs.detect(cwd)

    expect(await vcs.dirty(detected!)).toEqual({ ok: true, value: true })
    // The probe must not pay for the walk `status()` does: untracked files are counted, but only
    // one entry per untracked directory.
    expect(runner.calls[1].args).toContain('--untracked-files=normal')
    expect(runner.calls[1].args).not.toContain('--untracked-files=all')
  })

  it('answers clean on empty output and reports a failed probe rather than guessing', async () => {
    const { root, cwd } = repository()
    const clean = new Runner((args) => args[0] === 'rev-parse' ? ok(`${root}\n`) : ok(''))
    const vcs = new FileChangesVcsGit(clean)
    const detected = await vcs.detect(cwd)
    expect(await vcs.dirty(detected!)).toEqual({ ok: true, value: false })

    const broken = new FileChangesVcsGit(new Runner((args) => args[0] === 'rev-parse'
      ? ok(`${root}\n`)
      : { code: 128, stdout: '', stderr: 'not a git repository', failure: null }))
    expect(await broken.dirty(detected!)).toEqual({ ok: false, detail: 'not a git repository' })
  })
})
