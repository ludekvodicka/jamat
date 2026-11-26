import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { PathCompare } from '../shared/pathCompare'
import { ContentHashCache } from './svnContentHash'
import { SvnIgnoreRules } from './svnIgnoreRules'
import { SvnProps } from './svnProps'
import { SvnWcDb, type SvnWcDbNode } from './svnWcDb'

export type SvnDirtyReason = 'added' | 'deleted' | 'moved' | 'props' | 'conflict' | 'missing' | 'modified' | 'unversioned'

export type SvnPathState =
  | { kind: 'clean' }
  | { kind: 'dirty'; reason: SvnDirtyReason }
  | { kind: 'unknown'; detail: string }
  | { kind: 'outside' }

export interface SvnPathFacts {
  state: SvnPathState
  /** `NODES.changed_date` of the committed node in milliseconds, the server time of its last commit; null when it has none. */
  changedAtMs: number | null
}

/**
 * Whether paths hold uncommitted changes, decided the way `svn status` decides it but from
 * `.svn/wc.db`, `stat` and, only when size and time cannot tell, a content hash. No svn process.
 */
export class SvnPathStates {
  private readonly ignores: SvnIgnoreRules
  private readonly hashes: ContentHashCache
  /** Parsed directory properties per working-copy root, kept while its `wc.db` keeps its time and size. */
  private readonly properties = new Map<string, { stamp: string; byRelpath: Map<string, SvnProps> }>()

  constructor(options: { ignores: SvnIgnoreRules; hashes?: ContentHashCache }) {
    this.ignores = options.ignores
    this.hashes = options.hashes ?? new ContentHashCache()
  }

  /** One synchronous open, query and close of `root`'s database; never across an await. Keys are the paths as given. */
  read(root: string, paths: readonly string[]): ReadonlyMap<string, SvnPathFacts> {
    const out = new Map<string, SvnPathFacts>()
    const realRoot = SvnPathStates.realPath(resolve(root))
    const inside = realRoot !== null && existsSync(join(realRoot, '.svn', 'wc.db'))
      ? paths.filter((path) => PathCompare.isInside(realRoot, path))
      : []
    const insideSet = new Set(inside)
    for (const path of paths) if (!insideSet.has(path)) out.set(path, { state: { kind: 'outside' }, changedAtMs: null })
    if (inside.length === 0) return out
    const stamp = SvnPathStates.stampOf(realRoot!)
    if (this.properties.get(realRoot!)?.stamp !== stamp) this.properties.set(realRoot!, { stamp, byRelpath: new Map() })
    const read = SvnWcDb.read(realRoot!, (db) => {
      const facts = new Map<string, SvnPathFacts>()
      for (const path of inside) facts.set(path, this.decideSafely(db, realRoot!, path))
      return facts
    })
    if (read.ok) for (const [path, facts] of read.value) out.set(path, facts)
    else for (const path of inside) out.set(path, { state: { kind: 'unknown', detail: read.detail }, changedAtMs: null })
    return out
  }

