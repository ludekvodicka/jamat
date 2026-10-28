import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import * as files from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CommandOutcome, CommandRunner } from '../shared/commandInvoker.types'
import type { SvnConflictApply, SvnConflictJournal, SvnConflictKind, SvnConflictOption } from './svn.types'
import { SvnConflictResolutions } from './svnConflictResolutions'
import { SvnTextResolution } from './svnTextResolution'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

describe('lib-orchestrator/svn/svnConflictResolutions', () => {
  const created: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it.each(['keep-mine', 'take-incoming'] as const)('proves recovered %s only from its saved bytes and prior journal', async (option) => {
    const { root, savedDir, executor, input } = harness()
    mkdirSync(savedDir, { recursive: true })
    const request = input('a.bin', 'text', option, { option, done: 1 })
    const manifest = join(savedDir, `text-sides-${createHash('sha256').update('a.bin').digest('hex')}.json`)
    const source = option === 'keep-mine' ? 'a.bin.mine' : 'a.bin.r2'
    writeFileSync(manifest, JSON.stringify({ path: 'a.bin', mine: 'a.bin.mine', theirs: 'a.bin.r2' }))
    writeFileSync(join(savedDir, source), Buffer.from([0xff, 0xfe, 0]))
    writeFileSync(join(root, 'a.bin'), Buffer.from([0xff, 0xfe, 0]))
    expect(await executor.recoveredChoice(request)).toBe(option)
    expect(await executor.recoveredChoice({ ...request, journal: null })).toBeNull()
    expect(await executor.recoveredChoice({ ...request, journal: { option, done: 0 } })).toBeNull()
    writeFileSync(join(root, 'a.bin'), Buffer.from([0xfe, 0xff, 0]))
    expect(await executor.recoveredChoice(request)).toBeNull()
    expect(readFileSync(join(root, 'a.bin'))).toEqual(Buffer.from([0xfe, 0xff, 0]))
    writeFileSync(join(root, 'a.bin'), Buffer.from([0xff, 0xfe, 0]))
    writeFileSync(manifest, JSON.stringify({ path: 'another.bin', mine: source, theirs: source }))
    expect(await executor.recoveredChoice(request)).toBeNull()
    writeFileSync(manifest, '{')
    expect(await executor.recoveredChoice(request)).toBeNull()
    rmSync(manifest)
    expect(await executor.recoveredChoice(request)).toBeNull()
  })

  /** svn as a list of answers: each call takes the next, and every call is logged as its arguments. */
  class ScriptedSvn implements CommandRunner {
    readonly calls: string[] = []
    readonly inspections: string[] = []
    inspection = '<info><entry path="." kind="dir"><url>file:///r</url></entry></info>'
    answers: Partial<CommandOutcome>[] = []
    run(_cwd: string, args: string[]): Promise<CommandOutcome> {
      if (args[0] === 'status' && !args.includes('--depth'))
        return Promise.resolve({ code: 0, stdout: '<status><target path="."/></status>', stderr: '', failure: null })
      if (args[0] === 'info' && args.at(-1)?.endsWith('@')) {
        this.inspections.push(args.join(' '))
        return Promise.resolve({ code: 0, stdout: this.inspection, stderr: '', failure: null })
      }
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
    mkdirSync(join(root, '.svn'))
    writeFileSync(join(root, '.svn', 'wc.db'), 'fixture database')
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

  it('records its known local removals and restores before SVN commands, retaining earlier saved bytes', async () => {
    const h = harness()
    h.write(h.root, 'engines/t1.txt', 'session content')
    const observed: boolean[] = []
    const status = { stdout: '<?xml version="1.0"?><status><target path="."></target></status>' }
    h.svn.answers = [{}, status, status]
    const executor = new SvnConflictResolutions({ svn: h.svn, markersIn: async () => [], now: () => 0,
      afterFilesChanged: async (root) => { expect(root).toBe(h.root); observed.push(existsSync(join(root, 'engines/t1.txt'))) } })
    const run = h.svn.run.bind(h.svn)
    vi.spyOn(h.svn, 'run').mockImplementation(async (...args) => {
      if (args[1].includes('revert')) expect(observed).toEqual([false])
      if (args[1].includes('status') && args[1].includes('--depth')) expect(observed).toEqual([false, true])
      return run(...args)
    })
    expect(await executor.apply(h.input('engines', 'tree', 'keep-both'))).toMatchObject({ ok: true })
    expect(observed).toEqual([false, true])
    expect(readFileSync(join(h.savedDir, 'engines/t1.txt'), 'utf8')).toBe('session content')
    expect(readFileSync(join(h.root, 'engines/t1.txt'), 'utf8')).toBe('session content')
    expect(h.journals.at(-1)?.[0]).toEqual({ option: 'keep-both', done: 5 })
  })

  it.each([4, 5])('a keep-both resumed past put-back (done %i) reads the diverged files again, so none is lost', async (done) => {
    const h = harness()
    h.write(h.root, 'engines/brief.md', 'incoming brief\n')
    h.write(h.savedDir, 'engines/brief.md', 'session brief\n')
    h.svn.answers = [{ stdout: '<?xml version="1.0"?><status><target path="."></target></status>' }]
    expect(await h.executor.apply(h.input('engines', 'tree', 'keep-both', { option: 'keep-both', done }))).toMatchObject({ ok: true })
    expect(h.journals.flatMap(([, diverged]) => diverged)).toEqual(['engines/brief.md'])
    expect(h.journals.at(-1)?.[0]).toEqual({ option: 'keep-both', done: 5 })
    expect(readFileSync(join(h.root, 'engines/brief.md'), 'utf8')).toBe('incoming brief\n')
  })

  it('records only completed filesystem mutations when a later removal fails', async () => {
    const h = harness()
    h.write(h.root, 'engines/a.txt', 'first')
    h.write(h.root, 'engines/b.txt', 'second')
    h.write(h.savedDir, 'engines/a.txt', 'first')
    h.write(h.savedDir, 'engines/b.txt', 'second')
    const remove = files.rm
    vi.spyOn(files, 'rm').mockImplementationOnce(remove).mockRejectedValueOnce(new Error('second file is held'))
    const recorded = vi.fn(async () => {})
    const executor = new SvnConflictResolutions({ svn: h.svn, markersIn: async () => [], now: () => 0, afterFilesChanged: recorded })
    expect(await executor.apply(h.input('engines', 'tree', 'keep-both', { option: 'keep-both', done: 1 }))).toMatchObject({ ok: false, detail: 'second file is held' })
    expect(recorded).toHaveBeenCalledExactlyOnceWith(h.root)
    expect(h.svn.calls).toEqual([])
    expect(h.journals).toEqual([])
    expect(readFileSync(join(h.savedDir, 'engines/a.txt'), 'utf8')).toBe('first')
    expect(readFileSync(join(h.savedDir, 'engines/b.txt'), 'utf8')).toBe('second')
    expect(existsSync(join(h.root, 'engines/a.txt'))).toBe(false)
    expect(readFileSync(join(h.root, 'engines/b.txt'), 'utf8')).toBe('second')
  })

  it('stops before SVN and preserves the saved copy if recording a filesystem mutation fails', async () => {
    const h = harness()
    h.write(h.root, 'engines/t1.txt', 'session content')
    const executor = new SvnConflictResolutions({ svn: h.svn, markersIn: async () => [], now: () => 0,
      afterFilesChanged: async () => { throw new Error('fingerprint could not be saved') } })
    expect(await executor.apply(h.input('engines', 'tree', 'keep-both'))).toMatchObject({ ok: false, detail: 'fingerprint could not be saved' })
    expect(h.svn.calls).toEqual([])
    expect(h.journals.at(-1)?.[0]).toEqual({ option: 'keep-both', done: 1 })
    expect(readFileSync(join(h.savedDir, 'engines/t1.txt'), 'utf8')).toBe('session content')
  })

  it('leaves both full versions intact when atomic restore cannot replace the destination', async () => {
    const h = harness()
    h.write(h.root, 'a.txt', 'incoming complete')
    h.write(h.savedDir, 'a.txt', 'local complete')
    vi.mocked(files.rename).mockRejectedValueOnce(new Error('replace denied'))
    expect(await h.executor.apply(h.input('a.txt', 'diverged', 'keep-mine'))).toMatchObject({ ok: false })
    expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('incoming complete')
    expect(readFileSync(join(h.savedDir, 'a.txt'), 'utf8')).toBe('local complete')
    expect(await files.readdir(h.root)).toEqual(['.svn', 'a.txt'])
  })

  it.each([
    ['EBUSY', 'src/a.ts is open in another program; close it and choose the option again'],
    ['EPERM', 'src/a.ts is open in another program or read-only; close it or clear its read-only attribute, then choose the option again'],
    ['EACCES', 'src/a.ts is open in another program or read-only; close it or clear its read-only attribute, then choose the option again'],
  ])('names a file another program holds (%s) as locked, in words, and keeps the journal for the next choice', async (code, detail) => {
    const h = harness()
    h.write(h.root, 'src/a.ts', 'the working file\n')
    h.svn.answers = [{ stdout: '<info><entry path="src" kind="dir"><url>file:///r/src</url></entry></info>' }]
    const held = join(h.root, 'src', 'a.ts')
    vi.spyOn(files, 'copyFile').mockRejectedValueOnce(Object.assign(new Error(`${code}: resource busy or locked, copyfile '${held}'`),
      { code, path: held, dest: join(h.savedDir, 'src', 'a.ts.jamat.tmp') }))
    expect(await h.executor.apply(h.input('src/a.ts', 'text', 'take-incoming'))).toEqual({ ok: false, code: 'locked', detail })
    expect(h.journals).toEqual([])
  })

  /** svn info of a text conflict on src/a.ts with its .mine and .r3 on disk. */
  function textConflict(h: ReturnType<typeof harness>): string {
    h.write(h.root, 'src/a.ts', 'the working file\n')
    h.write(h.root, 'src/a.ts.mine', 'mine\n')
    h.write(h.root, 'src/a.ts.r3', 'theirs\n')
    return `<?xml version="1.0"?><info><entry path="a.ts" kind="file"><url>file:///r/src/a.ts</url><repository><root>file:///r</root></repository>
<conflict operation="update" type="text"><prev-wc-file>${join(h.root, 'src', 'a.ts.mine').replace(/\\/g, '/')}</prev-wc-file><cur-base-file>${join(h.root, 'src', 'a.ts.r3').replace(/\\/g, '/')}</cur-base-file></conflict></entry></info>`
  }

  it('names a working file another program holds for reading as open when Windows refuses to replace it, and keeps its bytes (UA1-J06-4)', async () => {
    const h = harness()
    const info = textConflict(h)
    h.svn.answers = [{ stdout: info }]
    h.svn.inspection = info
    const target = join(h.root, 'src', 'a.ts')
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(files.rename).mockImplementation(async (from, to) => {
      if (to === target) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${target}'`), { code: 'EPERM' })
      return rename(from, to)
    })
    try {
      expect(await h.executor.apply(h.input('src/a.ts', 'text', 'take-incoming')))
        .toEqual({ ok: false, code: 'locked', detail: 'src/a.ts is open in another program; close it and choose the option again' })
    } finally { vi.mocked(files.rename).mockImplementation(rename) }
    expect(readFileSync(target, 'utf8')).toBe('the working file\n')
    expect(h.journals.map(([journal]) => journal)).toEqual([{ option: 'take-incoming', done: 1 }])
  })

  it('says in words that an interrupted resolve left the working copy locked and which file stops it, then finishes its own queue (UA1-J06-1)', async () => {
    const h = harness()
    const info = textConflict(h)
    const r3 = join(h.root, 'src', 'a.ts.r3')
    const held = `svn: E720032: Can't remove file '${r3}': The process cannot access the file because it is being used by another process.`
    let locked = false
    let holder = true
    const svn: CommandRunner = { run: async (_cwd, args) => {
      const ok = (stdout: string): CommandOutcome => ({ code: 0, stdout, stderr: '', failure: null })
      switch (args[0]) {
        case 'info': return ok(info)
        case 'status': return ok(args.includes('--depth')
          ? `<status><target path="."><entry path="${target.replace(/\\/g, '/')}"><wc-status item="conflicted" props="none" revision="3"/></entry></target></status>`
          : `<status><target path="."><entry path="${h.root.replace(/\\/g, '/')}/src"><wc-status item="normal" props="none" wc-locked="${locked}" revision="3"/></entry></target></status>`)
        case 'resolve':
          locked = true
          writeFileSync(join(h.root, '.svn', 'wc.db'), 'queued by this resolve')
          return { code: 1, stdout: '', failure: null, stderr: `${held.replace('E720032', 'warning: W720032')}\nsvn: E155027: Failure occurred resolving one or more conflicts` }
        case 'cleanup':
          if (holder) return { code: 1, stdout: '', failure: null,
            stderr: `svn: E155009: Failed to run the WC DB work queue associated with '${h.root}', work item 102 (file-remove 102 src/a.ts.r3)\n${held}` }
          locked = false
          return ok('')
        default: throw new Error(`unexpected svn ${args.join(' ')}`)
      }
    } }
    const target = join(h.root, 'src', 'a.ts')
    const executor = new SvnConflictResolutions({ svn, markersIn: async () => [], now: () => Date.UTC(2026, 9, 19, 18) })
    const interrupted = await executor.apply(h.input('src/a.ts', 'text', 'keep-mine'))
    expect(interrupted).toEqual({ ok: false, code: 'locked', detail: 'src/a.ts.r3 is open in another program, so SVN could not finish settling src/a.ts '
      + 'and the working copy stays locked. Close that program, then choose the option again or press Check again; Jamat finishes its own SVN step first.' })
    expect(readFileSync(target, 'utf8')).toBe('mine\n')

    const retried = await executor.apply(h.input('src/a.ts', 'text', 'keep-mine', { option: 'keep-mine', done: 1 }))
    expect(retried).toEqual({ ok: false, code: 'locked', detail: `src/a.ts.r3 is open in another program, so Jamat could not finish its own interrupted SVN step `
      + `and the working copy ${h.root} stays locked. Close that program, then choose the option again or press Check again. Your working files were left as they are.` })
    expect(readFileSync(target, 'utf8')).toBe('mine\n')

    holder = false
    expect(await executor.recoverLocked(h.root, h.savedDir)).toEqual({ ok: true, value: undefined })
  })

  it('lists the steps of every option per kind, and throws for an option the kind has not or an unknown one', () => {
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-both')).toEqual(['save-local', 'remove-saved', 'revert-incoming', 'put-back', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('tree', 'take-incoming')).toEqual(['save-local', 'remove-saved', 'revert-incoming'])
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-mine')).toEqual(['save-sidecars', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('tree', 'merged')).toEqual(['save-sidecars', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('text', 'merged', undefined, true)).toEqual(['save-sidecars', 'write-merged', 'no-markers', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('property', 'merged', undefined, true)).toEqual(['save-sidecars', 'no-markers', 'accept-working'])
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

  it('carries keep-both of a move to the move target through svn\'s own move resolution, and keeps the other options of the tree', () => {
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-both', 'away')).toEqual(['save-sidecars', 'accept-mine-conflict'])
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-both', 'incoming')).toEqual(['save-sidecars', 'accept-incoming-move'])
    expect(SvnConflictResolutions.stepsOf('tree', 'keep-mine', 'away')).toEqual(['save-sidecars', 'accept-working'])
    expect(SvnConflictResolutions.stepsOf('tree', 'take-incoming', 'incoming')).toEqual(['save-local', 'remove-saved', 'revert-incoming'])
  })

  it('refuses keep-both of an incoming move whose new place svn cannot name, and leaves the path conflicted', async () => {
    const it_ = harness()
    it_.write(it_.root, 'src/e.txt', 'session edit')
    const marked = '<status><target path="."><entry path="src/e.txt"><wc-status item="added" props="none" tree-conflicted="true"/></entry></target></status>'
    it_.svn.inspection = '<info><entry path="src/e.txt" kind="file"><url>file:///r/src/e.txt</url><tree-conflict operation="update" kind="file" reason="edit" action="delete" victim="e.txt">'
      + '<version side="source-left" kind="file" path-in-repos="src/e.txt" repos-url="file:///r" revision="1"/><version side="source-right" kind="none" path-in-repos="src/e.txt" repos-url="file:///r" revision="2"/></tree-conflict></entry></info>'
    it_.svn.answers = [{ stdout: '<info><entry path="e.txt" kind="file"><url>file:///r/src/e.txt</url></entry></info>' }, { stdout: marked }, {}, { stdout: marked }]
    const refused = await it_.executor.apply({ ...it_.input('src/e.txt', 'tree', 'keep-both'), move: 'incoming' })
    expect(refused).toMatchObject({ ok: false, code: 'refused' })
    expect(!refused.ok && refused.detail).toBe('svn found no single place where the other commit moved src/e.txt; nothing changed. Carry the session\'s changes there by hand, then take incoming')
    expect(it_.svn.calls.filter((call) => call.startsWith('resolve'))).toEqual(['resolve --accept recommended -- src/e.txt@'])
    expect(readFileSync(join(it_.savedDir, 'src', 'e.txt'), 'utf8')).toBe('session edit')
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
    it_.svn.inspection = info

    expect(await it_.executor.apply(it_.input('src/a.ts', 'text', 'take-incoming', { option: 'merged', done: 2 }))).toEqual({ ok: true, value: undefined })

    expect(readFileSync(join(it_.savedDir, 'src', 'a.ts'), 'utf8')).toBe('saved by an earlier option\n')
    expect(readFileSync(join(it_.savedDir, 'src', 'a.ts.mine'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(it_.savedDir, 'src', 'a.ts.r3'), 'utf8')).toBe('theirs\n')
    expect(readFileSync(join(it_.root, 'src', 'a.ts'), 'utf8')).toBe('theirs\n')
    expect(it_.svn.calls).toEqual(['info --xml --depth immediates -- .', 'status --xml --depth empty -- src/a.ts@',
      'resolve --accept working -- src/a.ts@'])
    expect(it_.journals.map(([journal]) => journal)).toEqual([{ option: 'take-incoming', done: 1 }, { option: 'take-incoming', done: 2 }])
  })

  it('stages a chosen text side in the working copy administrative folder, never beside the working file', async () => {
    const it_ = harness()
    it_.write(it_.root, 'src/a.ts', 'the working file\n')
    const info = `<?xml version="1.0"?><info><entry path="a.ts" kind="file"><url>file:///r/src/a.ts</url><repository><root>file:///r</root></repository>
<conflict operation="update" type="text"><prev-wc-file>${join(it_.root, 'src', 'a.ts.mine').replace(/\\/g, '/')}</prev-wc-file><cur-base-file>${join(it_.root, 'src', 'a.ts.r3').replace(/\\/g, '/')}</cur-base-file></conflict></entry></info>`
    it_.write(it_.root, 'src/a.ts.mine', 'mine\n')
    it_.write(it_.root, 'src/a.ts.r3', 'theirs\n')
    it_.svn.inspection = info
    vi.mocked(files.rename).mockClear()

    await new SvnTextResolution(it_.svn).choose(it_.input('src/a.ts', 'text', 'take-incoming'), 'theirs')

    const staged = vi.mocked(files.rename).mock.calls.find(([, to]) => to === join(it_.root, 'src', 'a.ts'))
    expect(dirname(String(staged?.[0]))).toBe(join(it_.root, '.svn', 'tmp'))
    expect(readFileSync(join(it_.root, 'src', 'a.ts'), 'utf8')).toBe('theirs\n')
  })

  it('refuses an ambiguous legacy text retry without its saved sides instead of claiming the requested side', async () => {
    const it_ = harness()
    it_.svn.answers = [{ stdout: '<?xml version="1.0"?><status><target path="."></target></status>' }]
    expect(await it_.executor.apply(it_.input('src/a.ts', 'text', 'take-incoming', { option: 'take-incoming', done: 1 }))).toMatchObject({ ok: false, detail: expect.stringContaining('No saved text sides') })
    expect(it_.svn.calls).toEqual([])
  })

  it.each(['unknown', 'changed-database', 'owned-working', 'database-untouched', 'foreign-lock'] as const)('recoverLocked preserves manual bytes for %s queues', async (kind) => {
    const h = harness()
    h.write(h.root, 'a.txt', 'manual merge\n')
    let locked = true
    const commands: string[] = []
    const svn: CommandRunner = { run: async (_cwd, args) => {
      commands.push(args[0])
      if (args[0] === 'cleanup') locked = false
      if (args[0] === 'resolve' && kind !== 'database-untouched') writeFileSync(join(h.root, '.svn', 'wc.db'), 'queued by this resolve')
      if (args[0] === 'resolve' && kind === 'foreign-lock') return { code: 1, stdout: '', failure: null, stderr: "svn: warning: W155004: 'wc' is already locked." }
      return { code: 0, stderr: '', failure: null, stdout: args[0] === 'status'
        ? `<status><target path="."><entry path="."><wc-status item="normal" props="none" wc-locked="${locked}" revision="1"/></entry></target></status>` : '' }
    } }
    if (kind !== 'unknown') await new SvnTextResolution(svn).resolve(h.root, 'a.txt')
    if (kind === 'changed-database') h.write(h.root, '.svn/wc.db', 'another SVN operation')
    const executor = new SvnConflictResolutions({ svn, now: Date.now, markersIn: async () => [] })
    const recovered = await executor.recoverLocked(h.root, h.savedDir)
    expect(recovered.ok).toBe(kind === 'owned-working')
    expect(commands.includes('cleanup')).toBe(kind === 'owned-working')
    expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('manual merge\n')
    expect(existsSync(join(h.savedDir, 'before-cleanup'))).toBe(false)
  })

  it('never cleans a locked main copy, not even Jamat\'s own interrupted queue, and says what the person does (L6)', async () => {
    const h = harness()
    h.write(h.root, 'a.txt', 'manual merge\n')
    const commands: string[] = []
    const svn: CommandRunner = { run: async (_cwd, args) => {
      commands.push(args[0])
      if (args[0] === 'resolve') writeFileSync(join(h.root, '.svn', 'wc.db'), 'queued by this resolve')
      return { code: 0, stderr: '', failure: null, stdout: args[0] === 'status'
        ? '<status><target path="."><entry path="."><wc-status item="normal" props="none" wc-locked="true" revision="1"/></entry></target></status>' : '' }
    } }
    await new SvnTextResolution(svn).resolve(h.root, 'a.txt')
    const executor = new SvnConflictResolutions({ svn, now: Date.now, markersIn: async () => [] })
    expect(await executor.apply({ ...h.input('a.txt', 'text', 'take-incoming'), mainCopy: true })).toEqual({ ok: false, code: 'locked',
      detail: `The main copy ${h.root} is locked, and Jamat runs no svn cleanup in a main copy. Close every program that works in it, run Cleanup there in TortoiseSVN, then choose the option again.` })
    expect(commands).not.toContain('cleanup')
    expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('manual merge\n')
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
