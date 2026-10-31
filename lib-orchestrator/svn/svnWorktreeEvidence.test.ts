import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SvnLoggedRow, SvnVerboseItem } from './svn.types'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'

// Captured by `pnpm smoke:svn-worktree --capture` from a disposable svnadmin repository; the smoke
// also proves on every run that this svn still writes what they hold.
const root = resolve('fixture-worktree')
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'worktree', name), 'utf8')
    .replaceAll('{ROOT}', root).replaceAll('{MAIN}', resolve('fixture-main')).replaceAll('\\', sep)

const logs: Record<number, string> = { 6: 'log-committed.xml', 7: 'log-foreign.xml' }
const revisionLog = async (revision: number): Promise<SvnLoggedRow[]> => {
  const name = logs[revision]
  if (name === undefined) throw new Error(`no fixture log for r${revision}`)
  return SvnWorktreeEvidence.loggedRows(fixture(name), '/Project', '')
}
const committed = (): SvnVerboseItem[] => SvnWorktreeEvidence.statusVerboseRows(fixture('status-verbose-committed.xml'), root)
const foreign = (): SvnVerboseItem[] => SvnWorktreeEvidence.statusVerboseRows(fixture('status-verbose-foreign.xml'), root)
const noHistory = async (): Promise<SvnLoggedRow[]> => { throw new Error('history must not be read') }

