import { XMLParser } from 'fast-xml-parser'

import { JsonShape } from '../shared/jsonShape'
import type {
  SvnContentFacts,
  SvnItemRow,
  SvnNodeKind,
  SvnPropertyFacts,
  SvnTreeAction,
  SvnTreeFacts,
  SvnTreeReason,
} from './svn.types'
import { SvnWorktreeEvidence } from './svnWorktreeEvidence'
import { SvnTextMerge } from './svnTextMerge'

/** A conflicted row of `svn status --xml`, by the kinds svn marks on it. */
export interface SvnConflictedRow {
  /** Relative to the root the status was read for, with `/`. */
  path: string
  tree: boolean
  text: boolean
  property: boolean
}

/** One `<entry>` of `svn info --xml` with the conflicts svn describes on it. */
export interface SvnInfoConflicts {
  /** As svn wrote it, relative to the working directory of the read; `.` is that directory. */
  name: string
  url: string
  /** The node's kind in the working copy. */
  kind: SvnNodeKind
  /** SHA-1 of the BASE text of a file, which after an update holds the incoming side. */
  checksum: string | null
  /** The root of the working copy that holds the node, absolute as svn wrote it; an external has its own. */
  wcRoot: string | null
  tree: SvnTreeFacts | null
  text: boolean
  property: boolean
  propertySources: { older: SvnConflictSource | null; theirs: SvnConflictSource | null } | null
  /** Absolute paths as svn wrote them: `.r<old>`, `.mine`, `.r<new>` and `.prej`. */
  sidecars: { older: string | null; mine: string | null; theirs: string | null; prej: string | null }
}

export interface SvnConflictSource { url: string; revision: number }

const listElements = new Set(['target', 'entry', 'property', 'conflict', 'version', 'logentry', 'path'])

/**
 * svn's facts about the conflicts of a working copy, as pure reads: XML and bytes in, facts out.
 * The element and attribute names are those svn 1.14 writes (`docs/architecture/svn-conflict-resolution.md`,
 * "The svn 1.14 spike"). An svn word this class does not know reads as `unrecognized`, never as a
 * throw, so a newer svn still lists the conflict and only the person settles it.
 */
