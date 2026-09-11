import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { GitCommitManager } from '../../lib-orchestrator/git/gitCommitManager.js'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import { SvnCommitManager } from '../../lib-orchestrator/svn/svnCommitManager.js'
import { SvnInvoker } from '../../lib-orchestrator/svn/svnInvoker.js'
import { SmokeHarness, SmokeRun } from './smokeHarness.js'

class SmokeVcsCommit extends SmokeHarness {
  private readonly git = new GitInvoker()
  private readonly svn = new SvnInvoker()
  private readonly commits = new GitCommitManager(this.git)
  private readonly svnCommits = new SvnCommitManager(this.svn)
  private readonly files = new FileChangesManager({ diffExecutor: new FileDiffComputer() })

  private constructor(private readonly root: string) { super() }

  static async run(): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'jamat-v3-commit-smoke-')))
    try { await new SmokeVcsCommit(root).execute() }
    finally { await rm(root, { recursive: true, force: true }) }
  }

  private async execute(): Promise<void> {
    const message = join(this.root, 'message.txt')
    await writeFile(message, 'Commit selected files\n\nPříliš žluťoučký kůň\n', 'utf8')
    await this.checkGit(message)
    await this.checkSvn(message)
    console.log(`\nsmoke-vcs-commit: ${this.passed} checks passed`)
  }

  private async gitRun(root: string, args: string[]): Promise<string> {
    const result = await this.git.run(root, args)
    if (result.failure !== null || result.code !== 0) throw new Error(result.stderr || JSON.stringify(result))
    return result.stdout
  }

  private async svnRun(root: string, args: string[]): Promise<string> {
    const result = await this.svn.run(root, args)
    if (result.failure !== null || result.code !== 0) throw new Error(result.stderr || JSON.stringify(result))
    return result.stdout
  }

  private async checkGit(message: string): Promise<void> {
    const root = join(this.root, 'git')
    await mkdir(root)
    await this.gitRun(root, ['init'])
    const selected = join(root, 'chosen [file].txt')
    const other = join(root, 'other.txt')
    await writeFile(selected, 'before\n')
    await writeFile(other, 'other before\n')
    const seeded = await this.commits.commit(root, [selected, other], message)
    if (!seeded.ok) throw new Error(seeded.detail)
    await writeFile(selected, 'after\n')
    await writeFile(other, 'staged unrelated\n')
    await this.gitRun(root, ['add', '--', 'other.txt'])
    const committed = await this.commits.commit(root, [selected], message)
    if (!committed.ok) throw new Error(committed.detail)
    this.check('Git commits only selected literal paths', (await this.gitRun(root, ['show', 'HEAD:chosen [file].txt'])) === 'after\n')
    this.check('Git leaves unrelated HEAD and index content unchanged',
      (await this.gitRun(root, ['show', 'HEAD:other.txt'])) === 'other before\n'
      && (await this.gitRun(root, ['show', ':other.txt'])) === 'staged unrelated\n')
    this.check('Git uses the configured human author',
      (await this.gitRun(root, ['log', '-1', '--format=%an'])).trim() === (await this.gitRun(root, ['config', '--global', 'user.name'])).trim())
    this.check('Git preserves a multiline UTF-8 message', (await this.gitRun(root, ['log', '-1', '--format=%B'])).includes('Příliš žluťoučký kůň'))
    await writeFile(selected, 'staged change\n')
    await this.gitRun(root, ['add', '--', ':(literal)chosen [file].txt'])
    await writeFile(selected, 'unstaged change\n')
    const reverted = await this.commits.revertFile(root, selected)
    if (!reverted.ok) throw new Error(reverted.detail)
    this.check('Git revert restores a literal file and its index to HEAD',
      (await readFile(selected, 'utf8')).replace(/\r\n/g, '\n') === 'after\n' && await this.gitRun(root, ['show', ':chosen [file].txt']) === 'after\n')
    this.check('Git revert preserves unrelated staged and working changes',
      await readFile(other, 'utf8') === 'staged unrelated\n' && await this.gitRun(root, ['show', ':other.txt']) === 'staged unrelated\n')
    await this.gitRun(root, ['rm', '--', ':(literal)chosen [file].txt'])
    const restored = await this.commits.revertFile(root, selected)
    if (!restored.ok) throw new Error(restored.detail)
    this.check('Git revert restores a deleted file', (await readFile(selected, 'utf8')).replace(/\r\n/g, '\n') === 'after\n')
  }

  private async checkSvn(message: string): Promise<void> {
    const repository = join(this.root, 'svn-repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: this.root, env: process.env })
    if (created.failure !== null || created.code !== 0) throw new Error(created.stderr)
    const root = join(this.root, 'svn-working')
    await this.svnRun(this.root, ['checkout', pathToFileURL(repository).href, root])
    await this.gitRun(root, ['init'])
    await writeFile(join(root, '.gitignore'), 'node_modules/\n.git/\n')
    await mkdir(join(root, 'deleted'))
    await writeFile(join(root, 'deleted', 'old.txt'), 'old\n')
    await writeFile(join(root, 'modified.txt'), 'before\n')
    await writeFile(join(root, 'untouched.txt'), 'before\n')
    for (const path of ['deleted', 'modified.txt', 'untouched.txt']) await this.svnRun(root, ['add', '--', path])
    await this.svnRun(root, ['commit', '--file', message, '--', 'deleted', 'modified.txt', 'untouched.txt'])
    await mkdir(join(root, 'new', 'nested'), { recursive: true })
    await mkdir(join(root, 'new', 'node_modules'), { recursive: true })
    await writeFile(join(root, 'new', 'nested', 'file@name.txt'), 'new\n')
    await writeFile(join(root, 'new', 'nested', 'unchecked.txt'), 'unchecked\n')
    await writeFile(join(root, 'new', 'node_modules', 'x.js'), 'ignored\n')
    await writeFile(join(root, 'modified.txt'), 'after\n')
    await writeFile(join(root, 'untouched.txt'), 'unselected\n')
    await this.svnRun(root, ['delete', '--', 'deleted'])
    const preview = await this.files.workingTree({ sessionId: 'smoke', cwd: root, agent: null, worktree: null }, 'svn', true)
    if (!preview.ok) throw new Error(preview.detail)
    const newFile = preview.value.entries.find((entry) => entry.displayPath === 'new/nested/file@name.txt')!
    this.check('SVN preview expands untracked children and excludes Git-ignored content', newFile !== undefined
      && preview.value.entries.some((entry) => entry.displayPath === 'new/nested/unchecked.txt')
      && !preview.value.entries.some((entry) => entry.displayPath.includes('node_modules')))
    const diff = await this.files.diff({ snapshotId: preview.value.snapshotId, fileId: newFile.fileId, baselineId: preview.value.defaultBaseline!.baselineId })
    this.check('An untracked child opens as a new-file diff before any SVN add', diff.ok && diff.kind === 'text')
    const selected = new Set(['modified.txt', 'new', 'new/nested', 'new/nested/file@name.txt', 'deleted'])
    const result = await this.svnCommits.commit(root, preview.value.entries.filter((entry) => selected.has(entry.displayPath))
      .map((entry) => ({ absolutePath: entry.path, nodeKind: entry.nodeKind, status: entry.status })), message)
    if (!result.ok) throw new Error(result.detail)
    const listing = await this.svnRun(root, ['list', '--recursive', pathToFileURL(repository).href])
    this.check('SVN adds Git-listed files and their parents, including literal @ paths', listing.includes('new/nested/file@name.txt'))
    this.check('SVN excludes ignored node_modules', !listing.includes('node_modules'))
    this.check('SVN excludes unchecked new children even with their parent selected', !listing.includes('unchecked.txt')
      && (await this.svnRun(root, ['status', '--', 'new/nested/unchecked.txt'])).trim().startsWith('?'))
    this.check('SVN commits directory deletion at depth empty', !listing.includes('deleted'))
    this.check('SVN leaves an unchecked modified file untouched', (await this.svnRun(root, ['cat', '-r', 'BASE', 'untouched.txt'])) === 'before\n')
    this.check('SVN preserves a multiline UTF-8 message', (await this.svnRun(root, ['log', '--xml', '-r', 'HEAD'])).includes('Příliš žluťoučký kůň'))
    await rm(join(root, '.git'), { recursive: true, force: true })
    await mkdir(join(root, 'recursive', 'child'), { recursive: true })
    await writeFile(join(root, 'recursive', 'child', 'plain.txt'), 'recursive\n')
    await writeFile(join(root, 'recursive', 'child', 'unchecked.txt'), 'unchecked\n')
    await writeFile(join(root, 'recursive', 'child', 'ignored.skip'), 'ignored\n')
    await this.svnRun(root, ['propset', 'svn:global-ignores', '*.skip', '--', '.'])
    const noGit = await this.files.workingTree({ sessionId: 'smoke', cwd: root, agent: null, worktree: null }, 'svn', true)
    if (!noGit.ok) throw new Error(noGit.detail)
    this.check('SVN preview without Git lists individual children and honors SVN ignores',
      noGit.value.entries.some((entry) => entry.displayPath === 'recursive/child/plain.txt')
      && noGit.value.entries.some((entry) => entry.displayPath === 'recursive/child/unchecked.txt')
      && !noGit.value.entries.some((entry) => entry.displayPath.endsWith('ignored.skip')))
    const recursive = await this.svnCommits.commit(root, noGit.value.entries
      .filter((entry) => ['recursive', 'recursive/child', 'recursive/child/plain.txt'].includes(entry.displayPath))
      .map((entry) => ({ absolutePath: entry.path, nodeKind: entry.nodeKind, status: entry.status })), message)
    if (!recursive.ok) throw new Error(recursive.detail)
    const noGitListing = await this.svnRun(root, ['list', '--recursive', pathToFileURL(repository).href])
    this.check('SVN commits selected new nodes outside Git and leaves unchecked children unversioned',
      noGitListing.includes('recursive/child/plain.txt') && !noGitListing.includes('recursive/child/unchecked.txt'))
    this.check('The message file remains owned by the caller', (await readFile(message, 'utf8')).includes('Příliš'))
    const path = join(root, 'new', 'nested', 'file@name.txt')
    await writeFile(path, 'edited\n')
    await this.svnRun(root, ['propset', 'review-test', 'changed', '--', `${path}@`])
    const reverted = await this.svnCommits.revertFile(root, path)
    if (!reverted.ok) throw new Error(reverted.detail)
    this.check('SVN revert restores literal @ content and properties',
      await readFile(path, 'utf8') === 'new\n' && (await this.svnRun(root, ['status', '--', `${path}@`])).trim() === '')
    this.check('SVN revert preserves unselected changes', await readFile(join(root, 'untouched.txt'), 'utf8') === 'unselected\n')
    await this.svnRun(root, ['delete', '--', `${path}@`])
    const restored = await this.svnCommits.revertFile(root, path)
    if (!restored.ok) throw new Error(restored.detail)
    this.check('SVN revert restores a deleted file', await readFile(path, 'utf8') === 'new\n')
  }
}

void SmokeVcsCommit.run().catch((error) => SmokeRun.failed('smoke-vcs-commit', error))
