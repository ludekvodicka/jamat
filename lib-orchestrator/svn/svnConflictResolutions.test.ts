import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { SvnConflictApply, SvnConflictJournal, SvnConflictKind, SvnConflictOption } from './svn.types'
import { SvnConflictResolutions } from './svnConflictResolutions'

describe('lib-orchestrator/svn/svnConflictResolutions', () => {
  const created: string[] = []

  afterEach(() => {
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /** svn as a list of answers: each call takes the next, and every call is logged as its arguments. */
  class ScriptedSvn implements CommandRunner {
    readonly calls: string[] = []
    answers: Partial<CommandOutcome>[] = []
    run(_cwd: string, args: string[]): Promise<CommandOutcome> {
      this.calls.push(args.filter((arg) => arg !== '--non-interactive').join(' '))
      const next = this.answers.shift() ?? {}
      return Promise.resolve({ code: 0, stdout: '', stderr: '', failure: null, ...next })
    }
  }

  function harness(): { root: string; savedDir: string; svn: ScriptedSvn; executor: SvnConflictResolutions; journals: [SvnConflictJournal, readonly string[]][]
    write: (base: string, path: string, text: string) => void; input: (path: string, kind: SvnConflictKind, option: SvnConflictOption, journal?: SvnConflictJournal) => SvnConflictApply } {
    const directory = mkdtempSync(join(tmpdir(), 'jamat-v3-conflict-resolutions-'))
    created.push(directory)
    const root = join(directory, 'wc')
    const savedDir = join(directory, 'results', 'a1', 'saved')
    mkdirSync(root, { recursive: true })
    const svn = new ScriptedSvn()
    const journals: [SvnConflictJournal, readonly string[]][] = []
    return {
      root, savedDir, svn, journals,
      executor: new SvnConflictResolutions({ svn, markersIn: async () => [], now: () => Date.UTC(2026, 9, 13, 12) }),
      write: (base, path, text) => {
        const file = join(base, ...path.split('/'))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, text)
      },
      input: (path, kind, option, journal) => ({
        root, savedDir, path, kind, option, journal: journal ?? null,
        onStep: async (next, diverged) => { journals.push([next, diverged]) },
      }),
    }
  }

  it('lists the steps of every option per kind, and throws for an option the kind has not or an unknown one', () => {
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-both')).toEqual(['save-local', 'remove-saved', 'revert-incoming', 'put-back', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('tree', 'take-incoming')).toEqual(['save-local', 'remove-saved', 'revert-incoming'])
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-mine')).toEqual(['save-sidecars', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('tree', 'merged')).toEqual(['save-sidecars', 'accept-working'])
    for (const kind of ['text', 'property'] as const) {
      expect(SvnConflictResolutions.stepsOf(kind, 'take-incoming')).toEqual(['save-sidecars', 'accept-theirs-full'])
      expect(SvnConflictResolutions.stepsOf(kind, 'keep-mine')).toEqual(['save-sidecars', 'accept-mine-full'])
      expect(SvnConflictResolutions.stepsOf(kind, 'merged')).toEqual(['save-sidecars', 'no-markers', 'accept-working'])
      expect(SvnConflictResolutions.stepsOf(kind, 'union')).toEqual(['save-sidecars', 'union-properties', 'accept-working'])
      expect(() => SvnConflictResolutions.stepsOf(kind, 'keep-both')).toThrow(/no keep-both/)
    }
    expect(SvnConflictResolutions.stepsOf('diverged', 'take-incoming')).toEqual([])
    expect(SvnConflictResolutions.stepsOf('diverged', 'keep-mine')).toEqual(['restore-saved'])
    expect(SvnConflictResolutions.stepsOf('diverged', 'merged')).toEqual(['no-markers'])
    expect(() => SvnConflictResolutions.stepsOf('tree', 'union')).toThrow(/no union/)
    expect(() => SvnConflictResolutions.stepsOf('tree', 'squash' as SvnConflictOption)).toThrow(/Unknown conflict option/)
    expect(() => SvnConflictResolutions.stepsOf('moved' as SvnConflictKind, 'merged')).toThrow(/Unknown conflict kind/)
  })

  it('refuses a name svn cannot take, on the victim or below it, before any step', async () => {
    const it_ = harness()
    it_.write(it_.root, 'docs/ř.md', 'text')

    expect(await it_.executor.apply(it_.input('složka/a.md', 'text', 'take-incoming'))).toMatchObject({ ok: false, code: 'refused' })
    const below = await it_.executor.apply(it_.input('docs', 'tree', 'keep-both'))
    expect(below).toMatchObject({ ok: false, code: 'refused' })
    expect(!below.ok && below.detail).toContain('docs/ř.md')
    expect(it_.svn.calls).toEqual([])
    expect(it_.journals).toEqual([])
    expect(existsSync(it_.savedDir)).toBe(false)
  })

  it('removes only the files that still equal their saved copy, journals the step, and keeps the journal when the next step fails', async () => {
    const it_ = harness()
    it_.write(it_.root, 'engines/t1/brief.md', 'brief t1\n')
    it_.write(it_.root, 'engines/t1/report.md', 'report changed after the save\n')
    // save-local ran before a restart; report.md changed on disk since.
    it_.write(it_.savedDir, 'engines/t1/brief.md', 'brief t1\n')
    it_.write(it_.savedDir, 'engines/t1/report.md', 'report t1\n')
    it_.svn.answers = [{ code: 1, stderr: 'svn: E155010: the node was not found' }]

    const applied = await it_.executor.apply(it_.input('engines', 'tree', 'keep-both', { option: 'keep-both', done: 1 }))

    expect(applied).toMatchObject({ ok: false, code: 'svn-failed', detail: 'svn: E155010: the node was not found' })
    expect(existsSync(join(it_.root, 'engines', 't1', 'brief.md'))).toBe(false)
    expect(readFileSync(join(it_.root, 'engines', 't1', 'report.md'), 'utf8')).toBe('report changed after the save\n')
    expect(it_.journals).toEqual([[{ option: 'keep-both', done: 2 }, []]])
    expect(it_.svn.calls).toEqual(['revert -R -- engines@'])
    expect(readFileSync(join(dirname(it_.savedDir), 'fixes.log'), 'utf8').split('\n')).toEqual([
      '2026-10-13T12:00:00.000Z engines keep-both remove-saved done',
      '2026-10-13T12:00:00.000Z engines keep-both revert-incoming failed: svn: E155010: the node was not found',
      '',
    ])
  })

  it('saves first and never replaces an earlier copy; a journal of another option starts that option from its first step', async () => {
    const it_ = harness()
    it_.write(it_.root, 'src/a.ts', 'the working file\n')
    it_.write(it_.savedDir, 'src/a.ts', 'saved by an earlier option\n')
    const info = `<?xml version="1.0"?><info><entry path="a.ts" kind="file"><url>file:///r/src/a.ts</url><repository><root>file:///r</root></repository>
<conflict operation="update" type="text"><prev-base-file>${join(it_.root, 'src', 'a.ts.r2').replace(/\\/g, '/')}</prev-base-file>
<prev-wc-file>${join(it_.root, 'src', 'a.ts.mine').replace(/\\/g, '/')}</prev-wc-file><cur-base-file>${join(it_.root, 'src', 'a.ts.r3').replace(/\\/g, '/')}</cur-base-file></conflict></entry></info>`
    it_.write(it_.root, 'src/a.ts.mine', 'mine\n')
    it_.write(it_.root, 'src/a.ts.r3', 'theirs\n')
    const conflicted = `<?xml version="1.0"?><status><target path="."><entry path="${join(it_.root, 'src', 'a.ts').replace(/\\/g, '/')}"><wc-status item="conflicted" props="none" revision="3"/></entry></target></status>`
    it_.svn.answers = [{ stdout: info }, { stdout: conflicted }, {}]

    expect(await it_.executor.apply(it_.input('src/a.ts', 'text', 'take-incoming', { option: 'merged', done: 2 }))).toEqual({ ok: true, value: undefined })

    expect(readFileSync(join(it_.savedDir, 'src', 'a.ts'), 'utf8')).toBe('saved by an earlier option\n')
    expect(readFileSync(join(it_.savedDir, 'src', 'a.ts.mine'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(it_.savedDir, 'src', 'a.ts.r3'), 'utf8')).toBe('theirs\n')
    expect(it_.svn.calls).toEqual(['info --xml --depth immediates -- .', 'status --xml --depth empty -- src/a.ts@',
      'resolve --accept theirs-full -- src/a.ts@'])
    expect(it_.journals.map(([journal]) => journal)).toEqual([{ option: 'take-incoming', done: 1 }, { option: 'take-incoming', done: 2 }])
  })

  it('resolves nothing svn no longer marks, so a repeat after a done resolve is a no-op', async () => {
    const it_ = harness()
    it_.svn.answers = [{ stdout: '<?xml version="1.0"?><status><target path="."></target></status>' }]
    expect(await it_.executor.apply(it_.input('src/a.ts', 'text', 'take-incoming', { option: 'take-incoming', done: 1 }))).toEqual({ ok: true, value: undefined })
    expect(it_.svn.calls).toEqual(['status --xml --depth empty -- src/a.ts@'])
  })

  it('refuses a merge that still holds markers, a union of a property that is no line list or mergeinfo, and a line list without its older revision', async () => {
    const it_ = harness()
    const marked = new SvnConflictResolutions({ svn: it_.svn, markersIn: async (_root, paths) => [...paths], now: () => 0 })
    expect(await marked.apply(it_.input('src/a.ts', 'text', 'merged', { option: 'merged', done: 1 })))
      .toMatchObject({ ok: false, code: 'refused', detail: 'src/a.ts still holds conflict markers; merge it, then settle it again' })
    expect(await it_.executor.apply({ ...it_.input('.', 'property', 'union', { option: 'union', done: 1 }), properties: ['svn:externals'] }))
      .toMatchObject({ ok: false, code: 'refused' })
    expect(await it_.executor.apply({ ...it_.input('.', 'property', 'union', { option: 'union', done: 1 }), properties: ['svn:ignore'] }))
      .toMatchObject({ ok: false, code: 'refused', detail: 'the merge of svn:ignore needs its value before the update' })
  })

  it('merges a line list three ways: the incoming order, without what the session removed, then what it added', () => {
    // r2 added coverage and removed tmp; the session added dist and removed logs.
    expect(SvnConflictResolutions.linesMerged('node_modules\ntmp\nlogs\n', 'node_modules\r\ntmp\r\ndist\r\n', 'node_modules\nlogs\ncoverage\n'))
      .toBe('node_modules\ncoverage\ndist\n')
    expect(SvnConflictResolutions.linesMerged('', 'node_modules\ndist\n', 'node_modules\ncoverage\n')).toBe('node_modules\ncoverage\ndist\n')
    expect(SvnConflictResolutions.linesMerged('a\n', '', 'a\nb\n')).toBe('b\n')
  })

  it('unions svn:mergeinfo ranges per source path, merging ranges that meet and keeping non-inheritable ones apart', () => {
    expect(SvnConflictResolutions.mergeinfoUnion('/branches/a:1-3,7\n/branches/b:5*', '/branches/a:4-5,9\r\n/branches/c:2'))
      .toBe('/branches/a:1-5,7,9\n/branches/b:5*\n/branches/c:2\n')
    expect(SvnConflictResolutions.mergeinfoUnion('/trunk:3-4*,6', '/trunk:5*,6-8')).toBe('/trunk:3-5*,6-8\n')
    expect(() => SvnConflictResolutions.mergeinfoUnion('/trunk:x', '')).toThrow(/cannot read/)
  })

  it('reads a line list before, in and after the update and sets the three-way merge; a value svn says is not set counts as empty', async () => {
    const it_ = harness()
    it_.svn.answers = [
      { stdout: '<?xml version="1.0"?><info><entry path="." kind="dir"><url>file:///r</url></entry></info>' },
      { stdout: 'node_modules\ndist' },
      { stdout: 'node_modules\ncoverage' },
      { code: 1, stderr: "svn: warning: W200017: Property 'svn:ignore' not found on '.@'" },
      {},
      { stdout: '<?xml version="1.0"?><status><target path="."></target></status>' },
    ]
    const applied = await it_.executor.apply({ ...it_.input('.', 'property', 'union'), properties: ['svn:ignore'], baseRevision: 7 })
    expect(applied).toEqual({ ok: true, value: undefined })
    expect(it_.svn.calls.slice(1, 5)).toEqual([
      'propget svn:ignore --no-newline -- .@',
      'propget svn:ignore --no-newline -r BASE -- .@',
      'propget svn:ignore --no-newline -r 7 -- .@',
      expect.stringMatching(/^propset svn:ignore -F .*union-[0-9a-f]+\.txt -- \.@$/),
    ])
  })
})
