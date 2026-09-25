import type { TreeResult } from './sessionsTreeModel'

/**
 * What each section of the panel drew last time, so the next build can hand back the same node
 * objects for rows that have not moved.
 *
 * One cursor per section and never one for the panel: the same project node is in the sessions tree
 * and in the tabs tree under one id, so a shared cursor would compare each tree's row against the
 * other's and hand back the node from the wrong one.
 *
 * This was two `useRef` records with every key written out, which stopped working on 2026-09-22 when
 * the groups became something a person adds to: a record listing six group names cannot be
 * initialized for a section that did not exist when the file was written. A miss is not a failure -
 * it is a section drawing for the first time, which is exactly the case where there is nothing to
 * compare against.
 */
export class SessionsTreeCursors {
  private readonly local = new Map<string, TreeResult>()
  private readonly remote = new Map<string, ReadonlyMap<string, TreeResult>>()

  localOf(key: string): TreeResult | null {
    return this.local.get(key) ?? null
  }

  remoteOf(key: string): ReadonlyMap<string, TreeResult> {
    return this.remote.get(key) ?? SessionsTreeCursors.emptyRemoteConst
  }

  record(key: string, tree: TreeResult, remote: ReadonlyMap<string, TreeResult> | null): void {
    this.local.set(key, tree)
    if (remote !== null) this.remote.set(key, remote)
  }

  /**
   * The remote half alone, which one view needs: with sessions and tabs drawn apart there are two
   * local trees and still one set of remote sections, because the remote builder takes no content.
   */
  recordRemote(key: string, remote: ReadonlyMap<string, TreeResult>): void {
    this.remote.set(key, remote)
  }

  /**
   * Shared rather than made per miss, and the reason is identity: the remote builder compares what
   * it is handed against what it produced, and a new empty map each time is a new object each time.
   */
  private static readonly emptyRemoteConst: ReadonlyMap<string, TreeResult> = new Map()
}