describe('lib-orchestrator/svn/svnWorktreeEvidence', () => {
  it('requires native file-external registration rather than only a matching switched URL', () => {
    const xml = (attributes: string) => `<status><target path="."><entry path="file"><wc-status ${attributes}/></entry></target></status>`
    expect(SvnWorktreeEvidence.registeredFileExternal(xml('item="normal" file-external="true"'))).toBe(true)
    expect(SvnWorktreeEvidence.registeredFileExternal(xml('item="normal" switched="true"'))).toBe(false)
  })

  it('rejects skipped, switched and mixed BASE paths after update, allowing scheduled changes and independent externals', () => {
    const rows = [
      ['current', 'item="normal" revision="8"'], ['mixed', 'item="modified" revision="7"'],
      ['switched', 'item="normal" revision="8" switched="true"'], ['missing', 'item="missing" revision="8"'],
      ['obstructed', 'item="obstructed"'], ['incomplete', 'item="incomplete"'], ['added', 'item="added" revision="-1"'],
      ['deleted', 'item="deleted" revision="7"'], ['external', 'item="external"'],
      ['file-external', 'item="normal" revision="3" file-external="true"'],
      ['moved/modified-child', 'item="modified" copied="true"'], ['copied/normal-child', 'item="normal" copied="true"'],
      ['copied/obstructed', 'item="obstructed" copied="true"'],
    ]
    const xml = `<status><target path=".">${rows.map(([path, status]) => `<entry path="${path}"><wc-status ${status}/></entry>`).join('')}</target></status>`
    expect(SvnWorktreeEvidence.updateProblems(xml, root, 8)).toEqual(['mixed', 'switched', 'missing', 'obstructed', 'incomplete', 'copied/obstructed'])
  })

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
        { kind: 'item', conflict: false, path: 'src/c.txt', deleted: true },
        { kind: 'item', conflict: false, path: 'src/loose.txt', unversioned: true },
        { kind: 'item', conflict: false, path: 'src/přehled.md', unversioned: true },
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

    // UA1-J10-10: a Keep listed src/limit.txt.mine, .r1 and .r2 as unpublished work beside the conflict.
    it('leaves svn conflict files of a conflicted path out of the unpublished paths', () => {
      const row = (path: string, conflict = false) => ({ path, kind: 'item' as const, conflict })
      expect(SvnWorktreeEvidence.unpublished([row('src/limit.txt', true), row('src/limit.txt.mine'), row('src/limit.txt.r1'),
        row('src/limit.txt.r2'), row('src/other.txt.r3'), row('lib/a.c.working'), row('lib/a.c.merge-left.r4'), row('lib/a.c', true),
        row('dir', true), row('dir/dir_conflicts.prej'), row('notes.mine')]))
        .toEqual(['src/limit.txt', 'src/other.txt.r3', 'lib/a.c', 'dir', 'notes.mine'])
    })

    it('finds a file external, which status lists under --ignore-externals too', () => {
      const entry = (attributes: string) => `<status><target path="${root}"><entry path="${join(root, 'fx.txt')}"><wc-status item="normal" revision="3" props="none"${attributes}/></entry></target></status>`
      expect(SvnWorktreeEvidence.fileExternals(entry(' file-external="true"'))).toBe(true)
      expect(SvnWorktreeEvidence.fileExternals(entry(''))).toBe(false)
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

    it('reads a range no commit touched as no rows, and only a missing <log> as an error', () => {
      expect(SvnWorktreeEvidence.loggedRows('<?xml version="1.0" encoding="UTF-8"?>\n<log>\n</log>\n', '/Project', '')).toEqual([])
      expect(() => SvnWorktreeEvidence.loggedRows('<info/>', '/Project', '')).toThrow(/no <log>/)
    })

    it('reads revision, author and message of each commit, non-ASCII text intact, and a commit without an author', () => {
      const xml = '<?xml version="1.0" encoding="UTF-8"?><log><logentry revision="2"><author>luděk</author><date>2026-10-13T10:00:00Z</date>'
        + '<msg>Přidej stopu enginů\n\nřádek 2 &amp; „uvozovky“</msg></logentry><logentry revision="3"><msg></msg></logentry></log>'
      expect(SvnWorktreeEvidence.logEntries(xml)).toEqual([
        { revision: 2, author: 'luděk', message: 'Přidej stopu enginů\n\nřádek 2 & „uvozovky“' },
        { revision: 3, author: null, message: '' },
      ])
      expect(SvnWorktreeEvidence.logEntries('<log></log>')).toEqual([])
      expect(() => SvnWorktreeEvidence.logEntries('<info/>')).toThrow(/no <log>/)
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

    it('names a repository-root property publication as the current directory', () => {
      const xml = '<log><logentry revision="3"><paths><path action="M" kind="dir">/</path></paths></logentry></log>'
      expect(SvnWorktreeEvidence.loggedRows(xml, '', '')).toEqual([{ revision: 3, action: 'M', path: '.' }])
      expect(SvnWorktreeEvidence.loggedRows(xml, '', 'mount')).toEqual([{ revision: 3, action: 'M', path: 'mount' }])
    })
  })

  describe('info', () => {
    it('reads the repository, the checked-out path and the revision', () => {
      expect(SvnWorktreeEvidence.infoEntries(fixture('info-worktree.xml'))).toEqual([{
        path: '.', kind: 'dir', revision: 5, url: '{REPO}/Project', repository: '{REPO}', base: '/Project',
      }])
      expect(SvnWorktreeEvidence.infoEntries(fixture('info-repository.xml'))[0]).toMatchObject({ revision: 7, base: '' })
      const main = resolve('fixture-main')
      const mainBases = new Map(SvnWorktreeEvidence.infoEntries(fixture('info-main.xml'))
        .map((entry) => [SvnWorktreeEvidence.relativeTo(main, entry.path), entry.revision]))
      expect(mainBases.get('src/a.txt')).toBe(4)
      expect(mainBases.get('src/b.txt')).toBe(7)
    })
  })

  // Removed with the main-copy landing: the plain-text update rows; conflicts come from status XML and incoming paths from `svn log -v`.
  describe('conflicts and locks', () => {
    it('tells a text conflict, which a resolver may settle, from a tree or property conflict', () => {
      expect(SvnWorktreeEvidence.conflicts(fixture('status-after-update.xml'), root)).toEqual([
        { path: 'conflict.txt', text: true, other: false },
        { path: 'props.txt', text: false, other: true },
        { path: 'tree.txt', text: false, other: true },
      ])
    })

    it('names the directories svn marks as locked', () => {
      const xml = `<status><target path="${root}"><entry path="${root}"><wc-status item="normal" props="none" wc-locked="true"/></entry>`
        + `<entry path="${join(root, 'a.txt')}"><wc-status item="modified" props="none"/></entry></target></status>`
      expect(SvnWorktreeEvidence.lockedPaths(xml, root)).toEqual(['.'])
      expect(SvnWorktreeEvidence.lockedPaths(fixture('status-after-update.xml'), root)).toEqual([])
    })
  })

  describe('pinned externals', () => {
    const properties = (target: string, value: string): string =>
      `<properties><target path="${target}"><property name="svn:externals">${value}</property></target></properties>`

    it('uses the update parser for date pins and quoted or escaped local names', () => {
      const value = ['^/lib@{2026-10-18} "date pin"', '^/lib@%7B2026-10-18%7D escaped\\ pin',
        "'old style' -r1 ^/lib", '^/lib floating'].join('\n')
      expect(SvnWorktreeEvidence.pinnedExternals(properties(root, value), root)).toEqual(['date pin', 'escaped pin', 'old style'])
    })

    it('reads a revision in both definition formats and a peg revision, and nothing from a floating one', () => {
      const value = [
        '^/libs/pinned@12 pinned-peg',
        '-r 7 https://svn.test/repos/libs/old pinned-r',
        '-r9 //svn.test/repos/libs/tight pinned-tight',
        'old-style -r 5 https://svn.test/repos/libs/legacy',
        '^/libs/floating floating',
        '# ^/libs/comment@3 commented',
        '',
      ].join('\n')
      expect(SvnWorktreeEvidence.pinnedExternals(properties(root, value), root))
        .toEqual(['pinned-peg', 'pinned-r', 'pinned-tight', 'old-style'])
    })

    it('places a definition on a subdirectory below it, and refuses a document that is no property list', () => {
      expect(SvnWorktreeEvidence.pinnedExternals(properties(join(root, 'shared'), '../../libs/x@3 clients/coinGecko'), root))
        .toEqual(['shared/clients/coinGecko'])
      expect(() => SvnWorktreeEvidence.pinnedExternals('<status/>', root)).toThrow(/no <properties> document/)
    })
  })

  describe('incoming', () => {
    const logged = () => SvnWorktreeEvidence.loggedRows(fixture('log-range.xml'), '/Project', '')

    it('counts every logged path of a changed project except the root and .aidocs, each once', () => {
      expect(SvnWorktreeEvidence.incoming(['src/a.txt'], logged(), 'whole')).toEqual(['conflict.txt', 'gone.txt', 'keep.txt',
        'props.txt', 'src', 'src/a.txt', 'src/b.txt', 'src/new.txt', 'tree.txt'])
      expect(SvnWorktreeEvidence.incoming([], logged(), 'whole')).toEqual([])
    })

    it('in a product group counts only a member project the session changed', () => {
      expect(SvnWorktreeEvidence.incoming(['src/added.txt'], logged(), 'first-segment'))
        .toEqual(['src', 'src/a.txt', 'src/b.txt', 'src/new.txt'])
      expect(SvnWorktreeEvidence.incoming(['mount/x.txt', '.aidocs/n.md'], logged(), 'first-segment')).toEqual([])
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

  describe('own commits', () => {
    it('finds a clean commit from this working copy, and not a foreign revision taken in by a single-path update', async () => {
      await expect(SvnWorktreeEvidence.ownCommitRows({ items: foreign(), revisionLog }))
        .resolves.toEqual([{ revision: 6, action: 'M', path: 'src/a.txt' }])
      await expect(SvnWorktreeEvidence.ownCommitRows({ items: committed(), revisionLog }))
        .resolves.toEqual([{ revision: 6, action: 'M', path: 'src/a.txt' }])
    })

    it('reports an added directory for the items below it and reads no history when the working copy sits at one BASE', async () => {
      const items: SvnVerboseItem[] = [{ path: '.', item: 'normal', props: 'none', base: 10, changed: 8 },
        { path: 'new', item: 'normal', props: 'none', base: 15, changed: 15 },
        { path: 'new/n.txt', item: 'normal', props: 'none', base: 15, changed: 15 }]
      const added = [{ revision: 15, action: 'A' as const, path: 'new' }]
      await expect(SvnWorktreeEvidence.ownCommitRows({ items, revisionLog: async () => added })).resolves.toEqual(added)
      await expect(SvnWorktreeEvidence.ownCommitRows({ items: [{ path: '.', item: 'normal', props: 'none', base: 10, changed: 10 }],
        revisionLog: noHistory })).resolves.toEqual([])
    })

    it('says before each candidate\'s log which of how many it reads, and changes no row', async () => {
      const items: SvnVerboseItem[] = [{ path: '.', item: 'normal', props: 'none', base: 10, changed: 8 },
        { path: 'a.txt', item: 'normal', props: 'none', base: 12, changed: 12 },
        { path: 'b.txt', item: 'normal', props: 'none', base: 15, changed: 15 }]
      const events: string[] = []
      const log = async (revision: number): Promise<SvnLoggedRow[]> => {
        events.push(`log r${revision}`)
        return [{ revision, action: 'M', path: revision === 12 ? 'a.txt' : 'b.txt' }]
      }
      const counted = await SvnWorktreeEvidence.ownCommitRows({ items, revisionLog: log,
        onRevision: (revision, index, count) => events.push(`r${revision} ${index} of ${count}`) })
      expect(events).toEqual(['r12 1 of 2', 'log r12', 'r15 2 of 2', 'log r15'])
      expect(await SvnWorktreeEvidence.ownCommitRows({ items, revisionLog: log })).toEqual(counted)

      const none: string[] = []
      await SvnWorktreeEvidence.ownCommitRows({ items: [{ path: '.', item: 'normal', props: 'none', base: 10, changed: 10 }],
        revisionLog: noHistory, onRevision: (revision) => none.push(`r${revision}`) })
      expect(none).toEqual([])
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
