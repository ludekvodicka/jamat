import { readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { ErrnoCode } from '../shared/errnoCode'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { CheckpointLayout } from './checkpointLayout'
import { GitManager } from './gitManager'
import type { GitResult, WorktreeFacts } from './git.types'

/**
 * The worktrees `checkpoints` mode cut from the checkpoint store before that was retired: recognized
 * from disk, offered Keep and Discard only, and never landed. Dormant code with a retire trigger
 * (`docs/architecture/lib-orchestrator.md`, **Dormant code**).
 *
 * The discard is a person's Finish choice over work they abandon, so it deletes the branch with
 * `-D` beside the merge manager's own forced teardown.
 */
export class StoreCutWorktrees extends GitManager {
  private static readonly asideSuffixConst = '.deleting'

  /** The store a worktree's `.git` pointer names, or null for any other directory. */
  async recognize(worktreePath: string): Promise<{ storeDir: string } | null> {
    let body: string
    try { body = await readFile(join(worktreePath, '.git'), 'utf8') } catch { return null }
    const pointer = body.split(/\r?\n/).find((line) => line.startsWith('gitdir:'))?.slice('gitdir:'.length).trim()
    if (!pointer) return null
    const normalized = PathCompare.normalized(isAbsolute(pointer) ? pointer : resolve(worktreePath, pointer))
    const marker = `/${CheckpointLayout.storeRelativeConst}`
    const at = normalized.toLowerCase().lastIndexOf(marker.toLowerCase())
    if (at < 0) return null
    const after = normalized[at + marker.length]
    if (after !== undefined && after !== '/') return null
    return { storeDir: resolve(normalized.slice(0, at + marker.length)) }
  }

  /**
   * The worktree is renamed aside first, so a directory something still holds stays whole and the
   * refusal says so; then the aside is purged, the store forgets the worktree and its branch goes.
   * Every step tolerates what an earlier attempt already did.
   */
  async discard(worktree: WorktreeFacts): Promise<GitResult<void>> {
    const storeDir = join(worktree.repositoryRoot, CheckpointLayout.storeRelativeConst)
    const aside = `${worktree.worktreePath}${StoreCutWorktrees.asideSuffixConst}`
    for (const path of [aside, worktree.worktreePath]) {
      if (!await GitManager.exists(path)) continue
      const named = await this.recognize(path)
      if (named === null || PathCompare.comparable(named.storeDir) !== PathCompare.comparable(storeDir))
        return { ok: false, code: 'git-failed', detail: `${path} is not the worktree ${storeDir} cut; it was left alone` }
    }
    if (await GitManager.exists(worktree.worktreePath)) {
      await rm(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      try { await rename(worktree.worktreePath, aside) }
      catch (error) {
        const code = ErrnoCode.of(error)
        if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')
          return { ok: false, code: 'locked', detail: `${worktree.worktreePath} is in use; close what holds it and Discard again` }
        return { ok: false, code: 'git-failed', detail: `Cannot move ${worktree.worktreePath} aside: ${ErrorText.of(error)}` }
      }
    }
    try { await rm(aside, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
    catch (error) { return { ok: false, code: 'git-failed', detail: `Cannot remove ${aside}: ${ErrorText.of(error)}` } }
    const pruned = await this.invoker.run(worktree.repositoryRoot, ['--git-dir', storeDir, 'worktree', 'prune'])
    const pruneFailure = GitManager.failureOf(pruned, 'git-failed')
    if (pruneFailure) return pruneFailure
    const deleted = await this.invoker.run(
      worktree.repositoryRoot,
      ['--git-dir', storeDir, 'branch', '-D', '--end-of-options', worktree.branch],
    )
    if (!deleted.failure && deleted.code !== 0 && /branch .*not found/i.test(`${deleted.stderr}\n${deleted.stdout}`))
      return { ok: true, value: undefined }
    const deleteFailure = GitManager.failureOf(deleted, 'git-failed')
    if (deleteFailure) return deleteFailure
    return { ok: true, value: undefined }
  }
}
