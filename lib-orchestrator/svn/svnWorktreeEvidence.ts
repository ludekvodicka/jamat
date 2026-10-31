import { relative, resolve } from 'node:path'

import { XMLParser } from 'fast-xml-parser'

import { JsonShape } from '../shared/jsonShape'
import { SvnExternalDefinitions } from './svnExternalDefinitions'
import type {
  SvnAttribution,
  SvnConflictRow,
  SvnGroupMembers,
  SvnInfoEntry,
  SvnLogAction,
  SvnLogEntry,
  SvnLoggedRow,
  SvnOwnCommitInput,
  SvnProofInput,
  SvnReceiptInput,
  SvnStatusKind,
  SvnStatusRow,
  SvnVerboseItem,
  SvnWcItem,
  SvnWcProps,
} from './svn.types'

const wcItems: readonly SvnWcItem[] = ['added', 'conflicted', 'deleted', 'external', 'ignored', 'incomplete', 'merged',
  'missing', 'modified', 'none', 'normal', 'obstructed', 'replaced', 'unversioned']
const wcProps: readonly SvnWcProps[] = ['none', 'normal', 'modified', 'conflicted']
const logActions: readonly SvnLogAction[] = ['A', 'D', 'M', 'R']
const listElements = new Set(['target', 'changelist', 'entry', 'logentry', 'path', 'property'])

/**
 * What an SVN action knows about SVN, as pure reads: XML in, rows out. Every read of the repository
 * is a callback, so nothing here starts a process.
 *
 * Paths come from XML, never from plain-text output, where they are printed in the ANSI code page
 * and a non-ASCII name could no longer be matched to the file that holds a change.
 */