  private decideSafely(db: SvnWcDb, root: string, path: string): SvnPathFacts {
    try { return this.decide(db, root, path) }
    catch (error) {
      return { state: { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) }, changedAtMs: null }
    }
  }

  private decide(db: SvnWcDb, root: string, path: string): SvnPathFacts {
    const relpath = SvnPathStates.relpathOf(db, root, path)
    const layers = db.nodes(relpath)
    const top = layers[0]
    const base = layers.find((layer) => layer.opDepth === 0)
    const changedAtMs = base?.changedDate === null || base?.changedDate === undefined ? null : Math.floor(base.changedDate / 1000)
    const facts = (state: SvnPathState): SvnPathFacts => ({ state, changedAtMs })
    if (top !== undefined && top.opDepth > 0) return facts({ kind: 'dirty', reason: SvnPathStates.workingReason(top) })
    const actual = db.actual(relpath)
    if (actual?.conflict === true) return facts({ kind: 'dirty', reason: 'conflict' })
    if (actual !== null && actual.properties !== null) return facts({ kind: 'dirty', reason: 'props' })
    const absolute = relpath === '' ? root : join(root, ...relpath.split('/'))
    if (top === undefined) return facts(this.unversioned(db, root, relpath, absolute))
    switch (top.presence) {
      case 'normal': break
      case 'not-present':
      case 'excluded':
      case 'server-excluded':
        return facts(this.unversioned(db, root, relpath, absolute))
      case 'incomplete': return facts({ kind: 'unknown', detail: 'incomplete node' })
      default: return facts({ kind: 'unknown', detail: `node presence ${top.presence}` })
    }
    switch (top.kind) {
      case 'dir':
      case 'symlink':
        return facts({ kind: 'clean' })
      case 'file': return facts(this.file(absolute, top))
      default: return facts({ kind: 'unknown', detail: `node kind ${top.kind}` })
    }
  }

  private file(absolute: string, node: SvnWcDbNode): SvnPathState {
    const stats = lstatSync(absolute, { bigint: true, throwIfNoEntry: false })
    if (stats === undefined) return { kind: 'dirty', reason: 'missing' }
    if (!stats.isFile()) return { kind: 'dirty', reason: 'modified' }
    if (node.translatedSize !== null && node.lastModTime !== null
      && stats.size === BigInt(node.translatedSize) && stats.mtimeNs / 1000n === BigInt(node.lastModTime))
      return { kind: 'clean' }
    const properties = SvnProps.parseSkel(node.properties)
    if (properties.get('svn:keywords') !== undefined) return { kind: 'dirty', reason: 'modified' }
    const eol = properties.get('svn:eol-style') !== undefined
    if (!eol && node.translatedSize !== null && stats.size !== BigInt(node.translatedSize)) return { kind: 'dirty', reason: 'modified' }
    const sha1 = node.checksum?.startsWith('$sha1$') === true ? node.checksum.slice('$sha1$'.length) : null
    if (sha1 === null) return { kind: 'unknown', detail: 'no pristine checksum' }
    return this.hashes.sha1(absolute, stats, eol) === sha1 ? { kind: 'clean' } : { kind: 'dirty', reason: 'modified' }
  }

  /**
   * D4: decided on the first unversioned segment below the nearest versioned directory, the one
   * `svn status` would list. A path that is gone again, an ignored segment or an external's mount
   * point is clean.
   */
  private unversioned(db: SvnWcDb, root: string, relpath: string, absolute: string): SvnPathState {
    if (!existsSync(absolute)) return { kind: 'clean' }
    const globalIgnores = SvnProps.parseInheritedSkel(db.rootInheritedProperties())
      .flatMap((props) => SvnIgnoreRules.split(props.get('svn:global-ignores') ?? ''))
    let parent = ''
    for (const segment of relpath.split('/')) {
      const parentProps = this.propertiesOf(db, root, parent)
      globalIgnores.push(...SvnIgnoreRules.split(parentProps.get('svn:global-ignores') ?? ''))
      const candidate = parent === '' ? segment : `${parent}/${segment}`
      const node = db.nodes(candidate)[0]
      if (node === undefined || node.presence !== 'normal' || node.kind !== 'dir') {
        if (db.external(candidate) || this.ignores.ignored(segment, parentProps, globalIgnores)) return { kind: 'clean' }
        return { kind: 'dirty', reason: 'unversioned' }
      }
      parent = candidate
    }
    return { kind: 'dirty', reason: 'unversioned' }
  }

  /** A versioned directory's properties: its local changes when it has some, else its own. */
  private propertiesOf(db: SvnWcDb, root: string, relpath: string): SvnProps {
    const cache = this.properties.get(root)!.byRelpath
    const known = cache.get(relpath)
    if (known !== undefined) return known
    const props = SvnProps.parseSkel(db.actual(relpath)?.properties ?? db.nodes(relpath)[0]?.properties ?? null)
    cache.set(relpath, props)
    return props
  }

  private static stampOf(root: string): string {
    try {
      const stats = statSync(join(root, '.svn', 'wc.db'))
      return `${stats.mtimeMs}:${stats.size}`
    }
    catch { return 'missing' }
  }

  private static workingReason(node: SvnWcDbNode): SvnDirtyReason {
    if (node.movedTo !== null || node.movedHere) return 'moved'
    return node.presence === 'base-deleted' ? 'deleted' : 'added'
  }

  /**
   * `local_relpath` is case-sensitive while Windows paths are not. An existing path takes its
   * on-disk spelling; a path that is gone (or reached through a link) takes each segment's stored
   * spelling from its parent's children, which the parent index serves.
   */
  private static relpathOf(db: SvnWcDb, root: string, path: string): string {
    const real = SvnPathStates.realPath(resolve(path))
    if (real !== null && PathCompare.isInside(root, real)) return SvnPathStates.slashed(relative(root, real))
    let relpath = ''
    for (const segment of relative(root, resolve(path)).split(sep).filter((part) => part.length > 0)) {
      const candidate = relpath === '' ? segment : `${relpath}/${segment}`
      relpath = db.caseOf(relpath, candidate) ?? candidate
    }
    return relpath
  }

  private static realPath(path: string): string | null {
    try { return realpathSync.native(path) }
    catch { return null }
  }

  private static slashed(path: string): string {
    return path.split(sep).join('/')
  }

}
