import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { PathCompare } from '../shared/pathCompare'
import type { CommitProgress } from '../shared/commitProgress.types'
import type { GitResult } from './git.types'
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
    const selected = [...new Set(paths.map((path) => `:(literal)${relative(root, resolve(actualScope, relative(scope, path))).replace(/\\/g, '/')}`))]
    const directory = await mkdtemp(join(tmpdir(), 'jamat-git-pathspec-'))
    try {
      const pathspecFile = join(directory, 'paths')
      await writeFile(pathspecFile, `${selected.join('\0')}\0`, { encoding: 'utf8', mode: 0o600 })
      const pathspecArgs = [`--pathspec-from-file=${pathspecFile}`, '--pathspec-file-nul']
      const added = await this.invoker.run(root, ['add', '-A', ...pathspecArgs])
      const addFailure = GitManager.failureOf(added, 'git-failed')
      if (addFailure) return addFailure
      onProgress?.({ stage: 'committing', completed: 0, total: null })
      const committed = await this.invoker.run(root, ['commit', '--only', '-F', messageFile, ...pathspecArgs])
      const failure = GitManager.failureOf(committed, 'git-failed')
      if (failure) return failure
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
