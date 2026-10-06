import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SvnLoggedRow, SvnVerboseItem } from './svn.types'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

// Captured by `pnpm smoke:svn-worktree --capture` from a disposable svnadmin repository; the smoke
// also proves on every run that this svn still writes what they hold.
const root = resolve('fixture-worktree')
const main = resolve('fixture-main')
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'worktree', name), 'utf8')
    .replaceAll('{ROOT}', root).replaceAll('{MAIN}', main).replaceAll('\\', sep)

const logs: Record<number, string> = { 6: 'log-committed.xml', 7: 'log-foreign.xml' }
const revisionLog = async (revision: number): Promise<SvnLoggedRow[]> => {
  const name = logs[revision]
  if (name === undefined) throw new Error(`no fixture log for r${revision}`)
  return SvnWorktreeEvidence.loggedRows(fixture(name), '/Project', '')
}
const mainBases = new Map(SvnWorktreeEvidence.infoEntries(fixture('info-main.xml'))
  .map((entry) => [SvnWorktreeEvidence.relativeTo(main, entry.path), entry.revision]))
const mainBaseOf = async (path: string): Promise<number> => mainBases.get(path) ?? 0
const committed = (): SvnVerboseItem[] => SvnWorktreeEvidence.statusVerboseRows(fixture('status-verbose-committed.xml'), root)
const foreign = (): SvnVerboseItem[] => SvnWorktreeEvidence.statusVerboseRows(fixture('status-verbose-foreign.xml'), root)
const noHistory = async (): Promise<SvnLoggedRow[]> => { throw new Error('history must not be read') }

