import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { CommandInvoker } from '../shared/commandInvoker'
import type { SvnConflictApply } from './svn.types'
import { SvnConflictResolutions } from './svnConflictResolutions'
import { SvnConflictShapes } from './svnConflictShapes'
import { SvnInvoker } from './svnInvoker'
import { SvnWorktreeManager } from './svnWorktreeManager'

const testRoot = 'Q:/UnitTestFiles/NodeJs/Applications/Jamat/worktrees'
const lines = (marks: Record<number, string> = {}): string => Array.from({ length: 9 }, (_, index) => `l${index + 1}${marks[index + 1] ?? ''}\n`).join('')

/**
 * UA1-J05-6 on real svn: r1 the base, the session's side written into `wc`, the other commit's side
 * committed from `main` as r2, then the update of the Finish.
 */
describe.skipIf(process.platform !== 'win32' || !existsSync(testRoot))('real SVN moves against edits', () => {
  const created: string[] = []
  afterEach(async () => { for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true }) })

  async function updated(name: string, mine: (wc: string) => Promise<void>, theirs: (main: string) => Promise<void>) {
    const root = await mkdtemp(join(testRoot, `${name}-`)), svn = new SvnInvoker()
    created.push(root)
    const run = async (cwd: string, args: string[]): Promise<void> => {
      const result = await svn.run(cwd, args)
      expect(result.code, result.stderr).toBe(0)
    }
    const repo = join(root, 'repo'), main = join(root, 'main'), wc = join(root, 'wc')
    expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
    await run(root, ['checkout', pathToFileURL(repo).href, main])
    await mkdir(join(main, 'src'))
    await writeFile(join(main, 'src', 'a.txt'), lines())
    await run(main, ['add', 'src'])
    await run(main, ['commit', '-m', 'base'])
    await run(root, ['checkout', pathToFileURL(repo).href, wc])
    await mine(wc)
    await theirs(main)
    await run(main, ['commit', '-m', 'incoming'])
    await run(wc, ['update', '--accept', 'postpone', '--', '.'])
    const manager = new SvnWorktreeManager(svn)
    const read = await manager.conflictSet(wc, 1)
    if (!read.ok) throw new Error(read.detail)
    const executor = new SvnConflictResolutions({ svn, markersIn: async () => [], now: Date.now })
    const apply = (move: SvnConflictApply['move']) => executor.apply({ root: wc, savedDir: join(root, 'saved'), path: 'src/a.txt', kind: 'tree',
      option: 'keep-both', ...move === undefined ? {} : { move }, journal: null, onStep: async () => {} })
    const conflicts = async () => {
      const again = await manager.conflictSet(wc, 1)
      if (!again.ok) throw new Error(again.detail)
      return again.value.facts.map((fact) => `${fact.kind} ${fact.path}`)
    }
    return { root, wc, facts: read.value.facts, apply, conflicts }
  }

  it('CF15: keep-both of a local move against an incoming edit applies the edit to the move target', async () => {
    const fixture = await updated('move-away', async (wc) => {
      expect((await new SvnInvoker().run(wc, ['move', '--', 'src/a.txt', 'src/b.txt'])).code).toBe(0)
      await writeFile(join(wc, 'src', 'b.txt'), lines({ 8: ' MINE' }))
    }, (main) => writeFile(join(main, 'src', 'a.txt'), lines({ 2: ' THEIRS' })))
    expect(fixture.facts).toHaveLength(1)
    expect(fixture.facts[0]?.tree).toMatchObject({ reason: 'moved-away', action: 'edited', movedTo: 'src/b.txt' })
    expect(SvnConflictShapes.planOf(fixture.facts[0]!).options).toEqual(['keep-both', 'keep-mine'])
    expect(await fixture.apply('away')).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'src', 'b.txt'), 'utf8')).toBe(lines({ 2: ' THEIRS', 8: ' MINE' }))
    expect(await fixture.conflicts()).toEqual([])
  }, 150_000)

  it('CF15 with lines both sides changed: keep-both settles the move and leaves a text conflict on the move target', async () => {
    const fixture = await updated('move-away-overlap', async (wc) => {
      expect((await new SvnInvoker().run(wc, ['move', '--', 'src/a.txt', 'src/b.txt'])).code).toBe(0)
      await writeFile(join(wc, 'src', 'b.txt'), lines({ 2: ' MINE' }))
    }, (main) => writeFile(join(main, 'src', 'a.txt'), lines({ 2: ' THEIRS' })))
    expect(await fixture.apply('away')).toEqual({ ok: true, value: undefined })
    expect(await fixture.conflicts()).toEqual(['text src/b.txt'])
  }, 150_000)

  it('CF16: keep-both of a local edit against an incoming move applies the edit to the new place and drops the old one', async () => {
    const fixture = await updated('move-incoming', (wc) => writeFile(join(wc, 'src', 'a.txt'), lines({ 8: ' MINE' })), async (main) => {
      expect((await new SvnInvoker().run(main, ['move', '--', 'src/a.txt', 'src/c.txt'])).code).toBe(0)
      await writeFile(join(main, 'src', 'c.txt'), lines({ 2: ' THEIRS' }))
    })
    expect(fixture.facts[0]?.tree).toMatchObject({ reason: 'edited', action: 'deleted', movedTo: 'src/c.txt' })
    expect(SvnConflictShapes.planOf(fixture.facts[0]!).options).toEqual(['keep-both', 'merged', 'take-incoming', 'keep-mine'])
    expect(await fixture.apply('incoming')).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'src', 'c.txt'), 'utf8')).toBe(lines({ 2: ' THEIRS', 8: ' MINE' }))
    expect(existsSync(join(fixture.wc, 'src', 'a.txt'))).toBe(false)
    expect(await readFile(join(fixture.root, 'saved', 'src', 'a.txt'), 'utf8')).toBe(lines({ 8: ' MINE' }))
    expect(await fixture.conflicts()).toEqual([])
  }, 150_000)

  it('finds an unresolved incoming move after Keep resumes at the already updated revision', async () => {
    const fixture = await updated('move-resumed', (wc) => writeFile(join(wc, 'src', 'a.txt'), lines({ 8: ' MINE' })), async (main) => {
      expect((await new SvnInvoker().run(main, ['move', '--', 'src/a.txt', 'src/c.txt'])).code).toBe(0)
      await writeFile(join(main, 'src', 'c.txt'), lines({ 2: ' THEIRS' }))
    })
    const resumed = await new SvnWorktreeManager(new SvnInvoker()).conflictSet(fixture.wc, 2)
    if (!resumed.ok) throw new Error(resumed.detail)
    expect(resumed.value.facts[0]?.tree).toMatchObject({ movedTo: 'src/c.txt' })
    expect(SvnConflictShapes.planOf(resumed.value.facts[0]!).options).toContain('keep-both')
    expect(await fixture.apply('incoming')).toEqual({ ok: true, value: undefined })
    expect(await readFile(join(fixture.wc, 'src', 'c.txt'), 'utf8')).toBe(lines({ 2: ' THEIRS', 8: ' MINE' }))
    expect(await fixture.conflicts()).toEqual([])
  }, 150_000)

  it('CF16 on a plain delete: no move is read, and keep-both is refused with nothing changed', async () => {
    const fixture = await updated('move-none', (wc) => writeFile(join(wc, 'src', 'a.txt'), lines({ 8: ' MINE' })), async (main) => {
      expect((await new SvnInvoker().run(main, ['delete', '--', 'src/a.txt'])).code).toBe(0)
    })
    expect(fixture.facts[0]?.tree).toMatchObject({ reason: 'edited', action: 'deleted' })
    expect(fixture.facts[0]?.tree?.movedTo).toBeUndefined()
    expect(await fixture.apply('incoming')).toMatchObject({ ok: false, code: 'refused' })
    expect(await readFile(join(fixture.wc, 'src', 'a.txt'), 'utf8')).toBe(lines({ 8: ' MINE' }))
    expect(await fixture.conflicts()).toEqual(['tree src/a.txt'])
  }, 150_000)
})
