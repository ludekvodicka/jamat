import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CommandInvoker } from '../shared/commandInvoker'
import type { SvnConflictApply, SvnConflictKind, SvnConflictOption } from './svn.types'
import { SvnConflictFacts } from './svnConflictFacts'
import { SvnConflictResolutions } from './svnConflictResolutions'
import { SvnInvoker } from './svnInvoker'
import { SvnWorktreeManager } from './svnWorktreeManager'

const testRoot = 'Q:/UnitTestFiles/NodeJs/Applications/Jamat/worktrees'

/** UA1-J05-1: `both.txt` with a text and a property conflict after one update, as the person found it. */
async function bothConflicted(name: string) {
  const root = await mkdtemp(join(testRoot, `${name}-`)), svn = new SvnInvoker()
  const run = async (cwd: string, args: string[]) => {
    const result = await svn.run(cwd, args)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }
  const repo = join(root, 'repo'), main = join(root, 'main'), wc = join(root, 'wc'), message = join(root, 'message.txt')
  expect((await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repo], cwd: root, env: process.env })).code).toBe(0)
  await writeFile(message, `[Fixture] Native ${name}`)
  await run(root, ['checkout', pathToFileURL(repo).href, main])
  await writeFile(join(main, 'both.txt'), 'one\nbase\nthree\n')
  await run(main, ['add', 'both.txt'])
  await run(main, ['propset', 'jamat:test', 'base', 'both.txt'])
  await run(main, ['commit', '--file', message])
  await run(root, ['checkout', pathToFileURL(repo).href, wc])
  await writeFile(join(wc, 'both.txt'), 'one\nmine\nthree\n')
  await run(wc, ['propset', 'jamat:test', 'both-w1', 'both.txt'])
  await writeFile(join(main, 'both.txt'), 'one\ntheirs\nthree\n')
  await run(main, ['propset', 'jamat:test', 'both-t', 'both.txt'])
  await run(main, ['commit', '--file', message])
  await run(wc, ['update', '--accept', 'postpone'])
  const marks = async () => SvnConflictFacts.conflictedRows(await run(wc, ['status', '--xml', '--', 'both.txt']), wc)[0] ?? null
  const property = async () => (await run(wc, ['propget', 'jamat:test', '--no-newline', '--', 'both.txt'])).trim()
  const markersIn = async (at: string, paths: readonly string[]) => {
    const marked: string[] = []
    for (const path of paths) if (/^<{7}( |$)/m.test(await readFile(join(at, path), 'utf8'))) marked.push(path)
    return marked
  }
  const executor = new SvnConflictResolutions({ svn, markersIn, now: Date.now })
  const apply = (kind: SvnConflictKind, option: SvnConflictOption, saved: string, held: boolean) => executor.apply({
    root: wc, savedDir: join(root, saved), path: 'both.txt', kind, option, journal: null, onStep: async () => {},
    baseRevision: 1, ...kind === 'property' ? { properties: ['jamat:test'] } : {}, ...held ? { held: true } : {},
  } satisfies SvnConflictApply)
  return { root, wc, svn, marks, property, apply }
}

describe.skipIf(process.platform !== 'win32' || !existsSync(testRoot))('real SVN text and property conflict on one file', () => {
  it('reads the text and the property conflict as two facts, the property one with its .prej', async () => {
    const fixture = await bothConflicted('native-both-read')
    const read = await new SvnWorktreeManager(fixture.svn).conflictSet(fixture.wc, 1)
    if (!read.ok) throw new Error(read.detail)
    expect(read.value.facts.map((fact) => [fact.path, fact.kind])).toEqual([['both.txt', 'text'], ['both.txt', 'property']])
    const [text, property] = read.value.facts
    expect(text.properties).toEqual([])
    expect(text.sidecars.sort()).toEqual(['both.txt.mine', 'both.txt.r1', 'both.txt.r2'])
    expect(property.properties).toEqual([{ name: 'jamat:test', older: 'base', mine: 'both-w1', theirs: 'both-t' }])
    expect(property.sidecars).toEqual(['both.txt.prej'])
  }, 120_000)

  it('settles the text first and leaves the property conflict open, then the property keeps the merged text', async () => {
    const fixture = await bothConflicted('native-both-text-first')
    await writeFile(join(fixture.wc, 'both.txt'), 'one\nmine and theirs\nthree\n')
    expect(await fixture.apply('text', 'merged', 'saved-text', true)).toEqual({ ok: true, value: undefined })
    expect(await fixture.marks()).toMatchObject({ property: true })
    expect(await fixture.property()).toBe('both-w1')
    expect(existsSync(join(fixture.wc, 'both.txt.prej'))).toBe(true)
    expect(await readdir(join(fixture.root, 'saved-text'))).toContain('both.txt.prej')

    expect(await fixture.apply('property', 'take-incoming', 'saved-property', false)).toEqual({ ok: true, value: undefined })
    expect(await fixture.marks()).toBeNull()
    expect(await fixture.property()).toBe('both-t')
    expect(await readFile(join(fixture.wc, 'both.txt'), 'utf8')).toBe('one\nmine and theirs\nthree\n')
  }, 120_000)

  it('settles the property first and leaves the text conflict open, then the text keeps the chosen property', async () => {
    const fixture = await bothConflicted('native-both-property-first')
    expect(await fixture.apply('property', 'take-incoming', 'saved-property', true)).toEqual({ ok: true, value: undefined })
    expect(await fixture.marks()).toMatchObject({ text: true })
    expect(await fixture.property()).toBe('both-t')
    expect(await readFile(join(fixture.wc, 'both.txt'), 'utf8')).toMatch(/^<{7} \.mine/m)

    expect(await fixture.apply('text', 'keep-mine', 'saved-text', false)).toEqual({ ok: true, value: undefined })
    expect(await fixture.marks()).toBeNull()
    expect(await fixture.property()).toBe('both-t')
    expect(await readFile(join(fixture.wc, 'both.txt'), 'utf8')).toBe('one\nmine\nthree\n')
  }, 120_000)
})
