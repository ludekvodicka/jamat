import { resolve } from 'node:path'
import { PathPresence } from '../../shared/pathPresence'
import { PathCompare } from '../../shared/pathCompare'
import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { SessionRecordsStore } from '../../sessionManager/worktreeSessionRecords'
import type { WorktreeReviewSnapshot } from '../worktreeState'

export class VerifyStep {
  private readonly records: SessionRecordsStore
  private readonly svn: Pick<SvnWorktreeManager, 'advancePublished' | 'commitHashes' | 'publicationHashes' | 'publicationRows'>

  constructor(records: SessionRecordsStore, svn: VerifyStep['svn']) { this.records = records; this.svn = svn }

  /**
   * A commit whose client died before it recorded the result leaves its nodes at the old BASE, the
   * published bytes standing as local changes (UA1-J09-2). Each node whose bytes and properties equal
   * the review and the published revision both takes that revision, as the finished commit would have
   * given it; any other node stays as it is, for `run` to name.
   */
  async advance(root: string, revision: number, review: WorktreeReviewSnapshot): Promise<void> {
    const rows = await this.svn.publicationRows(root, review.selection, revision)
    if (!rows.ok) throw new Error(rows.detail)
    const behind = review.selection.filter((path) => {
      const status = rows.value.items.find((row) => row.path === path)
      if (status === undefined || status.base >= revision || !rows.value.changed.some((row) => row.path === path)) return false
      return !review.deletions?.includes(path) || status.item === 'deleted'
    })
    if (behind.length === 0) return
    const kept = behind.filter((path) => !review.deletions?.includes(path))
    const local = await this.svn.commitHashes(root, kept, 'node')
    if (!local.ok) throw new Error(local.detail)
    const published = await this.svn.publicationHashes(root, kept, revision)
    if (!published.ok) throw new Error(published.detail)
    const same = behind.filter((path) => review.deletions?.includes(path)
      ? rows.value.changed.some((row) => row.path === path && row.action === 'D')
      : local.value[path] === review.hashes[path] && published.value[path] === review.hashes[path])
    if (same.length === 0) return
    const advanced = await this.svn.advancePublished(root, same, revision)
    if (!advanced.ok) throw new Error(advanced.detail)
  }

  async run(sessionId: string, root: string, revision: number, review: WorktreeReviewSnapshot, next: 'verifying' | 'disposing'): Promise<{ verified: boolean; differences: string[] }> {
    const rows = await this.svn.publicationRows(root, review.selection, revision)
    if (!rows.ok) throw new Error(rows.detail)
    const differences: string[] = []
    const existing: string[] = []
    const retainedDeletions: string[] = []
    const missing = await PathPresence.missing(root, review.selection)
    for (const path of review.selection) {
      const absolute = resolve(root, path)
      if (!PathCompare.isInside(root, absolute)) throw new Error(`Verification path leaves the worktree: ${path}`)
      const absent = missing.has(path)
      const changed = rows.value.changed.find((row) => row.path === path)
      const status = rows.value.items.find((row) => row.path === path)
      if (review.deletions?.includes(path)) {
        if (changed?.action !== 'D' || status !== undefined && !['none', 'unversioned', 'ignored'].includes(status.item)) differences.push(path)
        if (!absent) retainedDeletions.push(path)
        continue
      }
      if (absent || changed === undefined || status?.item !== 'normal' || status.props !== 'none' && status.props !== 'normal'
        || status.base !== revision || status.changed !== revision) differences.push(path)
      if (!absent) existing.push(path)
    }
    const hashes = await this.svn.commitHashes(root, existing, 'node')
    if (!hashes.ok) throw new Error(hashes.detail)
    differences.push(...existing.filter((path) => hashes.value[path] !== review.hashes[path]))
    const leftovers = await this.svn.commitHashes(root, retainedDeletions, 'node')
    if (!leftovers.ok) throw new Error(leftovers.detail)
    differences.push(...retainedDeletions.filter((path) => leftovers.value[path] !== review.hashes[path]))
    const published = await this.svn.publicationHashes(root, existing, revision)
    if (!published.ok) throw new Error(published.detail)
    differences.push(...existing.filter((path) => published.value[path] !== review.hashes[path]))
    const unique = [...new Set(differences)]
    if (!await this.records.update(sessionId, (record) => {
      const state = record.worktreeLifecycle
      if (state === undefined) return null
      const bounds = state.execution?.roots?.find((candidate) => PathCompare.comparable(candidate.path) === PathCompare.comparable(root))?.bounds
      return { ...record, worktreeLifecycle: { ...state, version: state.version + 1, differences: unique,
        phase: unique.length === 0 ? 'finishing' : 'waiting', step: unique.length === 0 ? next : 'verifying',
        wait: unique.length === 0 ? undefined : { kind: 'published-with-differences', at: Date.now(), reason: `Published r${revision} with differences: ${unique.join(', ')}` },
        verified: [...(state.verified ?? []).filter((row) => row.root !== root || row.revision !== revision || row.repository !== bounds?.repository || row.base !== bounds?.base),
          { root, revision, ...bounds === undefined ? {} : { repository: bounds.repository, base: bounds.base },
            paths: review.selection.filter((path) => !unique.includes(path)), at: Date.now() }] } }
    })) throw new Error('Publication verification could not be saved')
    return { verified: unique.length === 0, differences: unique }
  }
}
