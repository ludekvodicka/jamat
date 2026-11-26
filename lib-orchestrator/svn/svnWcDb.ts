import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export interface SvnWcDbNode {
  opDepth: number
  presence: string
  kind: string
  movedTo: string | null
  movedHere: boolean
  properties: Uint8Array | null
  checksum: string | null
  translatedSize: number | null
  lastModTime: number | null
  changedDate: number | null
}

export interface SvnWcDbActual {
  /** Locally changed properties, null while they equal the node's own. */
  properties: Uint8Array | null
  conflict: boolean
}

export type SvnWcDbRead<T> = { ok: true; value: T } | { ok: false; detail: string }

/**
 * Read-only queries over one working copy's `.svn/wc.db` (format 31, svn 1.14).
 *
 * Everything here is synchronous on purpose: `read` opens, queries and closes inside one block, so
 * the connection can never be held across an `await` while svn waits for its write lock.
 */
export class SvnWcDb {
  static readonly formatConst = 31
  private static readonly busyConst = 5
  private static readonly readonlyRollbackConst = 776

  private readonly wcId: number
  private readonly nodesOf: StatementSync
  private readonly actualOf: StatementSync
  private readonly caseInParent: StatementSync
  private readonly externalAt: StatementSync
  private readonly inherited: StatementSync

  private constructor(db: DatabaseSync, wcId: number) {
    this.wcId = wcId
    this.nodesOf = db.prepare('SELECT op_depth, presence, kind, moved_to, moved_here, properties, checksum, translated_size, '
      + 'last_mod_time, changed_date FROM NODES WHERE wc_id = ? AND local_relpath = ? ORDER BY op_depth DESC')
    this.actualOf = db.prepare('SELECT properties, conflict_data IS NOT NULL AS conflict '
      + 'FROM ACTUAL_NODE WHERE wc_id = ? AND local_relpath = ?')
    this.caseInParent = db.prepare('SELECT local_relpath FROM NODES WHERE wc_id = ? AND parent_relpath = ? '
      + 'AND local_relpath = ? COLLATE NOCASE LIMIT 1')
    this.externalAt = db.prepare('SELECT 1 FROM EXTERNALS WHERE wc_id = ? AND local_relpath = ?')
    this.inherited = db.prepare("SELECT inherited_props FROM NODES WHERE wc_id = ? AND local_relpath = '' AND op_depth = 0")
  }

  /** Opens `<root>/.svn/wc.db`, runs `use` and closes it again; a busy or unreadable database is a failure, never a wait. */
  static read<T>(root: string, use: (db: SvnWcDb) => T): SvnWcDbRead<T> {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(join(root, '.svn', 'wc.db'), { readOnly: true })
      db.exec('PRAGMA busy_timeout = 0')
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== SvnWcDb.formatConst) return { ok: false, detail: `wc.db format ${version}` }
      if (SvnWcDb.pendingWork(db)) return { ok: false, detail: 'work queue or lock' }
      const wcRoot = db.prepare('SELECT id FROM WCROOT WHERE local_abspath IS NULL').get() as { id: number } | undefined
      if (wcRoot === undefined) return { ok: false, detail: 'no working copy root row' }
      return { ok: true, value: use(new SvnWcDb(db, wcRoot.id)) }
    }
    catch (error) { return { ok: false, detail: SvnWcDb.detailOf(error) } }
    finally { try { db?.close() } catch { /* already closed */ } }
  }

  /** Every NODES layer of `relpath`, the highest `op_depth` first. */
  nodes(relpath: string): SvnWcDbNode[] {
    return (this.nodesOf.all(this.wcId, relpath) as Record<string, unknown>[]).map((row) => ({
      opDepth: row['op_depth'] as number,
      presence: row['presence'] as string,
      kind: row['kind'] as string,
      movedTo: (row['moved_to'] as string | null) ?? null,
      movedHere: row['moved_here'] === 1,
      properties: (row['properties'] as Uint8Array | null) ?? null,
      checksum: (row['checksum'] as string | null) ?? null,
      translatedSize: (row['translated_size'] as number | null) ?? null,
      lastModTime: (row['last_mod_time'] as number | null) ?? null,
      changedDate: (row['changed_date'] as number | null) ?? null,
    }))
  }

  actual(relpath: string): SvnWcDbActual | null {
    const row = this.actualOf.get(this.wcId, relpath) as { properties: Uint8Array | null; conflict: number } | undefined
    return row === undefined ? null : { properties: row.properties ?? null, conflict: row.conflict === 1 }
  }

  /** Whether `relpath` is where an `svn:externals` definition of this working copy mounts another one. */
  external(relpath: string): boolean {
    return this.externalAt.get(this.wcId, relpath) !== undefined
  }

  /** The properties the working-copy root inherited from the repository above it. */
  rootInheritedProperties(): Uint8Array | null {
    const row = this.inherited.get(this.wcId) as { inherited_props: Uint8Array | null } | undefined
    return row?.inherited_props ?? null
  }

  /** The stored spelling of `relpath` among the children of `parentRelpath`, compared without case; null when no node has it. */
  caseOf(parentRelpath: string, relpath: string): string | null {
    const row = this.caseInParent.get(this.wcId, parentRelpath, relpath) as { local_relpath: string } | undefined
    return row?.local_relpath ?? null
  }

  private static pendingWork(db: DatabaseSync): boolean {
    const row = db.prepare('SELECT EXISTS (SELECT 1 FROM WORK_QUEUE) AS queued, EXISTS (SELECT 1 FROM WC_LOCK) AS locked').get() as
      { queued: number; locked: number }
    return row.queued === 1 || row.locked === 1
  }

  private static detailOf(error: unknown): string {
    const code = typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number'
      ? error.errcode
      : null
    if (code !== null && (code & 0xff) === SvnWcDb.busyConst) return 'busy'
    if (code === SvnWcDb.readonlyRollbackConst) return 'busy'
    return error instanceof Error ? error.message : String(error)
  }
}
