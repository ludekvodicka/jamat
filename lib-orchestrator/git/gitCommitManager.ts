import { lstat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { PathCompare } from '../shared/pathCompare'
import type { GitResult } from './git.types'
import { GitManager } from './gitManager'

export class GitCommitManager extends GitManager {
  async commit(scope: string, paths: readonly string[], messageFile: string): Promise<GitResult<{ hash: string; output: string }>> {
    if (paths.length === 0 || paths.some((path) => !PathCompare.isInside(scope, path) || /[\0\r\n]/.test(path)))
      return { ok: false, code: 'git-failed', detail: 'Select files inside the commit scope' }
    const checked = await this.rootOf(scope)
    if (!checked.ok) return checked
    const root = checked.value
    const selected = [...new Set(paths.map((path) => `:(literal)${relative(root, path).replace(/\\/g, '/')}`))]
    const added = await this.invoker.run(root, ['add', '-A', '--', ...selected])
    const addFailure = GitManager.failureOf(added, 'git-failed')
    if (addFailure) return addFailure
    const committed = await this.invoker.run(root, ['commit', '--only', '-F', messageFile, '--', ...selected])
    const failure = GitManager.failureOf(committed, 'git-failed')
    if (failure) return failure
    const hash = await this.invoker.run(root, ['rev-parse', '--verify', 'HEAD'])
    const hashFailure = GitManager.failureOf(hash, 'git-failed')
    if (hashFailure) return hashFailure
    return { ok: true, value: { hash: hash.stdout.trim(), output: committed.stdout + committed.stderr } }
  }

  async revertFile(scope: string, path: string): Promise<GitResult<void>> {
    if (!PathCompare.isInside(scope, path) || /[\0\r\n]/.test(path))
      return { ok: false, code: 'git-failed', detail: 'Select a file inside the commit scope' }
    const checked = await this.rootOf(scope)
    if (!checked.ok) return checked
    const root = checked.value
    const selected = relative(root, path).replace(/\\/g, '/')
    const object = await this.invoker.run(root, ['cat-file', '-t', `HEAD:${selected}`])
    const objectFailure = GitManager.failureOf(object, 'git-failed')
    if (objectFailure) return objectFailure
    if (object.stdout.trim() !== 'blob') return { ok: false, code: 'git-failed', detail: 'The selected path is not a versioned file in HEAD' }
    const reverted = await this.invoker.run(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', `:(literal)${selected}`])
    return GitManager.failureOf(reverted, 'git-failed') ?? { ok: true, value: undefined }
  }

  private async rootOf(scope: string): Promise<GitResult<string>> {
    const detected = await this.invoker.run(scope, ['rev-parse', '--show-toplevel'])
    const detectionFailure = GitManager.failureOf(detected, 'not-a-repo')
    if (detectionFailure) return detectionFailure
    const root = resolve(detected.stdout.trim())
    if (!PathCompare.isInside(root, scope))
      return { ok: false, code: 'not-a-repo', detail: 'The commit scope is outside the repository' }
    // Linked worktrees can belong to the AI store. This dialog accepts only a main human copy.
    const marker = await lstat(join(root, '.git')).catch(() => null)
    if (marker === null || !marker.isDirectory() || marker.isSymbolicLink())
      return { ok: false, code: 'git-failed', detail: 'Commit requires a main copy with its own .git directory' }
    if (await GitManager.exists(join(root, '.git', 'MERGE_HEAD')))
      return { ok: false, code: 'git-failed', detail: 'A merge is in progress; resolve or abort it first' }
    return { ok: true, value: root }
  }
}
