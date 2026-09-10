import { lstat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { PathCompare } from '../shared/pathCompare'
import type { GitResult } from './git.types'
import { GitManager } from './gitManager'

export class GitCommitManager extends GitManager {
  async commit(scope: string, paths: readonly string[], messageFile: string): Promise<GitResult<{ hash: string; output: string }>> {
    if (paths.length === 0 || paths.some((path) => !PathCompare.isInside(scope, path) || /[\0\r\n]/.test(path)))
      return { ok: false, code: 'git-failed', detail: 'Select files inside the commit scope' }
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
}