describe('lib-orchestrator/svn/svnWorktreeEvidence', () => {
  describe('status', () => {
    it('reads every change kind, keeps a non-ASCII name and names paths relative to the root', () => {
      expect(SvnWorktreeEvidence.statusRows(fixture('status-before-update.xml'), root)).toEqual([
        { kind: 'item', conflict: false, path: 'conflict.txt' },
        { kind: 'missing', conflict: false, path: 'missing.txt' },
        { kind: 'external', conflict: false, path: 'mount' },
        { kind: 'props', conflict: false, path: 'props.txt' },
        { kind: 'props', conflict: false, path: 'src' },
        { kind: 'item', conflict: false, path: 'src/a.txt' },
        { kind: 'item', conflict: false, path: 'src/added.txt' },
        { kind: 'item', conflict: false, path: 'src/c.txt' },
        { kind: 'item', conflict: false, path: 'src/loose.txt' },
        { kind: 'item', conflict: false, path: 'src/přehled.md' },
        { kind: 'item', conflict: false, path: 'tree.txt' },
      ])
    })

    it('flags a text, a property and a tree conflict', () => {
      const rows = SvnWorktreeEvidence.statusRows(fixture('status-after-update.xml'), root)
      expect(rows.filter((row) => row.conflict)).toEqual([
        { kind: 'item', conflict: true, path: 'conflict.txt' },
        { kind: 'props', conflict: true, path: 'props.txt' },
        { kind: 'item', conflict: true, path: 'tree.txt' },
      ])
    })

    it('reads entries of a changelist, decodes entities and names the root "."', () => {
      const xml = `<status><target path="${root}"><entry path="${root}"><wc-status item="normal" props="conflicted"/></entry></target>`
        + `<changelist name="c"><entry path="${join(root, 'a &amp; b.txt')}"><wc-status item="modified" props="none" tree-conflicted="true"/></entry></changelist></status>`
      expect(SvnWorktreeEvidence.statusRows(xml, root)).toEqual([
        { kind: 'props', conflict: true, path: '.' },
        { kind: 'item', conflict: true, path: 'a & b.txt' },
      ])
    })

    it('refuses an unknown item and an entry without a state, never reading them as clean', () => {
      expect(() => SvnWorktreeEvidence.statusRows(`<status><target path="${root}"><entry path="x"><wc-status item="unheard-of"/></entry></target></status>`, root))
        .toThrow(/Unknown svn status item/)
      expect(() => SvnWorktreeEvidence.statusRows(`<status><target path="${root}"><entry path="x"></entry></target></status>`, root))
        .toThrow(/no state for x/)
      expect(() => SvnWorktreeEvidence.statusRows('<info/>', root)).toThrow(/no <status>/)
    })

    it('keeps only the change kinds as changed rows', () => {
      const rows = SvnWorktreeEvidence.changed(SvnWorktreeEvidence.statusRows(fixture('status-before-update.xml'), root))
      expect(rows.map((row) => row.kind)).not.toContain('external')
      expect(rows).toHaveLength(10)
    })
  })

  describe('verbose status', () => {
    it('reads BASE and last-changed revision in any attribute order, places a mount and zeroes the unversioned', () => {
      const items = foreign()
      expect(items.find((item) => item.path === 'src/a.txt')).toEqual({ path: 'src/a.txt', item: 'normal', props: 'none', base: 6, changed: 6 })
      expect(items.find((item) => item.path === 'mount')).toEqual({ path: 'mount', item: 'external', props: 'none', base: 0, changed: 0 })
      expect(SvnWorktreeEvidence.statusVerboseRows(fixture('status-verbose-committed.xml'), root, 'mount1')[0].path).toBe('mount1')
    })

    it('reads the revision -1 of an item scheduled for addition as no BASE', () => {
      expect(SvnWorktreeEvidence.statusVerboseRows(fixture('status-before-update.xml'), root)
        .find((item) => item.path === 'src/added.txt')).toEqual({ path: 'src/added.txt', item: 'added', props: 'none', base: 0, changed: 0 })
    })

    it('counts a clean item as committed here only when its BASE equals its last change', () => {
      const byPath = new Map(foreign().map((item) => [item.path, item]))
      const here = (path: string) => SvnWorktreeEvidence.committedHere(byPath.get(path) as SvnVerboseItem)
      expect(here('src/a.txt')).toBe(true)
      expect(here('src/c.txt')).toBe(false)
      expect(here('mount')).toBe(false)
      expect(SvnWorktreeEvidence.committedHere({ path: 'x', item: 'modified', props: 'none', base: 6, changed: 6 })).toBe(false)
      expect(SvnWorktreeEvidence.committedHere({ path: 'x', item: 'normal', props: 'modified', base: 6, changed: 6 })).toBe(false)
    })
  })

  describe('log', () => {
    it('keeps only paths below the checked-out URL, relative to the worktree or placed at a mount', () => {
      const project = SvnWorktreeEvidence.loggedRows(fixture('log-range.xml'), '/Project', '')
      expect(project.filter((row) => row.revision === 4)).toContainEqual({ revision: 4, action: 'D', path: 'gone.txt' })
      expect(project.filter((row) => row.revision === 4)).toContainEqual({ revision: 4, action: 'A', path: 'src/new.txt' })
      expect(project.filter((row) => row.revision > 4)).toEqual([
        { revision: 6, action: 'M', path: 'src/a.txt' },
        { revision: 7, action: 'M', path: 'keep.txt' },
        { revision: 7, action: 'M', path: 'src/b.txt' },
      ])
      expect(SvnWorktreeEvidence.loggedRows(fixture('log-range.xml'), '/Lib', 'mount'))
        .toEqual([{ revision: 5, action: 'M', path: 'mount/l.txt' }])
    })

    it('names the root ".", keeps a non-ASCII path and never takes a sibling with the same prefix', () => {
      const xml = '<log><logentry revision="12"><paths><path action="M" kind="dir">/Project</path>'
        + '<path action="A" kind="file">/Project/src/přehled.md</path><path action="M" kind="file">/Projectile/x.txt</path></paths></logentry></log>'
      expect(SvnWorktreeEvidence.loggedRows(xml, '/Project', '')).toEqual([
        { revision: 12, action: 'M', path: '.' },
        { revision: 12, action: 'A', path: 'src/přehled.md' },
      ])
      expect(SvnWorktreeEvidence.loggedRows(xml, '/Project', 'm')[0].path).toBe('m')
    })
  })

  describe('info', () => {
    it('reads the repository, the checked-out path and the revision', () => {
      expect(SvnWorktreeEvidence.infoEntries(fixture('info-worktree.xml'))).toEqual([{
        path: '.', kind: 'dir', revision: 5, url: '{REPO}/Project', repository: '{REPO}', base: '/Project',
      }])
      expect(SvnWorktreeEvidence.infoEntries(fixture('info-repository.xml'))[0]).toMatchObject({ revision: 7, base: '' })
      expect(mainBases.get('src/a.txt')).toBe(4)
      expect(mainBases.get('src/b.txt')).toBe(7)
    })
  })

  describe('update', () => {
    it('reads added, deleted, updated, merged and conflicted rows for files, properties and trees', () => {
      const rows = SvnWorktreeEvidence.updateRows(fixture('update.txt'), root)
      const row = (path: string) => rows.find((entry) => entry.path === path)
      expect(rows.map((entry) => entry.path)).toEqual(['tree.txt', 'gone.txt', '.aidocs/note.md', 'conflict.txt', 'keep.txt',
        'props.txt', 'src/a.txt', 'src/b.txt', 'src/new.txt', 'src', 'mount/l.txt'])
      expect(row('tree.txt')).toEqual({ text: 'none', props: 'none', lockBroken: false, treeConflict: true, path: 'tree.txt', inside: true })
      expect(row('gone.txt')?.text).toBe('deleted')
      expect(row('src/new.txt')?.text).toBe('added')
      expect(row('src/b.txt')?.text).toBe('updated')
      expect(row('src/a.txt')?.text).toBe('merged')
      expect(row('conflict.txt')?.text).toBe('conflicted')
      expect(row('keep.txt')?.props).toBe('updated')
      expect(row('src')?.props).toBe('merged')
      expect(row('props.txt')?.props).toBe('conflicted')
    })

    it('reads absolute paths, the root itself and a path that no longer resolves below the root', () => {
      const outside = resolve('elsewhere', 'x.txt')
      const rows = SvnWorktreeEvidence.updateRows(`U    ${join(root, 'a.txt')}\n U   ${root}\nA B  ${outside}\nAt revision 9.\n`, root)
      expect(rows).toEqual([
        { text: 'updated', props: 'none', lockBroken: false, treeConflict: false, path: 'a.txt', inside: true },
        { text: 'none', props: 'updated', lockBroken: false, treeConflict: false, path: '.', inside: true },
        { text: 'added', props: 'none', lockBroken: true, treeConflict: false, path: outside, inside: false },
      ])
    })
  })

  describe('incoming', () => {
    const updated = () => SvnWorktreeEvidence.updateRows(`${fixture('update.txt')} U   .\n`, root)

    it('counts every incoming path of a changed project except the root and .aidocs', () => {
      expect(SvnWorktreeEvidence.incoming(['src/a.txt'], updated(), 'whole')).toEqual(['tree.txt', 'gone.txt', 'conflict.txt',
        'keep.txt', 'props.txt', 'src/a.txt', 'src/b.txt', 'src/new.txt', 'src', 'mount/l.txt'])
      expect(SvnWorktreeEvidence.incoming([], updated(), 'whole')).toEqual([])
    })

    it('in a product group counts only a member project the session changed', () => {
      expect(SvnWorktreeEvidence.incoming(['src/added.txt'], updated(), 'first-segment'))
        .toEqual(['src/a.txt', 'src/b.txt', 'src/new.txt', 'src'])
      expect(SvnWorktreeEvidence.incoming(['mount/x.txt', '.aidocs/n.md'], updated(), 'first-segment')).toEqual(['mount/l.txt'])
    })

    it('counts a path that no longer maps, whatever changed', () => {
      const rows = SvnWorktreeEvidence.updateRows(`U    ${resolve('elsewhere', 'x.txt')}\n`, root)
      expect(SvnWorktreeEvidence.incoming([], rows, 'first-segment')).toEqual([resolve('elsewhere', 'x.txt')])
    })
  })

  describe('BASE proof', () => {
    it('proves the commit of the changed set above since', async () => {
      await expect(SvnWorktreeEvidence.provenRows({ items: committed(), own: '', rootBase: 5, since: 5,
        claimed: ['src/a.txt'], history: noHistory, revisionLog })).resolves.toEqual([{ revision: 6, action: 'M', path: 'src/a.txt' }])
    })

    it('refuses the proof when an unclaimed item left the root BASE', async () => {
      await expect(SvnWorktreeEvidence.provenRows({ items: foreign(), own: '', rootBase: 5, since: 5,
        claimed: ['src/a.txt'], history: noHistory, revisionLog })).rejects.toThrow(/src\/b.txt left BASE r5 for r7/)
    })

    it('proves nothing from a revision whose log names an unclaimed path', async () => {
      await expect(SvnWorktreeEvidence.provenRows({ items: foreign(), own: '', rootBase: 5, since: 5,
        claimed: ['src/a.txt', 'src/b.txt'], history: noHistory, revisionLog })).resolves.toEqual([{ revision: 6, action: 'M', path: 'src/a.txt' }])
    })

    it('proves nothing for an item still modified or committed at or before since', async () => {
      for (const item of [{ item: 'modified', base: 5, changed: 4 }, { item: 'normal', base: 5, changed: 5 }] as const)
        await expect(SvnWorktreeEvidence.provenRows({ items: [{ path: 'a', props: 'none', ...item }], own: '', rootBase: 5,
          since: 5, claimed: ['a'], history: noHistory, revisionLog })).resolves.toEqual([])
    })

    it('a claim on the root covers its properties, never the items below it', async () => {
      const items: SvnVerboseItem[] = [{ path: '.', item: 'normal', props: 'normal', base: 15, changed: 15 },
        { path: 'src', item: 'normal', props: 'none', base: 10, changed: 9 }]
      const log = async () => [{ revision: 15, action: 'M' as const, path: '.' }]
      await expect(SvnWorktreeEvidence.provenRows({ items, own: '', rootBase: 10, since: 12, claimed: ['.'], history: noHistory,
        revisionLog: log })).resolves.toEqual([{ revision: 15, action: 'M', path: '.' }])
      await expect(SvnWorktreeEvidence.provenRows({ items: [...items, { path: 'src/a', item: 'normal', props: 'none', base: 15, changed: 15 }],
        own: '', rootBase: 10, since: 12, claimed: ['.'], history: noHistory, revisionLog: log })).rejects.toThrow(/left BASE/)
    })

    it('proves a claimed deletion gone from the working copy by its one deleting revision', async () => {
      const deletion = [{ revision: 14, action: 'D' as const, path: 'src/gone' }]
      await expect(SvnWorktreeEvidence.provenRows({ items: [], own: '', rootBase: 10, since: 12, claimed: ['src/gone', 'src/gone/f.txt'],
        history: async () => deletion, revisionLog: async () => deletion })).resolves.toEqual(deletion)
      await expect(SvnWorktreeEvidence.provenRows({ items: [], own: '', rootBase: 10, since: 12, claimed: ['gone.txt'],
        history: async () => [{ revision: 14, action: 'D', path: 'gone.txt' }, { revision: 16, action: 'D', path: 'gone.txt' }],
        revisionLog })).rejects.toThrow(/deleted in r14 and r16/)
    })

    it('needs whole revisions', async () => {
      await expect(SvnWorktreeEvidence.provenRows({ items: [], own: '', rootBase: Number.NaN, since: 5, claimed: [],
        history: noHistory, revisionLog })).rejects.toThrow(/numeric root BASE/)
    })
  })

  describe('review receipt', () => {
    it('confirms the receipt revision by its log below this root', async () => {
      await expect(SvnWorktreeEvidence.reviewedRows({ revision: 6, since: 5, base: '/Project', revisionLog }))
        .resolves.toEqual([{ revision: 6, action: 'M', path: 'src/a.txt' }])
    })

    it('refuses a revision that does not follow since or that the log does not confirm here', async () => {
      await expect(SvnWorktreeEvidence.reviewedRows({ revision: 6, since: 6, base: '/Project', revisionLog })).rejects.toThrow(/pre-review/)
      await expect(SvnWorktreeEvidence.reviewedRows({ revision: 8, since: 5, base: '/Project', revisionLog: async () => [] }))
        .rejects.toThrow(/does not confirm review revision r8 below \/Project/)
      await expect(SvnWorktreeEvidence.reviewedRows({ revision: 8, since: 5, base: '/Project', revisionLog: async () => [{ revision: 7, action: 'M', path: 'a' }] }))
        .rejects.toThrow(/does not confirm/)
    })
  })

  describe('recovery', () => {
    it('finds a clean commit from this working copy that the main copy lacks, and not a foreign revision taken in by a single-path update', async () => {
      await expect(SvnWorktreeEvidence.recoverableRows({ items: foreign(), revisionLog, mainBaseOf }))
        .resolves.toEqual([{ revision: 6, action: 'M', path: 'src/a.txt' }])
    })

    it('skips a path the main copy already holds at that revision', async () => {
      await expect(SvnWorktreeEvidence.recoverableRows({ items: foreign(), revisionLog, mainBaseOf: async () => 6 })).resolves.toEqual([])
    })

    it('reports an added directory for the items below it and reads no history when the working copy sits at one BASE', async () => {
      const items: SvnVerboseItem[] = [{ path: '.', item: 'normal', props: 'none', base: 10, changed: 8 },
        { path: 'new', item: 'normal', props: 'none', base: 15, changed: 15 },
        { path: 'new/n.txt', item: 'normal', props: 'none', base: 15, changed: 15 }]
      const added = [{ revision: 15, action: 'A' as const, path: 'new' }]
      await expect(SvnWorktreeEvidence.recoverableRows({ items, revisionLog: async () => added, mainBaseOf: async () => 0 })).resolves.toEqual(added)
      await expect(SvnWorktreeEvidence.recoverableRows({ items: [{ path: '.', item: 'normal', props: 'none', base: 10, changed: 10 }],
        revisionLog: noHistory, mainBaseOf })).resolves.toEqual([])
    })
  })

  describe('unlanded candidates', () => {
    it('names a commit from here whose path the main copy holds at an older BASE', async () => {
      await expect(SvnWorktreeEvidence.unlandedCandidates(foreign(), mainBaseOf)).resolves.toEqual([{ path: 'src/a.txt', revision: 6 }])
    })

    it('does not name it once the main copy holds that revision or a newer one', async () => {
      for (const base of [6, 7])
        await expect(SvnWorktreeEvidence.unlandedCandidates(foreign(), async (path) => path === 'src/a.txt' ? base : mainBaseOf(path))).resolves.toEqual([])
    })
  })

  describe('attribution', () => {
    it('counts a logged path, one below a logged deletion, and one with a logged path below it unless only its properties changed', () => {
      const changed = [
        { kind: 'item', conflict: false, path: 'src/a.txt' },
        { kind: 'missing', conflict: false, path: 'old/x.txt' },
        { kind: 'item', conflict: false, path: 'new' },
        { kind: 'props', conflict: false, path: 'src' },
        { kind: 'item', conflict: false, path: 'left.txt' },
        { kind: 'external', conflict: false, path: 'mount' },
      ] as const
      const logged: SvnLoggedRow[] = [{ revision: 9, action: 'M', path: 'src/a.txt' }, { revision: 8, action: 'D', path: 'old' },
        { revision: 9, action: 'A', path: 'new/n.txt' }]
      expect(SvnWorktreeEvidence.attribution(changed, logged)).toEqual({
        committed: ['src/a.txt', 'old/x.txt', 'new'], remaining: ['src', 'left.txt'], revisions: [8, 9],
      })
    })
  })

  describe('arguments', () => {
    it('takes only ASCII names, because svn.exe maps the rest through the ANSI code page', () => {
      expect(SvnWorktreeEvidence.takesArgument('src/a b@.txt')).toBe(true)
      expect(SvnWorktreeEvidence.takesArgument('ř.txt')).toBe(false)
      expect(SvnWorktreeEvidence.takesArgument('složka/x.txt')).toBe(false)
    })
  })
})
