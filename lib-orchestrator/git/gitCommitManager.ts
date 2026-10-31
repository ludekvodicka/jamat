import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { PathCompare } from '../shared/pathCompare'
import type { CommitProgress } from '../shared/commitProgress.types'
import type { GitErrorCode, GitResult } from './git.types'
import { GitManager } from './gitManager'

export class GitCommitManager extends GitManager {
  async commit(scope: string, paths: readonly string[], messageFile: string,
    onProgress?: (progress: CommitProgress) => void): Promise<GitResult<{ hash: string; output: string }>> {
    if (paths.length === 0 || paths.some((path) => !PathCompare.isInside(scope, path) || /[\0\r\n]/.test(path)))
      return { ok: false, code: 'git-failed', detail: 'Select files inside the commit scope' }
    onProgress?.({ stage: 'preparing', completed: 0, total: null })
    const checked = await this.rootOf(scope)
    if (!checked.ok) return checked
    const { root, scope: actualScope } = checked.value
    const selected = [...new Set(paths.map((path) => relative(root, resolve(actualScope, relative(scope, path))).replace(/\\/g, '/')))]
    // `commit --only` takes each selected path from the working tree and keeps the rest of the index
    // as it is, but it knows only paths in HEAD or the index. A new file is therefore announced with
    // --intent-to-add, and nothing else is staged: `add -A` over the selection replaced a person's
    // partial staging, failed on a deletion that was already staged, and stayed in the index after a
    // refused commit.
    const listed = await this.invoker.run(actualScope, ['ls-files', '-z', '--others', '--exclude-standard', '--full-name'])
    const listFailure = GitManager.failureOf(listed, 'git-failed')
    if (listFailure) return listFailure
    const untracked = new Map(listed.stdout.split('\0').filter(Boolean).map((path) => [PathCompare.comparable(join(root, path)), path]))
    const added = selected.flatMap((path) => untracked.get(PathCompare.comparable(join(root, path))) ?? [])
    const directory = await mkdtemp(join(tmpdir(), 'jamat-git-pathspec-'))
    try {
      const pathspecArgs = await GitCommitManager.pathspecArgs(join(directory, 'paths'), selected)
      const addedArgs = added.length === 0 ? null : await GitCommitManager.pathspecArgs(join(directory, 'added'), added)
      if (addedArgs !== null) {
        const announced = await this.invoker.run(root, ['add', '--intent-to-add', ...addedArgs])
        const addFailure = GitManager.failureOf(announced, 'git-failed')
        // `add` refusing one path, an ignored one, still announces the others.
        if (addFailure) return await this.withdrawn(root, addedArgs, addFailure)
      }
      onProgress?.({ stage: 'committing', completed: 0, total: null })
      const committed = await this.invoker.run(root, ['commit', '--only', '-F', messageFile, ...pathspecArgs])
      const failure = GitManager.failureOf(committed, 'git-failed')
      // A refusing hook or Git leaves the real index as it was; only the announcement is undone. A
      // process that did not run to completion may still have committed, and withdrawing a committed
      // new file would stage its removal.
      if (failure) return addedArgs === null || committed.failure !== null ? failure : await this.withdrawn(root, addedArgs, failure)
      onProgress?.({ stage: 'verifying', completed: 0, total: null })
      const hash = await this.invoker.run(root, ['rev-parse', '--verify', 'HEAD'])
      const hashFailure = GitManager.failureOf(hash, 'git-failed')
      if (hashFailure) return hashFailure
      return { ok: true, value: { hash: hash.stdout.trim(), output: committed.stdout + committed.stderr } }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  async revertFile(scope: string, path: string): Promise<GitResult<void>> {
    if (!PathCompare.isInside(scope, path) || /[\0\r\n]/.test(path))
      return { ok: false, code: 'git-failed', detail: 'Select a file inside the commit scope' }
    const checked = await this.rootOf(scope)
    if (!checked.ok) return checked
    const { root, scope: actualScope } = checked.value
    const selected = relative(root, resolve(actualScope, relative(scope, path))).replace(/\\/g, '/')
    const object = await this.invoker.run(root, ['cat-file', '-t', `HEAD:${selected}`])
    const objectFailure = GitManager.failureOf(object, 'git-failed')
    if (objectFailure) return objectFailure
    if (object.stdout.trim() !== 'blob') return { ok: false, code: 'git-failed', detail: 'The selected path is not a versioned file in HEAD' }
    const reverted = await this.invoker.run(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', `:(literal)${selected}`])
    return GitManager.failureOf(reverted, 'git-failed') ?? { ok: true, value: undefined }
  }

  private static async pathspecArgs(file: string, paths: readonly string[]): Promise<string[]> {
    await writeFile(file, `${paths.map((path) => `:(literal)${path}`).join('\0')}\0`, { encoding: 'utf8', mode: 0o600 })
    return [`--pathspec-from-file=${file}`, '--pathspec-file-nul']
  }

  private async withdrawn(root: string, addedArgs: readonly string[],
    failure: { ok: false; code: GitErrorCode; detail: string }): Promise<{ ok: false; code: GitErrorCode; detail: string }> {
    const removed = await this.invoker.run(root, ['rm', '--cached', '--quiet', '--ignore-unmatch', ...addedArgs])
    const removeFailure = GitManager.failureOf(removed, 'git-failed')
    return removeFailure === null ? failure
      : { ...failure, detail: `${failure.detail}\n\nThe new files stay announced in the index (git add --intent-to-add): ${removeFailure.detail}` }
  }

  private async rootOf(scope: string): Promise<GitResult<{ root: string; scope: string }>> {
    const detected = await this.invoker.run(scope, ['rev-parse', '--show-toplevel'])
    const detectionFailure = GitManager.failureOf(detected, 'not-a-repo')
    if (detectionFailure) return detectionFailure
    const root = await realpath(resolve(detected.stdout.trim()))
    const actualScope = await realpath(scope)
    if (!PathCompare.isInside(root, actualScope))
      return { ok: false, code: 'not-a-repo', detail: 'The commit scope is outside the repository' }
    // Linked worktrees can belong to the AI store. This dialog accepts only a main human copy.
    const marker = await lstat(join(root, '.git')).catch(() => null)
    if (marker === null || !marker.isDirectory() || marker.isSymbolicLink())
      return { ok: false, code: 'git-failed', detail: 'Commit requires a main copy with its own .git directory' }
    if (await GitManager.exists(join(root, '.git', 'MERGE_HEAD')))
      return { ok: false, code: 'git-failed', detail: 'A merge is in progress; resolve or abort it first' }
    return { ok: true, value: { root, scope: actualScope } }
  }
}
