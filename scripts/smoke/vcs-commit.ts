import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { VcsStatusView } from '../../lib-orchestrator/fileChangesManager/vcsStatusView.js'
import { VersioningCommitManager } from '../../app-client-ui/app/versioning/versioningCommitManager.js'
import { VersioningCommitMessageStore } from '../../app-client-ui/app/versioning/versioningCommitMessageStore.js'
import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import { GitCommitManager } from '../../lib-orchestrator/git/gitCommitManager.js'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker.js'
import { CommandInvoker } from '../../lib-orchestrator/shared/commandInvoker.js'
import type { CommitProgress } from '../../lib-orchestrator/shared/commitProgress.types.js'
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
    await this.checkSvnExternalBatch(message)
    await this.checkSvnUpdate(message)
    await this.checkExplicitScopes(message)
    await this.checkSvnKeptLocalDeletion(message)
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

  /**
   * `svn delete --keep-local` is how a runtime directory stops being versioned: the removal is
   * published and the files stay on disk, where they come back as untracked rows INSIDE the deleted
   * directory. Staging one of them runs `svn add --parents`, which REPLACES that directory and
   * publishes the whole tree again under a review that says it deletes it. Every eligible row is
   * checked by default, so that reversal was one confirmation away, and applications_web r2994 is
   * the revision where it happened.
   */
  private async checkSvnKeptLocalDeletion(message: string): Promise<void> {
    const repository = join(this.root, 'kept-repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: this.root, env: process.env })
    if (created.failure !== null || created.code !== 0) throw new Error(created.stderr)
    const working = join(this.root, 'kept-working')
    await this.svnRun(this.root, ['checkout', pathToFileURL(repository).href, working])
    const data = join(working, 'data')
    await mkdir(join(data, 'records'), { recursive: true })
    await writeFile(join(data, 'records', 'published.json'), 'published\n')
    await writeFile(join(working, 'keep.txt'), 'base\n')
    await this.svnRun(working, ['add', '--', 'data', 'keep.txt'])
    await this.svnRun(working, ['commit', '--file', message])
    // What the application wrote after that commit: never versioned, and below the deleted root.
    await mkdir(join(data, 'records', 'fresh'), { recursive: true })
    await writeFile(join(data, 'records', 'fresh', 'run.json'), 'local\n')
    await this.svnRun(working, ['delete', '--keep-local', '--', `${data}@`])
    const manager = new VersioningCommitManager({
      messages: new VersioningCommitMessageStore(join(this.root, 'kept-messages.json'), (detail) => console.error(detail)),
      sessions: { workingContext: async () => ({ ok: true, value: { sessionId: 'kept', cwd: working, agent: null, worktree: null } }), settleVcs: () => {} },
      vcsStatus: new VcsStatusView(), checkpointStore: { worktreeBelongsToStore: async () => false },
      fileAccess: (_owner, snapshot, file) => this.files.fileAccess(snapshot, file),
      snapshotOf: (_owner, snapshot) => this.files.workingSnapshot(snapshot),
      git: this.commits, svn: this.svnCommits,
      tortoise: { open: async () => { throw new Error('Unexpected Tortoise fallback') } }, onChanged: () => {},
    })
    const prepared = await manager.prepare('kept', 'svn', null, null, [data])
    if (!prepared.ok) throw new Error(prepared.detail)
    manager.attach(prepared.value.draftId, 'owner')
    const read = await this.files.workingTree({ sessionId: 'kept', cwd: working, agent: null, worktree: null }, 'svn', true)
    if (!read.ok) throw new Error(read.detail)
    const snapshot = manager.files('owner', prepared.value.draftId, read.value)
    const deletion = snapshot.entries.filter((entry) => entry.status === 'deleted')
    this.check('A kept-local deletion is one deleted row beside the untracked files it leaves behind',
      deletion.length === 1 && deletion[0].path === data
      && snapshot.entries.some((entry) => entry.status === 'untracked'))
    const text = await readFile(message, 'utf8')
    const everything = await manager.run('owner', { draftId: prepared.value.draftId, snapshotId: snapshot.snapshotId,
      fileIds: snapshot.entries.map((entry) => entry.fileId), message: text })
    this.check('No selection turns a kept-local deletion into a replacement',
      !everything.ok && everything.code === 'invalid-target')
    const result = await manager.run('owner', { draftId: prepared.value.draftId, snapshotId: snapshot.snapshotId,
      fileIds: deletion.map((entry) => entry.fileId), message: text })
    if (!result.ok) throw new Error(result.detail)
    this.check('The review publishes the deletion alone and leaves every file unversioned on disk',
      !(await this.svnRun(this.root, ['list', pathToFileURL(repository).href])).includes('data')
      && await readFile(join(data, 'records', 'published.json'), 'utf8') === 'published\n'
      && await readFile(join(data, 'records', 'fresh', 'run.json'), 'utf8') === 'local\n'
      && (await this.svnRun(working, ['status', '--', `${data}@`])).trim().startsWith('?'))
    manager.release(prepared.value.draftId, 'owner')
  }

  private async checkExplicitScopes(message: string): Promise<void> {
    const repository = join(this.root, 'selection-repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: this.root, env: process.env })
    if (created.failure !== null || created.code !== 0) throw new Error(created.stderr)
    const working = join(this.root, 'selection-working')
    const origin = join(this.root, 'session-origin')
    await mkdir(origin)
    await this.svnRun(this.root, ['checkout', pathToFileURL(repository).href, working])
    for (const name of ['selected@file.txt', 'deleted.txt', 'unchecked.txt']) await writeFile(join(working, name), 'base\n')
    for (const project of ['ProjectOne', 'ProjectTwo', 'ProjectThree', 'ProjectFour']) {
      await mkdir(join(working, project))
      await writeFile(join(working, project, 'Dockerfile'), 'FROM base\n')
      await writeFile(join(working, project, 'unselected.txt'), 'base\n')
    }
    await this.svnRun(working, ['add', '--', 'selected@file.txt@', 'deleted.txt', 'unchecked.txt', 'ProjectOne', 'ProjectTwo', 'ProjectThree', 'ProjectFour'])
    await this.svnRun(working, ['commit', '--file', message])
    const selected = join(working, 'selected@file.txt')
    await writeFile(selected, 'selected edit\n')
    await writeFile(join(working, 'unchecked.txt'), 'unchecked edit\n')
    const manager = new VersioningCommitManager({
      messages: new VersioningCommitMessageStore(join(this.root, 'selection-messages.json'), (detail) => console.error(detail)),
      sessions: { workingContext: async () => ({ ok: true, value: { sessionId: 'selection', cwd: origin, agent: null, worktree: null } }), settleVcs: () => {} },
      vcsStatus: new VcsStatusView(), checkpointStore: { worktreeBelongsToStore: async () => false },
      fileAccess: (_owner, snapshot, file) => this.files.fileAccess(snapshot, file),
      snapshotOf: (_owner, snapshot) => this.files.workingSnapshot(snapshot),
      git: this.commits, svn: this.svnCommits,
      tortoise: { open: async () => { throw new Error('Unexpected Tortoise fallback') } }, onChanged: () => {},
    })
    const review = async (paths: readonly string[]): Promise<string> => {
      const prepared = await manager.prepare('selection', 'svn', null, null, paths)
      if (!prepared.ok) throw new Error(prepared.detail)
      manager.attach(prepared.value.draftId, 'owner')
      const read = await this.files.workingTree({ sessionId: 'selection', cwd: prepared.value.scopeRoot, agent: null, worktree: null }, 'svn', true)
      if (!read.ok) throw new Error(read.detail)
      const snapshot = manager.files('owner', prepared.value.draftId, read.value)
      this.check('Explicit file preview excludes the modified sibling', !snapshot.entries.some((entry) => entry.path === join(working, 'unchecked.txt')))
      for (const path of paths) {
        const single = await this.files.workingTree({ sessionId: 'selection', cwd: prepared.value.scopeRoot,
          agent: null, worktree: null }, 'svn', true, path)
        if (!single.ok) throw new Error(single.detail)
        if (single.value.entries.length !== 1) throw new Error(`Single-file snapshot for ${path}: ${JSON.stringify(single.value)}`)
        this.check('A single-file SVN snapshot preserves the selected state and opens its own diff',
          single.value.entries.length === 1 && single.value.entries[0].path === path
          && single.value.entries[0].status === snapshot.entries.find((entry) => entry.path === path)?.status
          && single.value.defaultBaseline !== null
          && (await this.files.diff({ snapshotId: single.value.snapshotId, fileId: single.value.entries[0].fileId,
            baselineId: single.value.defaultBaseline.baselineId })).ok)
      }
      const result = await manager.run('owner', { draftId: prepared.value.draftId, snapshotId: snapshot.snapshotId,
        fileIds: snapshot.entries.map((entry) => entry.fileId), message: await readFile(message, 'utf8') })
      if (!result.ok) throw new Error(result.detail)
      const revision = manager.status(prepared.value.draftId)?.revision
      if (revision === null || revision === undefined) throw new Error('The completed review has no revision')
      manager.release(prepared.value.draftId, 'owner')
      return revision
    }
    await review([selected])
    this.check('A single file commits outside its session directory', await this.svnRun(working, ['cat', '-r', 'BASE', 'selected@file.txt@']) === 'selected edit\n')
    const unchanged = await this.files.workingTree({ sessionId: 'selection', cwd: working, agent: null,
      worktree: null }, 'svn', true, selected)
    this.check('A single-file refresh drops committed files while siblings remain modified', unchanged.ok
      && unchanged.value.entries.length === 0 && (await this.svnRun(working, ['status', 'unchecked.txt'])).trim().startsWith('M'))
    const fresh = join(working, 'new', 'nested', 'selected.txt')
    await mkdir(join(working, 'new', 'nested'), { recursive: true })
    await writeFile(fresh, 'new selected\n')
    await writeFile(join(working, 'new', 'nested', 'unchecked.txt'), 'new unchecked\n')
    const deleted = join(working, 'deleted.txt')
    await rm(deleted)
    await review([fresh, deleted])
    this.check('Explicit new and deleted files commit with only the required new parents',
      await this.svnRun(working, ['cat', '-r', 'BASE', 'new/nested/selected.txt']) === 'new selected\n'
      && !(await this.svnRun(working, ['list'])).includes('deleted.txt')
      && (await this.svnRun(working, ['status', 'new/nested/unchecked.txt'])).trim().startsWith('?')
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'unchecked.txt']) === 'base\n')
    const batch = ['ProjectOne', 'ProjectTwo'].map((project) => join(working, project, 'Dockerfile'))
    for (const file of batch) await writeFile(file, 'FROM updated\n')
    await writeFile(join(working, 'ProjectTwo', 'unselected.txt'), 'unrelated work\n')
    const before = Number(await this.svnRun(working, ['info', '--show-item', 'revision', pathToFileURL(repository).href]))
    const revision = await review(batch)
    this.check('One native review commits exact files across projects in one SVN revision', Number(revision) === before + 1
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'ProjectOne/Dockerfile']) === 'FROM updated\n'
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'ProjectTwo/Dockerfile']) === 'FROM updated\n')
    this.check('A multi-project review preserves unselected changes in participating projects',
      await this.svnRun(working, ['cat', '-r', 'BASE', 'ProjectTwo/unselected.txt']) === 'base\n'
      && await readFile(join(working, 'ProjectTwo', 'unselected.txt'), 'utf8') === 'unrelated work\n')
    await rename(join(working, 'ProjectThree'), join(this.root, 'selection-original-project'))
    const standalone = join(this.root, 'selection-standalone-project')
    await this.svnRun(this.root, ['checkout', `${pathToFileURL(repository).href}/ProjectThree`, standalone])
    await rename(standalone, join(working, 'ProjectThree'))
    this.check('The nested fixture has its own SVN working copy',
      (await this.svnRun(working, ['info', '--show-item', 'wc-root', 'ProjectThree'])).trim().replaceAll('\\', '/')
        === join(working, 'ProjectThree').replaceAll('\\', '/'))
    const nestedBatch = ['ProjectOne', 'ProjectThree'].map((project) => join(working, project, 'Dockerfile'))
    for (const file of nestedBatch) await writeFile(file, 'FROM nested\n')
    const nestedBefore = Number(await this.svnRun(working, ['info', '--show-item', 'revision', pathToFileURL(repository).href]))
    const nestedRevision = await review(nestedBatch)
    this.check('One native review commits a nested standalone checkout in the same repository atomically',
      Number(nestedRevision) === nestedBefore + 1
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'ProjectOne/Dockerfile']) === 'FROM nested\n'
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'ProjectThree/Dockerfile']) === 'FROM nested\n')
    // How the group working copy holds a project it leaves to its own checkout: the node is excluded
    // and the project is checked out in its place. SVN status of the group never walks into it, and
    // the review committed the group's files and reported the project's as committed too (#28).
    await this.svnRun(working, ['update', '--set-depth', 'exclude', '--', 'ProjectFour'])
    await this.svnRun(this.root, ['checkout', `${pathToFileURL(repository).href}/ProjectFour`, join(working, 'ProjectFour')])
    const excludedBatch = [join(working, 'ProjectOne', 'Dockerfile'), join(working, 'ProjectFour', 'Dockerfile'),
      join(working, 'ProjectFour', 'added.txt')]
    for (const file of excludedBatch) await writeFile(file, 'FROM excluded\n')
    const excludedRevision = await review(excludedBatch)
    const excludedLog = await this.svnRun(working, ['log', '--verbose', '-r', excludedRevision, pathToFileURL(repository).href])
    this.check('One native review commits a project checked out over its excluded node in the same revision',
      ['/ProjectOne/Dockerfile', '/ProjectFour/Dockerfile', '/ProjectFour/added.txt'].every((path) => excludedLog.includes(path))
      && (await this.svnRun(join(working, 'ProjectFour'), ['status'])).trim() === '')
    const other = join(this.root, 'selection-other')
    await this.svnRun(this.root, ['checkout', pathToFileURL(repository).href, other])
    await writeFile(join(other, 'selected@file.txt'), 'remote selected\n')
    await writeFile(join(other, 'unchecked.txt'), 'remote unchecked\n')
    await this.svnRun(other, ['commit', '--file', message])
    const update = await this.svnCommits.update(working, [selected])
    this.check('A scoped update leaves sibling files at their original BASE', update.ok
      && await readFile(selected, 'utf8') === 'remote selected\n'
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'unchecked.txt']) === 'base\n')
  }

  private async checkSvnUpdate(message: string): Promise<void> {
    const repository = join(this.root, 'update-repository')
    const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: this.root, env: process.env })
    if (created.failure !== null || created.code !== 0) throw new Error(created.stderr)
    const root = join(this.root, 'update-working')
    const other = join(this.root, 'update-other')
    const scope = join(root, 'scope@name')
    await this.svnRun(this.root, ['checkout', pathToFileURL(repository).href, root])
    await mkdir(scope)
    await mkdir(join(root, 'sibling'))
    await writeFile(join(scope, 'local.txt'), 'before\n')
    await writeFile(join(scope, 'remote.txt'), 'before\n')
    await writeFile(join(root, 'sibling', 'file.txt'), 'before\n')
    await this.svnRun(root, ['add', '--', 'scope@name@', 'sibling'])
    await this.svnRun(root, ['propset', 'svn:externals', '^/sibling external', '--', 'scope@name@'])
    await this.svnRun(root, ['commit', '--file', message])
    await this.svnRun(root, ['update'])
    await this.svnRun(this.root, ['checkout', '--ignore-externals', pathToFileURL(repository).href, other])
    await this.svnRun(scope, ['propset', 'local-note', 'mine', '--', '.'])
    await writeFile(join(scope, 'local.txt'), 'mine\n')
    await this.svnRun(other, ['propset', 'remote-note', 'theirs', '--', 'scope@name@'])
    await writeFile(join(other, 'scope@name', 'remote.txt'), 'remote change\n')
    await writeFile(join(other, 'sibling', 'file.txt'), 'sibling change\n')
    await this.svnRun(other, ['commit', '--file', message])
    const rejected = await this.svnCommits.commit(scope, [
      { absolutePath: scope, nodeKind: 'directory', status: 'modified' },
      { absolutePath: join(scope, 'local.txt'), nodeKind: 'file', status: 'modified' },
    ], message)
    this.check('A real stale directory commit returns out-of-date', !rejected.ok && rejected.code === 'out-of-date')
    const updated = await this.svnCommits.update(scope)
    if (!updated.ok) throw new Error(updated.detail)
    this.check('Scoped update merges remote changes and preserves local edits',
      await readFile(join(scope, 'remote.txt'), 'utf8') === 'remote change\n' && await readFile(join(scope, 'local.txt'), 'utf8') === 'mine\n')
    this.check('Scoped update leaves sibling projects and externals unchanged',
      await readFile(join(root, 'sibling', 'file.txt'), 'utf8') === 'before\n' && await readFile(join(scope, 'external', 'file.txt'), 'utf8') === 'before\n')
    await this.svnRun(scope, ['changelist', 'review', '--', 'local.txt'])
    await writeFile(join(other, 'scope@name', 'local.txt'), 'theirs\n')
    await this.svnRun(other, ['propset', 'local-note', 'theirs', '--', 'scope@name@'])
    await this.svnRun(other, ['commit', '--file', message])
    const conflicted = await this.svnCommits.update(scope)
    this.check('Update reports text conflicts in changelists and directory property conflicts',
      !conflicted.ok && conflicted.detail.includes('local.txt') && conflicted.detail.includes('scope@name'))
    this.check('Update postpones conflict resolution for human review',
      (await this.svnRun(scope, ['status', '--xml', '--ignore-externals'])).includes('conflicted'))
  }

  private async checkSvnExternalBatch(message: string): Promise<void> {
    const mainRepository = join(this.root, 'batch-main-repository')
    const externalRepository = join(this.root, 'batch-external-repository')
    for (const repository of [mainRepository, externalRepository]) {
      const created = await new CommandInvoker().run({ command: 'svnadmin', args: ['create', repository], cwd: this.root, env: process.env })
      if (created.failure !== null || created.code !== 0) throw new Error(created.stderr)
    }
    const seed = join(this.root, 'batch-external-seed')
    const externalUrl = pathToFileURL(externalRepository).href
    await this.svnRun(this.root, ['checkout', externalUrl, seed])
    for (const name of ['a', 'b']) {
      await mkdir(join(seed, name))
      await writeFile(join(seed, name, 'file@name.txt'), `${name} base\n`)
    }
    await this.svnRun(seed, ['add', 'a', 'b'])
    await this.svnRun(seed, ['commit', '--file', message])
    const working = join(this.root, 'batch-main-working')
    const mainUrl = pathToFileURL(mainRepository).href
    await this.svnRun(this.root, ['checkout', mainUrl, working])
    const scope = join(working, 'project')
    await mkdir(scope)
    await writeFile(join(scope, 'main.txt'), 'main base\n')
    await writeFile(join(working, 'sibling.txt'), 'sibling base\n')
    await this.svnRun(working, ['add', 'project', 'sibling.txt'])
    await this.svnRun(scope, ['propset', 'svn:externals', `${externalUrl}/a a\n${externalUrl}/b b`, '.'])
    await this.svnRun(working, ['commit', '--file', message])
    await this.svnRun(working, ['update'])
    await writeFile(join(scope, 'main.txt'), 'main changed\n')
    await writeFile(join(working, 'sibling.txt'), 'sibling uncommitted\n')
    for (const name of ['a', 'b']) await writeFile(join(scope, name, 'file@name.txt'), `${name} changed\n`)
    await mkdir(join(scope, 'b', 'new'))
    await writeFile(join(scope, 'b', 'new', 'selected.txt'), 'selected new\n')
    await writeFile(join(scope, 'b', 'new', 'unchecked.txt'), 'unselected new\n')
    const preview = await this.files.workingTree({ sessionId: 'batch', cwd: scope, agent: null, worktree: null }, 'svn', true)
    if (!preview.ok) throw new Error(preview.detail)
    const snapshot = preview.value
    this.check('SVN batch preview includes both external groups', snapshot.externalRoots.length === 2)
    for (const name of ['a', 'b']) {
      const entry = snapshot.entries.find((item) => item.displayPath === `${name}/file@name.txt`)!
      const request = { snapshotId: snapshot.snapshotId, fileId: entry.fileId, baselineId: snapshot.defaultBaseline!.baselineId }
      const baseline = await this.files.readBaseline(request)
      const diff = await this.files.diff(request)
      this.check(`External ${name} reads its own BASE through the parent snapshot`,
        baseline.ok && baseline.kind === 'content' && baseline.content === `${name} base\n` && diff.ok)
      const single = await this.files.workingTree({ sessionId: 'batch', cwd: scope, agent: null, worktree: null }, 'svn', true, entry.path)
      if (!single.ok) throw new Error(single.detail)
      const singleBase = await this.files.readBaseline({ snapshotId: single.value.snapshotId,
        fileId: single.value.entries[0].fileId, baselineId: single.value.defaultBaseline!.baselineId })
      this.check(`A single-file read resolves external ${name} against its own SVN BASE`,
        single.value.entries.length === 1 && singleBase.ok && singleBase.kind === 'content' && singleBase.content === `${name} base\n`)
    }
    const manager = new VersioningCommitManager({
      messages: new VersioningCommitMessageStore(join(this.root, 'batch-messages.json'), (detail) => console.error(detail)),
      sessions: { workingContext: async () => ({ ok: true, value: { sessionId: 'batch', cwd: scope, agent: null, worktree: null } }), settleVcs: () => {} },
      vcsStatus: new VcsStatusView(), checkpointStore: { worktreeBelongsToStore: async () => false },
      fileAccess: (_owner, snapshotId, fileId) => this.files.fileAccess(snapshotId, fileId),
      snapshotOf: (_owner, snapshotId) => this.files.workingSnapshot(snapshotId),
      git: this.commits, svn: this.svnCommits, tortoise: { open: async () => { throw new Error('Unexpected Tortoise') } }, onChanged: () => {},
    })
    const draft = await manager.prepare('batch', 'svn', scope, null)
    if (!draft.ok) throw new Error(draft.detail)
    manager.attach(draft.value.draftId, 'owner')
    const selected = ['main.txt', 'a/file@name.txt', 'b/file@name.txt', 'b/new/selected.txt']
    const result = await manager.run('owner', { draftId: draft.value.draftId, snapshotId: snapshot.snapshotId,
      fileIds: snapshot.entries.filter((entry) => selected.includes(entry.displayPath)).map((entry) => entry.fileId),
      message: await readFile(message, 'utf8'), includeExternals: true })
    if (!result.ok) throw new Error(result.detail)
    this.check('One reviewed request commits main and external working copies', result.revision.split(', ').length === 3
      && await this.svnRun(scope, ['cat', '-r', 'BASE', 'main.txt']) === 'main changed\n'
      && await this.svnRun(scope, ['cat', '-r', 'BASE', 'a/file@name.txt@']) === 'a changed\n'
      && await this.svnRun(scope, ['cat', '-r', 'BASE', 'b/file@name.txt@']) === 'b changed\n')
    this.check('Batch includes required external parents but leaves unchecked children and sibling projects untouched',
      await this.svnRun(scope, ['cat', '-r', 'BASE', 'b/new/selected.txt']) === 'selected new\n'
      && (await this.svnRun(scope, ['status', 'b/new/unchecked.txt'])).trim().startsWith('?')
      && await this.svnRun(working, ['cat', '-r', 'BASE', 'sibling.txt']) === 'sibling base\n')
    this.check('Batch reuses the reviewed UTF-8 message in both repositories',
      (await this.svnRun(scope, ['log', '--xml', '-r', 'HEAD', mainUrl])).includes('Příliš')
      && (await this.svnRun(scope, ['log', '--xml', '-r', 'HEAD', externalUrl])).includes('Příliš'))
    manager.release(draft.value.draftId, 'owner')
    this.check('Batch UUID retains completion after the pane closes', manager.status(draft.value.draftId)?.state === 'committed')

    await this.svnRun(working, ['update'])
    await this.svnRun(scope, ['propset', 'svn:externals', `${externalUrl}/a a`, '.'])
    await this.svnRun(scope, ['propset', 'review-note', 'external properties', 'a'])
    await writeFile(join(scope, 'main.txt'), 'unchecked main edit\n')
    await writeFile(join(scope, 'a', 'file@name.txt'), 'unchecked external edit\n')
    const propertyPreview = await this.files.workingTree({ sessionId: 'batch', cwd: scope, agent: null, worktree: null }, 'svn', true)
    if (!propertyPreview.ok) throw new Error(propertyPreview.detail)
    const properties = propertyPreview.value.entries.filter((entry) => entry.nodeKind === 'directory' && entry.status === 'modified')
    this.check('Commit preview retains property-only changes on the scope and external root', properties.length === 2
      && properties.some((entry) => entry.path === scope) && properties.some((entry) => entry.path === join(scope, 'a')))
    const propertyDraft = await manager.prepare('batch', 'svn', scope, null)
    if (!propertyDraft.ok) throw new Error(propertyDraft.detail)
    manager.attach(propertyDraft.value.draftId, 'owner')
    const propertyCommit = await manager.run('owner', { draftId: propertyDraft.value.draftId,
      snapshotId: propertyPreview.value.snapshotId, fileIds: properties.map((entry) => entry.fileId),
      message: await readFile(message, 'utf8'), includeExternals: true })
    if (!propertyCommit.ok) throw new Error(propertyCommit.detail)
    this.check('Property-only selection commits svn:externals and external root properties', propertyCommit.revision.split(', ').length === 2
      && (await this.svnRun(scope, ['propget', 'svn:externals', '-r', 'BASE', '.'])).trim() === `${externalUrl}/a a`
      && (await this.svnRun(scope, ['propget', 'review-note', '-r', 'BASE', 'a'])).trim() === 'external properties')
    this.check('Directory property commits leave unchecked main and external files uncommitted',
      await this.svnRun(scope, ['cat', '-r', 'BASE', 'main.txt']) === 'main changed\n'
      && await this.svnRun(scope, ['cat', '-r', 'BASE', 'a/file@name.txt@']) === 'a changed\n'
      && await readFile(join(scope, 'main.txt'), 'utf8') === 'unchecked main edit\n'
      && await readFile(join(scope, 'a', 'file@name.txt'), 'utf8') === 'unchecked external edit\n')
    console.log(`Property-only fixture revisions: ${propertyCommit.revision}`)
    manager.release(propertyDraft.value.draftId, 'owner')

    await this.svnRun(scope, ['propset', 'svn:externals', `${externalUrl}/a a\n${externalUrl}/b b`, '.'])
    await this.svnRun(scope, ['propset', 'review-note', 'mixed external properties', 'a'])
    const mixedPreview = await this.files.workingTree({ sessionId: 'batch', cwd: scope, agent: null, worktree: null }, 'svn', true)
    if (!mixedPreview.ok) throw new Error(mixedPreview.detail)
    const mixedPaths = [scope, join(scope, 'main.txt'), join(scope, 'a'), join(scope, 'a', 'file@name.txt')]
    const mixedEntries = mixedPreview.value.entries.filter((entry) => mixedPaths.includes(entry.path))
    this.check('Mixed preview retains both property rows and both selected source files', mixedEntries.length === 4)
    const mixedDraft = await manager.prepare('batch', 'svn', scope, null)
    if (!mixedDraft.ok) throw new Error(mixedDraft.detail)
    manager.attach(mixedDraft.value.draftId, 'owner')
    const mixedCommit = await manager.run('owner', { draftId: mixedDraft.value.draftId,
      snapshotId: mixedPreview.value.snapshotId, fileIds: mixedEntries.map((entry) => entry.fileId),
      message: await readFile(message, 'utf8'), includeExternals: true })
    if (!mixedCommit.ok) throw new Error(mixedCommit.detail)
    this.check('Mixed selection publishes svn:externals in the main fixture repository',
      (await this.svnRun(scope, ['propget', 'svn:externals', '-r', 'HEAD', `${mainUrl}/project`])).replace(/\r\n/g, '\n').trim()
        === `${externalUrl}/a a\n${externalUrl}/b b`)
    this.check('Mixed selection publishes the external directory property',
      (await this.svnRun(scope, ['propget', 'review-note', '-r', 'HEAD', `${externalUrl}/a`])).trim() === 'mixed external properties')
    this.check('Mixed selection publishes properties and source together in each fixture repository',
      mixedCommit.revision.split(', ').length === 2
      && await this.svnRun(scope, ['cat', '-r', 'HEAD', `${mainUrl}/project/main.txt`]) === 'unchecked main edit\n'
      && await this.svnRun(scope, ['cat', '-r', 'HEAD', `${externalUrl}/a/file@name.txt@`]) === 'unchecked external edit\n'
      && await this.svnRun(scope, ['info', '--show-item', 'last-changed-revision', scope])
        === await this.svnRun(scope, ['info', '--show-item', 'last-changed-revision', join(scope, 'main.txt')])
      && await this.svnRun(scope, ['info', '--show-item', 'last-changed-revision', join(scope, 'a')])
        === await this.svnRun(scope, ['info', '--show-item', 'last-changed-revision', `${join(scope, 'a', 'file@name.txt')}@`]))
    this.check('Mixed selection still leaves unchecked new children and sibling changes unpublished',
      (await this.svnRun(scope, ['status', 'b/new/unchecked.txt'])).trim().startsWith('?')
      && await this.svnRun(working, ['cat', '-r', 'HEAD', `${mainUrl}/sibling.txt`]) === 'sibling base\n'
      && await readFile(join(working, 'sibling.txt'), 'utf8') === 'sibling uncommitted\n')
    console.log(`Mixed fixture revisions: ${mixedCommit.revision}`)
    manager.release(mixedDraft.value.draftId, 'owner')
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
    const single = await this.files.workingTree({ sessionId: 'git-selection', cwd: root, agent: null,
      worktree: null }, 'git', true, selected)
    if (!single.ok) throw new Error(single.detail)
    this.check('A single-file Git snapshot keeps literal brackets and excludes staged siblings',
      single.value.entries.length === 1 && single.value.entries[0].path === selected
      && single.value.defaultBaseline !== null
      && (await this.files.diff({ snapshotId: single.value.snapshotId, fileId: single.value.entries[0].fileId,
        baselineId: single.value.defaultBaseline.baselineId })).ok)
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
    const progress: CommitProgress[] = []
    const result = await this.svnCommits.commit(root, preview.value.entries.filter((entry) => selected.has(entry.displayPath))
      .map((entry) => ({ absolutePath: entry.path, nodeKind: entry.nodeKind, status: entry.status })), message, (value) => progress.push(value))
    if (!result.ok) throw new Error(result.detail)
    this.check('Real SVN output reports selected nodes and transmitted deltas before result verification',
      progress.some((value) => value.stage === 'sending' && value.completed === selected.size)
      && progress.some((value) => value.stage === 'transmitting' && value.completed === 2 && value.total === null)
      && progress.at(-1)?.stage === 'verifying')
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
    const ignored = await this.files.workingTree({ sessionId: 'smoke', cwd: root, agent: null, worktree: null },
      'svn', true, join(root, 'recursive', 'child', 'ignored.skip'))
    this.check('Single-file reads honor inherited ignores below unversioned SVN parents', ignored.ok && ignored.value.entries.length === 0)
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