export class SvnConflictFacts {
  private static readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: false,
    htmlEntities: true,
    isArray: (name) => listElements.has(name),
  })

  private static readonly reasonsConst: Readonly<Record<string, SvnTreeReason>> = {
    edit: 'edited', obstruction: 'obstructed', delete: 'deleted', missing: 'missing', unversioned: 'unversioned',
    add: 'added', replace: 'replaced', 'moved-away': 'moved-away', 'moved-here': 'moved-here',
  }

  private static readonly actionsConst: Readonly<Record<string, SvnTreeAction>> = {
    edit: 'edited', add: 'added', delete: 'deleted', replace: 'replaced',
  }

  /** The conflicted rows of `svn status --xml`, with each kind svn marks. */
  static conflictedRows(xml: string, root: string): SvnConflictedRow[] {
    const status = JsonShape.record(JsonShape.record(SvnConflictFacts.parser.parse(xml))?.status)
    if (status === null) throw new Error('svn status gave no <status> document')
    const rows: SvnConflictedRow[] = []
    for (const target of SvnConflictFacts.list(status.target))
      for (const value of SvnConflictFacts.list(JsonShape.record(target)?.entry)) {
        const entry = SvnConflictFacts.node(value, 'entry')
        const path = entry['@_path']
        const state = JsonShape.record(entry['wc-status'])
        if (typeof path !== 'string' || state === null) throw new Error('svn status gave an entry without a path or a state')
        const row = {
          path: SvnWorktreeEvidence.relativeTo(root, path),
          tree: state['@_tree-conflicted'] === 'true',
          text: state['@_item'] === 'conflicted',
          property: state['@_props'] === 'conflicted',
        }
        if (row.tree || row.text || row.property) rows.push(row)
      }
    return rows
  }

  /** Every row of `svn status --xml` with its item, its BASE and whether svn marks a conflict on it. */
  static itemRows(xml: string, root: string): SvnItemRow[] {
    const conflicted = new Set(SvnWorktreeEvidence.statusRows(xml, root).filter((row) => row.conflict).map((row) => row.path))
    return SvnWorktreeEvidence.statusVerboseRows(xml, root)
      .map((row) => ({ path: row.path, item: row.item, conflict: conflicted.has(row.path), base: row.base }))
  }

  /** `svn info --xml`: each entry with its tree, text and property conflict facts. */
  static infoConflicts(xml: string): SvnInfoConflicts[] {
    const info = JsonShape.record(JsonShape.record(SvnConflictFacts.parser.parse(xml))?.info)
    if (info === null) throw new Error('svn info gave no <info> document')
    return SvnConflictFacts.list(info.entry).map((value) => {
      const entry = SvnConflictFacts.node(value, 'entry')
      const name = entry['@_path']
      if (typeof name !== 'string') throw new Error('svn info gave an entry without a path')
      const conflicts = SvnConflictFacts.list(entry.conflict).map((conflict) => SvnConflictFacts.node(conflict, 'conflict'))
      const text = conflicts.find((conflict) => conflict['@_type'] === 'text')
      const property = conflicts.find((conflict) => conflict['@_type'] === 'property')
      const treeNode = JsonShape.record(entry['tree-conflict'])
      const wcInfo = JsonShape.record(entry['wc-info'])
      const history = SvnConflictFacts.text(wcInfo?.['copy-from-url']) !== ''
      const older = SvnConflictFacts.optionalText(text?.['prev-base-file'])
      const mine = SvnConflictFacts.optionalText(text?.['prev-wc-file'])
      const theirs = SvnConflictFacts.optionalText(text?.['cur-base-file'])
      // svn 1.14 names a text sidecar as the prop-file of a property conflict beside a text one; `prejOf` finds the real one.
      const prej = SvnConflictFacts.optionalText(property?.['prop-file'])
      return {
        name: name.replaceAll('\\', '/'),
        url: SvnConflictFacts.text(entry.url),
        kind: SvnConflictFacts.kindOf(entry['@_kind']),
        checksum: SvnConflictFacts.optionalText(wcInfo?.checksum),
        wcRoot: SvnConflictFacts.optionalText(wcInfo?.['wcroot-abspath']),
        tree: treeNode === null ? null : SvnConflictFacts.treeOf(treeNode, history, SvnConflictFacts.optionalText(wcInfo?.['moved-to'])),
        text: text !== undefined,
        property: property !== undefined,
        propertySources: property !== undefined && (property['@_operation'] === 'merge' || property['@_operation'] === 'update') ? {
          older: SvnConflictFacts.sourceOf(property, 'source-left'),
          theirs: SvnConflictFacts.sourceOf(property, 'source-right'),
        } : null,
        sidecars: { older, mine, theirs, prej: prej !== null && [older, mine, theirs].includes(prej) ? null : prej },
      }
    })
  }

  /**
   * The `.prej` files of a property conflict on `name` among the names of its directory: svn writes
   * `<name>.prej`, or `<name>.<n>.prej` when that name is taken. svn's own name wins when it gave one.
   */
  static prejOf(entry: SvnInfoConflicts, directory: string, siblings: readonly string[]): string[] {
    if (!entry.property) return []
    if (entry.sidecars.prej !== null) return [entry.sidecars.prej]
    const name = entry.name.slice(entry.name.lastIndexOf('/') + 1)
    return siblings.filter((sibling) => sibling.startsWith(`${name}.`) && /^(?:\d+\.)?prej$/.test(sibling.slice(name.length + 1)))
      .sort().map((sibling) => `${directory.replaceAll('\\', '/').replace(/\/$/, '')}/${sibling}`)
  }

  /**
   * `svn proplist -v --xml`: the properties of each target. A URL target is named relative to
   * `url`, a working-copy target as svn wrote it; the target itself is `.`.
   */
  static propertiesOf(xml: string, url?: string): Map<string, Map<string, string>> {
    const document = JsonShape.record(SvnConflictFacts.parser.parse(xml))
    if (document === null || !('properties' in document)) throw new Error('svn proplist gave no <properties> document')
    // An empty <properties> parses to its whitespace text.
    const properties = JsonShape.record(document.properties) ?? {}
    const targets = new Map<string, Map<string, string>>()
    for (const value of SvnConflictFacts.list(properties.target)) {
      const target = SvnConflictFacts.node(value, 'target')
      const path = target['@_path']
      if (typeof path !== 'string') throw new Error('svn proplist gave a target without a path')
      const values = new Map<string, string>()
      for (const propertyValue of SvnConflictFacts.list(target.property)) {
        const property = SvnConflictFacts.node(propertyValue, 'property')
        const name = property['@_name']
        if (typeof name !== 'string') throw new Error(`svn proplist gave ${path} a property without a name`)
        const text = SvnConflictFacts.text(property)
        values.set(name, property['@_encoding'] === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text)
      }
      targets.set(SvnConflictFacts.targetName(path, url), values)
    }
    return targets
  }

  /** The properties whose value before the update, in the working copy and in the new BASE all differ pairwise. */
  static conflictedProperties(older: ReadonlyMap<string, string>, mine: ReadonlyMap<string, string>, theirs: ReadonlyMap<string, string>): SvnPropertyFacts[] {
    const names = [...new Set([...older.keys(), ...mine.keys(), ...theirs.keys()])].sort()
    return names.flatMap((name) => {
      const facts = { name, older: older.get(name) ?? null, mine: mine.get(name) ?? null, theirs: theirs.get(name) ?? null }
      return facts.older !== facts.mine && facts.older !== facts.theirs && facts.mine !== facts.theirs ? [facts] : []
    })
  }

  /**
   * Mine against theirs, as bytes: a NUL byte is binary; a UTF-16 byte order mark, or invalid UTF-8
   * without a NUL byte, is unreadable; equal after CRLF to LF is `eol`. Differing text with the side
   * before the update (`older`) is also merged three ways (`merge`).
   */
  static contentOf(mine: Uint8Array | null, theirs: Uint8Array | null, older: Uint8Array | null = null): SvnContentFacts {
    const sides = [mine, theirs, older].filter((side): side is Uint8Array => side !== null)
    const binary = sides.some((side) => side.includes(0))
    const unreadable = sides.some((side) => SvnConflictFacts.utf16(side)) || (!binary && sides.some((side) => !SvnConflictFacts.utf8(side)))
    const equal = mine === null || theirs === null ? null : SvnConflictFacts.equalOf(mine, theirs, binary || unreadable)
    if (equal !== 'differs' || binary || unreadable || older === null || mine === null || theirs === null) return { binary, unreadable, equal }
    return { binary, unreadable, equal, merge: SvnTextMerge.merge(older, mine, theirs) === null ? 'conflict' : 'clean' }
  }

  private static equalOf(mine: Uint8Array, theirs: Uint8Array, bytesOnly: boolean): 'bytes' | 'eol' | 'differs' {
    if (Buffer.from(mine).equals(Buffer.from(theirs))) return 'bytes'
    if (bytesOnly) return 'differs'
    const lf = (side: Uint8Array) => Buffer.from(side).toString('utf8').replaceAll('\r\n', '\n')
    return lf(mine) === lf(theirs) ? 'eol' : 'differs'
  }

  /**
   * Where the other commits moved `path` (worktree-relative), from `svn log -v --xml` of the incoming
   * revisions with the worktree's repository path `base`. A move is an add with history from the path,
   * or from a folder above it, in a revision that deletes that source; moves follow each other in
   * revision order. Null when no commit moved it, when one revision copied the source to more than one
   * place (svn's resolver then names no target either), when a later commit deleted it, or when it
   * left the worktree.
   */
  static incomingMoveOf(xml: string, base: string, path: string, baseRevision = 0): string | null {
    const log = JsonShape.record(JsonShape.record(SvnConflictFacts.parser.parse(xml))?.log)
    const entries = SvnConflictFacts.list(log?.logentry).map((value) => SvnConflictFacts.node(value, 'logentry'))
      .map((entry) => ({ revision: Number(entry['@_revision']), paths: SvnConflictFacts.list(JsonShape.record(entry.paths)?.path)
        .map((value) => SvnConflictFacts.node(value, 'path'))
        .map((node) => ({ action: node['@_action'], path: SvnConflictFacts.text(node), from: node['@_copyfrom-path'] })) }))
      .filter((entry) => entry.revision > baseRevision).sort((a, b) => a.revision - b.revision)
    let current = `${base}/${path}`
    let moved = false
    for (const entry of entries) {
      const deleted = entry.paths.find((change) => (change.action === 'D' || change.action === 'R')
        && (current === change.path || current.startsWith(`${change.path}/`)))
      if (deleted === undefined) continue
      const targets = entry.paths.filter((change) => (change.action === 'A' || change.action === 'R') && change.from === deleted.path)
      if (targets.length !== 1) return null
      current = `${targets[0].path}${current.slice(deleted.path.length)}`
      moved = true
    }
    return moved && current.startsWith(`${base}/`) ? current.slice(base.length + 1) : null
  }

  private static treeOf(node: Record<string, unknown>, history: boolean, movedTo: string | null): SvnTreeFacts {
    const left = SvnConflictFacts.list(node.version).map((version) => SvnConflictFacts.node(version, 'version'))
      .find((version) => version['@_side'] === 'source-left')
    const base = left?.['@_revision']
    const right = SvnConflictFacts.list(node.version).map((version) => SvnConflictFacts.node(version, 'version'))
      .find((version) => version['@_side'] === 'source-right')
    const revision = right?.['@_revision']
    const reason = SvnConflictFacts.reasonsConst[String(node['@_reason'])] ?? 'unrecognized'
    return {
      reason,
      action: SvnConflictFacts.actionsConst[String(node['@_action'])] ?? 'unrecognized',
      localKind: SvnConflictFacts.kindOf(node['@_kind']),
      incomingKind: right === undefined ? 'none' : SvnConflictFacts.kindOf(right['@_kind']),
      incomingRevision: typeof revision === 'string' && /^\d+$/.test(revision) ? Number(revision) : null,
      ...typeof base === 'string' && /^\d+$/.test(base) ? { baseRevision: Number(base) } : {},
      localHistory: history || reason === 'moved-here',
      ...(node['@_operation'] === 'merge' ? { operation: 'merge' as const } : {}),
      ...reason === 'moved-away' && movedTo !== null ? { movedTo: movedTo.replaceAll('\\', '/') } : {},
    }
  }

  private static sourceOf(node: Record<string, unknown>, side: string): SvnConflictSource | null {
    const source = SvnConflictFacts.list(node.version).map((value) => SvnConflictFacts.node(value, 'version'))
      .find((value) => value['@_side'] === side)
    if (source === undefined) throw new Error(`svn merge conflict has no ${side}`)
    if (source['@_kind'] === 'none') return null
    const repository = source['@_repos-url']
    const path = source['@_path-in-repos']
    const revision = source['@_revision']
    if (typeof repository !== 'string' || typeof path !== 'string' || typeof revision !== 'string' || !/^\d+$/.test(revision)
      || path.split('/').some((part) => part === '.' || part === '..')) throw new Error(`svn conflict has an invalid ${side}`)
    return { url: `${repository.replace(/\/$/, '')}${path === '' ? '' : '/' + path.split('/').map(encodeURIComponent).join('/')}`, revision: Number(revision) }
  }

  private static kindOf(value: unknown): SvnNodeKind {
    return value === 'file' || value === 'dir' || value === 'none' ? value : 'unrecognized'
  }

  private static targetName(path: string, url: string | undefined): string {
    if (url === undefined) return path.replaceAll('\\', '/')
    if (path === url) return '.'
    if (!path.startsWith(`${url}/`)) throw new Error(`svn proplist gave the target ${path} outside ${url}`)
    return decodeURIComponent(path.slice(url.length + 1))
  }

  private static utf16(side: Uint8Array): boolean {
    return side.length >= 2 && ((side[0] === 0xff && side[1] === 0xfe) || (side[0] === 0xfe && side[1] === 0xff))
  }

  private static utf8(side: Uint8Array): boolean {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(side)
      return true
    }
    catch { return false }
  }

  private static optionalText(value: unknown): string | null {
    const text = SvnConflictFacts.text(value)
    return text === '' ? null : text
  }

  private static list(value: unknown): unknown[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error('svn gave a malformed list')
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