export class SvnWorktreeEvidence {
  private static readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    // A path may begin or end with a space.
    trimValues: false,
    isArray: (name) => listElements.has(name),
  })

  /**
   * Whether svn.exe can take `text` as an argument. It reads its command line in the ANSI code page
   * and maps a character outside it to a look-alike (`ř` arrives as `r`), which names another file
   * without an error, so only ASCII is safe on every machine. A working directory is not affected.
   */
  static takesArgument(text: string): boolean {
    return /^[\x20-\x7e]*$/.test(text)
  }

  static relativeTo(root: string, path: string): string {
    const rel = relative(root, resolve(root, path)).split(/[\\/]/).filter(Boolean).join('/')
    return rel === '' ? '.' : rel
  }

  static place(own: string, rel: string): string {
    if (own === '') return rel
    return rel === '.' ? own : `${own}/${rel}`
  }

  /** `svn status --xml`: one row per entry, changelists included. */
  static statusRows(xml: string, root: string): SvnStatusRow[] {
    return SvnWorktreeEvidence.statusEntries(xml).map(({ path, status }) => {
      const item = SvnWorktreeEvidence.itemOf(status['@_item'])
      const props = SvnWorktreeEvidence.propsOf(status['@_props'])
      const conflict = item === 'conflicted' || props === 'conflicted' || status['@_tree-conflicted'] === 'true'
      return { kind: SvnWorktreeEvidence.kindOf(item, props), conflict, path: SvnWorktreeEvidence.relativeTo(root, path), ...(item === 'deleted' ? { deleted: true as const } : {}),
        ...(item === 'unversioned' ? { unversioned: true as const } : {}) }
    })
  }

  /** `svn status -v --xml`, placed in the worktree at `own`. */
  static statusVerboseRows(xml: string, root: string, own = ''): SvnVerboseItem[] {
    return SvnWorktreeEvidence.statusEntries(xml).map(({ path, status }) => ({
      path: SvnWorktreeEvidence.place(own, SvnWorktreeEvidence.relativeTo(root, path)),
      item: SvnWorktreeEvidence.itemOf(status['@_item']),
      props: SvnWorktreeEvidence.propsOf(status['@_props']),
      // svn writes -1 for an item scheduled for addition: it has no BASE yet.
      base: status['@_revision'] === '-1' ? 0 : SvnWorktreeEvidence.revisionOf(status['@_revision'] ?? '0'),
      changed: SvnWorktreeEvidence.revisionOf(JsonShape.record(status.commit)?.['@_revision'] ?? '0'),
    }))
  }

  /**
   * `svn log -v --xml`: the paths each revision changed below `base`, the repository path the root
   * checks out, placed at `own`. Paths outside `base` are dropped.
   */
  static loggedRows(xml: string, base: string, own: string): SvnLoggedRow[] {
    const document = JsonShape.record(SvnWorktreeEvidence.parser.parse(xml))
    if (document === null || document.log === undefined) throw new Error('svn log gave no <log> document')
    // A log without entries parses to its whitespace: no commit in the range touched this path.
    const log = JsonShape.record(document.log)
    if (log === null) return []
    const rows: SvnLoggedRow[] = []
    for (const value of SvnWorktreeEvidence.list(log.logentry, 'logentry')) {
      const entry = SvnWorktreeEvidence.node(value, 'logentry')
      const revision = SvnWorktreeEvidence.revisionOf(entry['@_revision'])
      const paths = JsonShape.record(entry.paths)
      for (const pathValue of SvnWorktreeEvidence.list(paths?.path, 'path')) {
        const path = SvnWorktreeEvidence.node(pathValue, 'path')
        const changed = SvnWorktreeEvidence.text(path)
        let rel: string
        if (changed === base) rel = '.'
        else if (changed.startsWith(`${base}/`)) rel = changed.slice(base.length + 1) || '.'
        else continue
        rows.push({ revision, action: SvnWorktreeEvidence.actionOf(path['@_action']), path: SvnWorktreeEvidence.place(own, rel) })
      }
    }
    return rows
  }

  /** `svn log --xml`: revision, author and message of each commit, as svn wrote them (UTF-8, any script). */
  static logEntries(xml: string): SvnLogEntry[] {
    const document = JsonShape.record(SvnWorktreeEvidence.parser.parse(xml))
    if (document === null || document.log === undefined) throw new Error('svn log gave no <log> document')
    // A log without entries parses to its whitespace.
    const log = JsonShape.record(document.log)
    if (log === null) return []
    return SvnWorktreeEvidence.list(log.logentry, 'logentry').map((value) => {
      const entry = SvnWorktreeEvidence.node(value, 'logentry')
      const author = entry.author === undefined ? null : SvnWorktreeEvidence.text(entry.author)
      return { revision: SvnWorktreeEvidence.revisionOf(entry['@_revision']), author, message: SvnWorktreeEvidence.text(entry.msg) }
    })
  }

  /** `svn info --xml`, of working-copy paths or of a repository URL. */
  static infoEntries(xml: string): SvnInfoEntry[] {
    const info = JsonShape.record(JsonShape.record(SvnWorktreeEvidence.parser.parse(xml))?.info)
    if (info === null) throw new Error('svn info gave no <info> document')
    return SvnWorktreeEvidence.list(info.entry, 'entry').map((value) => {
      const entry = SvnWorktreeEvidence.node(value, 'entry')
      const path = entry['@_path']
      const kind = entry['@_kind']
      if (typeof path !== 'string') throw new Error('svn info gave an entry without a path')
      if (kind !== 'file' && kind !== 'dir') throw new Error(`svn info gave ${path} the unknown kind ${String(kind)}`)
      const relativeUrl = SvnWorktreeEvidence.text(entry['relative-url'])
      return {
        path,
        kind,
        revision: SvnWorktreeEvidence.revisionOf(entry['@_revision']),
        url: SvnWorktreeEvidence.text(entry.url),
        repository: SvnWorktreeEvidence.text(JsonShape.record(entry.repository)?.root),
        base: decodeURIComponent(relativeUrl.replace(/^\^/, '')).replace(/\/$/, ''),
      }
    })
  }

  /** The conflicted rows of `svn status --xml`: a text conflict apart from a tree or property conflict. */
  static conflicts(xml: string, root: string): SvnConflictRow[] {
    return SvnWorktreeEvidence.statusEntries(xml).flatMap(({ path, status }) => {
      const text = SvnWorktreeEvidence.itemOf(status['@_item']) === 'conflicted'
      const other = SvnWorktreeEvidence.propsOf(status['@_props']) === 'conflicted' || status['@_tree-conflicted'] === 'true'
      return text || other ? [{ path: SvnWorktreeEvidence.relativeTo(root, path), text, other }] : []
    })
  }

  /** The directories `svn status --xml` marks as locked by an svn process (E155004 once it is gone). */
  static lockedPaths(xml: string, root: string): string[] {
    return SvnWorktreeEvidence.statusEntries(xml)
      .filter(({ status }) => status['@_wc-locked'] === 'true')
      .map(({ path }) => SvnWorktreeEvidence.relativeTo(root, path))
  }

  static updateProblems(xml: string, root: string, revision: number): string[] {
    return SvnWorktreeEvidence.statusEntries(xml).flatMap(({ path, status }) => {
      if (status['@_file-external'] === 'true' || status['@_item'] === 'external') return []
      const item = status['@_item']
      const incomplete = item === 'incomplete' || item === 'obstructed' || item === 'missing'
        || status['@_switched'] === 'true'
        || status['@_copied'] !== 'true' && (item === 'normal' || item === 'modified' || item === 'merged') && Number(status['@_revision']) !== revision
      return incomplete ? [SvnWorktreeEvidence.relativeTo(root, path)] : []
    })
  }

  /** Whether `svn status --xml` names a file external, which `--ignore-externals` still lists. */
  static fileExternals(xml: string): boolean {
    return SvnWorktreeEvidence.statusEntries(xml).some(({ status }) => status['@_file-external'] === 'true')
  }

  static registeredFileExternal(xml: string): boolean {
    const entries = SvnWorktreeEvidence.statusEntries(xml)
    return entries.length === 1 && entries[0].status['@_file-external'] === 'true'
  }

  /**
   * The externals whose definition names a revision (`-r N` or a peg `@N`), from `svn propget
   * svn:externals -R --xml` of the worktree, worktree-relative. Such a mount checks out an old
   * revision, so a review of it cannot commit. Both definition formats are read: `[-r N] URL[@N] DIR`
   * and the old `DIR [-r N] URL`.
   */
  static pinnedExternals(xml: string, root: string): string[] {
    return Object.entries(SvnExternalDefinitions.properties(xml, root)).flatMap(([carrier, value]) =>
      SvnExternalDefinitions.parse(carrier, value)
        .filter((definition) => definition.revision !== undefined || SvnExternalDefinitions.peg(definition.url) !== undefined)
        .map((definition) => SvnWorktreeEvidence.relativeTo(root, definition.path)))
  }

  /**
   * The logged paths other commits brought in that share a project with the change set `changed`.
   * Tests passed before such an update prove nothing. The root and `.aidocs` never count.
   */
  static incoming(changed: readonly string[], logged: readonly SvnLoggedRow[], members: SvnGroupMembers): string[] {
    const projectOf = (rel: string): string => {
      switch (members) {
        case 'whole': return '.'
        case 'first-segment': return rel.split('/')[0]
        default: throw new Error(`Unknown group members ${String(members satisfies never)}`)
      }
    }
    const touched = new Set(changed.map(projectOf))
    const paths: string[] = []
    for (const row of logged) {
      if (row.path === '.' || row.path.split('/').includes('.aidocs')) continue
      if (touched.has(projectOf(row.path)) && !paths.includes(row.path)) paths.push(row.path)
    }
    return paths
  }

  /** The rows that are a change: content, add, delete, unversioned, missing or properties. */
  static changed(rows: readonly SvnStatusRow[]): SvnStatusRow[] {
    return rows.filter((row) => {
      switch (row.kind) {
        case 'item':
        case 'missing':
        case 'props':
          return true
        case 'clean':
        case 'external':
          return false
        default: throw new Error(`Unknown svn status kind ${String(row.kind satisfies never)}`)
      }
    })
  }

  /**
   * The changed paths a Finish leaves unpublished. The files svn writes beside a conflicted path
   * (`.mine`, `.working`, `.r<N>`, `.merge-left.r<N>`, `.prej`, `dir_conflicts.prej`) belong to that
   * conflict, so the path is named and they are not (UA1-J10-10).
   */
  static unpublished(changed: readonly SvnStatusRow[]): string[] {
    const conflicted = changed.filter((row) => row.conflict).map((row) => row.path)
    return changed.filter((row) => row.conflict || !SvnWorktreeEvidence.conflictFileOf(row.path, conflicted)).map((row) => row.path)
  }

  private static conflictFileOf(path: string, conflicted: readonly string[]): boolean {
    return conflicted.some((owner) => {
      if (path.startsWith(`${owner}.`) && /^\.(?:mine|working|r\d+|merge-(?:left|right)\.r\d+|prej)$/.test(path.slice(owner.length))) return true
      const directory = owner === '.' ? '' : `${owner}/`
      return path.startsWith(directory) && /^dir_conflicts(?:\.\d+)?\.prej$/.test(path.slice(directory.length))
    })
  }

  /** A clean item whose BASE is its last change: the commit that set it came from this working copy. */
  static committedHere(item: SvnVerboseItem): boolean {
    return item.item === 'normal' && (item.props === 'none' || item.props === 'normal')
      && item.base > 0 && item.base === item.changed
  }

  /**
   * Without a review receipt, the rows the claimed paths of this root committed above `since`. It
   * throws when an unclaimed item left `rootBase`, because an update during the review makes the
   * proof impossible, and when a deletion cannot be tied to one revision.
   */
  static async provenRows(input: SvnProofInput): Promise<SvnLoggedRow[]> {
    const { items, own, rootBase, since, claimed } = input
    if (!SvnWorktreeEvidence.isRevision(rootBase) || !SvnWorktreeEvidence.isRevision(since))
      throw new Error('A BASE proof needs the numeric root BASE and pre-review revision')
    // A claim on the root itself covers only its properties; a claimed directory covers what it holds.
    const self = own === '' ? '.' : own
    const isClaimed = (path: string): boolean =>
      claimed.some((claim) => path === claim || (claim !== self && path.startsWith(`${claim}/`)))
    const moved = items.find((item) => !isClaimed(item.path) && item.base > 0 && item.base !== rootBase)
    if (moved !== undefined)
      throw new Error(`${moved.path} left BASE r${rootBase} for r${moved.base} during the review; no proof without a review receipt`)
    let history: SvnLoggedRow[] | null = null
    const revisions = new Set<number>()
    for (const path of claimed) {
      const item = items.find((entry) => entry.path === path)
      if (item !== undefined) {
        if (SvnWorktreeEvidence.committedHere(item) && item.base > since) revisions.add(item.base)
        continue
      }
      // Gone from the working copy while no update ran: only a commit from here removed the entry.
      history ??= await input.history()
      const deleting = [...new Set(history
        .filter((row) => row.action === 'D' && (row.path === path || path.startsWith(`${row.path}/`)))
        .map((row) => row.revision))]
      if (deleting.length > 1)
        throw new Error(`${path} was deleted in ${deleting.map((revision) => `r${revision}`).join(' and ')}; no proof of which one was ours`)
      if (deleting.length === 1) revisions.add(deleting[0])
    }
    const rows: SvnLoggedRow[] = []
    for (const revision of revisions) {
      const logged = await input.revisionLog(revision)
      if (logged.length > 0 && logged.every((row) => isClaimed(row.path))) rows.push(...logged)
    }
    return rows
  }

  /** The rows of the one revision a review receipt names, once the log confirms it below this root. */
  static async reviewedRows(input: SvnReceiptInput): Promise<SvnLoggedRow[]> {
    const { revision, since, base } = input
    if (!SvnWorktreeEvidence.isRevision(revision) || revision === 0 || !SvnWorktreeEvidence.isRevision(since)
      || revision <= since)
      throw new Error('The reviewed revision does not follow the pre-review repository state')
    const rows = await input.revisionLog(revision)
    if (rows.length === 0 || rows.some((row) => row.revision !== revision))
      throw new Error(`SVN history does not confirm review revision r${revision} below ${base}`)
    return rows
  }

  /**
   * The rows of this working copy's own commits since its checkout: clean items whose BASE is their
   * last change, above the lowest BASE. A foreign revision taken in by updating a single path is
   * skipped, because a commit from here leaves each of its paths at that revision or later.
   */
  static async ownCommitRows(input: SvnOwnCommitInput): Promise<SvnLoggedRow[]> {
    const { items } = input
    const rows: SvnLoggedRow[] = []
    const candidates = [...SvnWorktreeEvidence.candidates(items)]
    for (const [index, [revision, paths]] of candidates.entries()) {
      input.onRevision?.(revision, index + 1, candidates.length)
      const logged = await input.revisionLog(revision)
      if (logged.some((entry) => entry.action !== 'D'
        && items.some((item) => item.path === entry.path && item.base < revision)))
        continue
      for (const path of paths) {
        const entry = logged.find((row) => row.path === path)
          ?? logged.find((row) => (row.action === 'A' || row.action === 'R') && path.startsWith(`${row.path}/`))
        if (entry !== undefined && !rows.includes(entry)) rows.push(entry)
      }
    }
    return rows
  }

  /**
   * Which changed paths the logged rows committed: a path the log names, one below a directory the
   * log deleted, or, unless only its properties changed, one the log names something below.
   */
  static attribution(changed: readonly SvnStatusRow[], logged: readonly SvnLoggedRow[]): SvnAttribution {
    const committed: string[] = []
    const remaining: string[] = []
    const revisions = new Set<number>()
    for (const row of SvnWorktreeEvidence.changed(changed)) {
      const hit = logged.find((entry) => entry.path === row.path
        || (entry.action === 'D' && row.path.startsWith(`${entry.path}/`))
        || (row.kind !== 'props' && entry.path.startsWith(`${row.path}/`)))
      if (hit === undefined) remaining.push(row.path)
      else {
        committed.push(row.path)
        revisions.add(hit.revision)
      }
    }
    return { committed, remaining, revisions: [...revisions].sort((a, b) => a - b) }
  }

  /** Clean items committed here above the lowest BASE, by revision. */
  private static candidates(items: readonly SvnVerboseItem[]): Map<number, string[]> {
    const byRevision = new Map<number, string[]>()
    const lowest = items.reduce((low, item) => item.base > 0 && item.base < low ? item.base : low, Number.POSITIVE_INFINITY)
    for (const item of items) {
      if (!SvnWorktreeEvidence.committedHere(item) || item.base <= lowest) continue
      byRevision.set(item.base, [...byRevision.get(item.base) ?? [], item.path])
    }
    return byRevision
  }

  private static statusEntries(xml: string): { path: string; status: Record<string, unknown> }[] {
    const status = JsonShape.record(JsonShape.record(SvnWorktreeEvidence.parser.parse(xml))?.status)
    if (status === null) throw new Error('svn status gave no <status> document')
    const entries: { path: string; status: Record<string, unknown> }[] = []
    for (const group of [...SvnWorktreeEvidence.list(status.target, 'target'), ...SvnWorktreeEvidence.list(status.changelist, 'changelist')])
      for (const value of SvnWorktreeEvidence.list(JsonShape.record(group)?.entry, 'entry')) {
        const entry = SvnWorktreeEvidence.node(value, 'entry')
        const path = entry['@_path']
        if (typeof path !== 'string') throw new Error('svn status gave an entry without a path')
        const wcStatus = JsonShape.record(entry['wc-status'])
        if (wcStatus === null) throw new Error(`svn status gave no state for ${path}`)
        entries.push({ path, status: wcStatus })
      }
    return entries
  }

  private static kindOf(item: SvnWcItem, props: SvnWcProps): SvnStatusKind {
    switch (item) {
      case 'missing':
        return 'missing'
      case 'added':
      case 'conflicted':
      case 'deleted':
      case 'incomplete':
      case 'merged':
      case 'modified':
      case 'obstructed':
      case 'replaced':
      case 'unversioned':
        return 'item'
      case 'external':
        return 'external'
      case 'ignored':
      case 'none':
      case 'normal':
        return props === 'modified' || props === 'conflicted' ? 'props' : 'clean'
      default: throw new Error(`Unknown svn status item ${String(item satisfies never)}`)
    }
  }

  private static itemOf(value: unknown): SvnWcItem {
    const item = wcItems.find((known) => known === value)
    if (item === undefined) throw new Error(`Unknown svn status item: ${String(value)}`)
    return item
  }

  private static propsOf(value: unknown): SvnWcProps {
    if (value === undefined) return 'none'
    const props = wcProps.find((known) => known === value)
    if (props === undefined) throw new Error(`Unknown svn status props: ${String(value)}`)
    return props
  }

  private static actionOf(value: unknown): SvnLogAction {
    const action = logActions.find((known) => known === value)
    if (action === undefined) throw new Error(`Unknown svn log action: ${String(value)}`)
    return action
  }

  private static revisionOf(value: unknown): number {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`svn gave the revision ${String(value)}`)
    return Number(value)
  }

  private static isRevision(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0
  }

  private static list(value: unknown, name: string): unknown[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error(`svn gave a malformed <${name}> list`)
    return value
  }

  private static node(value: unknown, name: string): Record<string, unknown> {
    const node = JsonShape.record(value)
    if (node === null) throw new Error(`svn gave a malformed <${name}>`)
    return node
  }

  private static text(value: unknown): string {
    if (typeof value === 'string') return value
    const text = JsonShape.record(value)?.['#text']
    return typeof text === 'string' ? text : ''
  }
}
