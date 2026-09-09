import { SmokeHarness, SmokeRun } from './smokeHarness.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FileChangesManager } from '../../lib-orchestrator/fileChangesManager/fileChangesManager.js'
import { FileDiffComputer } from '../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer.js'
import type {
  FileChangesSnapshot,
  FileChangesSnapshotResult,
  FileDiffData,
  FileDiffResult,
  FileChangesWorkingTreeSnapshot,
  FileChangesWorkingTreeSnapshotResult,
} from '../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types.js'
import { CheckpointLayout } from '../../lib-orchestrator/git/checkpointLayout.js'
import { GitCheckpointStore } from '../../lib-orchestrator/git/gitCheckpointStore.js'
import { GitInvoker } from '../../lib-orchestrator/git/gitInvoker.js'
import { GitWorktreeManager } from '../../lib-orchestrator/git/gitWorktreeManager.js'
import type { GitResult } from '../../lib-orchestrator/git/git.types.js'
import { ProviderTranscriptView } from '../../lib-orchestrator/projectManager/providerTranscriptView.js'
import { PathCompare } from '../../lib-orchestrator/shared/pathCompare.js'

class SmokeFileChanges extends SmokeHarness {
  private readonly gitRoot: string
  private readonly gitCwd: string
  private readonly svnRepository: string
  private readonly svnWorkingCopy: string
  private readonly codexHome: string
  private readonly claudeHome: string
  private readonly externalFile: string
  private readonly codexSessionId = randomUUID()
  private readonly reports: string[] = []

  private constructor(private readonly root: string) {
    super()
    this.gitRoot = join(root, 'git')
    this.gitCwd = join(this.gitRoot, 'project')
    this.svnRepository = join(root, 'svn-repository')
    this.svnWorkingCopy = join(root, 'svn-working-copy')
    this.codexHome = join(root, 'codex')
    this.claudeHome = join(root, 'claude')
    this.externalFile = join(root, 'external', 'outside.txt')
  }

  static async run(): Promise<void> {
    const temporary = mkdtempSync(join(tmpdir(), 'jamat-v3-file-changes-smoke-'))
    const root = realpathSync.native(temporary)
    try { await new SmokeFileChanges(root).execute() }
    finally { rmSync(temporary, { recursive: true, force: true }) }
  }

  private async execute(): Promise<void> {
    this.seedGit()
    this.seedCodexRollout()
    await this.checkGitAndChat()
    await this.checkWorkingSources()
    this.seedSvn()
    await this.checkSvn()
    this.check(`transcript discovery reported no errors (${this.reports.join(' | ')})`,
      this.reports.length === 0)
    console.log(`\nsmoke-file-changes: ${this.passed} checks passed`)
  }

  private async checkWorkingSources(): Promise<void> {
    const root = join(this.root, 'checkpoint-main')
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })
    const path = join(cwd, 'file.txt')
    writeFileSync(path, 'checkpoint before\n', 'utf8')
    const invoker = new GitInvoker()
    const store = new GitCheckpointStore(invoker)
    SmokeFileChanges.gitValue(await store.checkpoint(root, 'Checkpoint smoke baseline'))
    writeFileSync(path, 'checkpoint after\n', 'utf8')
    const manager = new FileChangesManager({ diffExecutor: new FileDiffComputer() })
    const main = SmokeFileChanges.workingSnapshotOf(await manager.workingTree({
      sessionId: 'checkpoint-main', cwd, agent: null, worktree: null,
    }, null))
    this.check('the main-copy working view defaults to an existing checkpoint store',
      main.source.selected === 'checkpoint'
      && main.source.available.join() === 'checkpoint'
      && main.entries.some((entry) => entry.displayPath === 'file.txt'
        && entry.status === 'modified'))

    const worktrees = new GitWorktreeManager(invoker, { modeOf: () => 'checkpoints', store })
    const facts = SmokeFileChanges.gitValue(await worktrees.create(root, 'source-smoke'))
    const worktreeCwd = join(facts.worktreePath, 'project')
    writeFileSync(join(worktreeCwd, 'file.txt'), 'worktree after\n', 'utf8')
    const context = {
      sessionId: 'checkpoint-worktree',
      cwd: worktreeCwd,
      agent: null,
      worktree: {
        worktreePath: facts.worktreePath,
        repositoryRoot: facts.repositoryRoot,
        baseCommit: facts.baseCommit,
      },
    }
    const againstBase = SmokeFileChanges.workingSnapshotOf(
      await manager.workingTree(context, null),
    )
    this.check('a checkpoint worktree defaults to its persisted creation base',
      againstBase.source.selected === 'worktree-base'
      && againstBase.source.available.join() === 'worktree-base,checkpoint'
      && againstBase.entries.some((entry) => entry.displayPath === 'file.txt'))
    SmokeFileChanges.gitValue(await store.checkpointWorktree(
      facts.worktreePath,
      'Checkpoint worktree smoke',
    ))
    const checkpoint = SmokeFileChanges.workingSnapshotOf(
      await manager.workingTree(context, 'checkpoint'),
    )
    const baseAfterCheckpoint = SmokeFileChanges.workingSnapshotOf(
      await manager.workingTree(context, 'worktree-base'),
    )
    this.check('checkpoint clears while creation base still includes committed worktree changes',
      checkpoint.entries.length === 0
      && baseAfterCheckpoint.entries.some((entry) => entry.displayPath === 'file.txt'))

    const missing = join(this.root, 'checkpoint-missing')
    mkdirSync(missing)
    const withoutStore = SmokeFileChanges.workingSnapshotOf(await manager.workingTree({
      sessionId: 'checkpoint-missing', cwd: missing, agent: null, worktree: null,
    }, null))
    this.check('reading a project without a checkpoint store does not create one',
      withoutStore.source.available.length === 0
      && !SmokeFileChanges.exists(join(missing, CheckpointLayout.storeRelativeConst)))
  }

  private seedGit(): void {
    mkdirSync(join(this.gitCwd, 'src'), { recursive: true })
    writeFileSync(join(this.gitCwd, 'src', 'file.txt'), 'before\n', 'utf8')
    this.run('git', this.gitRoot, ['init'])
    this.run('git', this.gitRoot, ['config', 'user.name', 'File Changes Smoke'])
    this.run('git', this.gitRoot, ['config', 'user.email', 'file-changes-smoke@example.invalid'])
    this.run('git', this.gitRoot, ['add', '.'])
    this.run('git', this.gitRoot, ['commit', '-m', 'Initial Git state'])
    writeFileSync(join(this.gitCwd, 'src', 'file.txt'), 'after\n', 'utf8')
    mkdirSync(join(this.gitCwd, 'new-directory'), { recursive: true })
    writeFileSync(
      join(this.gitCwd, 'new-directory', 'new.txt'),
      SmokeFileChanges.untrackedText(),
      'utf8',
    )
  }

  private seedCodexRollout(): void {
    mkdirSync(dirname(this.externalFile), { recursive: true })
    writeFileSync(this.externalFile, 'outside now\n', 'utf8')
    const now = new Date()
    const year = String(now.getFullYear())
    const month = String(now.getMonth() + 1).padStart(2, '0')
    const day = String(now.getDate()).padStart(2, '0')
    const stamp = `${year}-${month}-${day}T12:00:00.000Z`
    const rollout = join(
      this.codexHome,
      'sessions',
      year,
      month,
      day,
      `rollout-${year}-${month}-${day}T12-00-00-${this.codexSessionId}.jsonl`,
    )
    mkdirSync(dirname(rollout), { recursive: true })
    const records = [
      {
        timestamp: stamp,
        type: 'session_meta',
        payload: { id: this.codexSessionId, timestamp: stamp, cwd: this.gitCwd },
      },
      {
        timestamp: stamp,
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Add external file' },
      },
      {
        timestamp: stamp,
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'external-add',
          success: true,
          changes: {
            [this.externalFile]: { type: 'add', content: 'outside before\n' },
          },
        },
      },
      {
        timestamp: stamp,
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Update external file' },
      },
      {
        timestamp: stamp,
        type: 'event_msg',
        payload: {
          type: 'patch_apply_end',
          call_id: 'external-update',
          success: true,
          changes: {
            [this.externalFile]: {
              type: 'update',
              unified_diff: '@@ -1 +1 @@\n-outside before\n+outside now\n',
              move_path: null,
            },
          },
        },
      },
    ]
    writeFileSync(rollout, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8')
  }

  private async checkGitAndChat(): Promise<void> {
    const manager = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      transcriptResolver: new ProviderTranscriptView({
        codexHome: this.codexHome,
        claudeHome: this.claudeHome,
        report: (message) => { this.reports.push(message) },
      }),
    })
    const snapshot = SmokeFileChanges.snapshotOf(await manager.list({
      sessionId: 'git-smoke',
      cwd: this.gitCwd,
      agent: { agentId: 'codex', nativeSessionId: this.codexSessionId },
    }, { preferredVcs: 'git', historyPageSize: 50 }))
    this.check('Git is selected from a nested working directory',
      snapshot.vcs.selected === 'git'
      && snapshot.vcs.root !== null
      && PathCompare.comparable(snapshot.vcs.root) === PathCompare.comparable(this.gitRoot))
    this.check('Git defaults to HEAD',
      snapshot.defaultBaseline?.kind === 'git-head'
      && snapshot.defaultBaseline.label === 'HEAD')
    const modified = snapshot.entries.find((entry) => entry.displayPath === 'src/file.txt')
    this.check('Git status includes the modified tracked file',
      modified?.status === 'modified' && modified.sources.includes('vcs'))
    this.check('Git status includes the untracked file and its directory',
      snapshot.entries.some((entry) => entry.displayPath === 'new-directory/new.txt'
        && entry.status === 'untracked')
      && snapshot.entries.some((entry) => entry.displayPath === 'new-directory'
        && entry.nodeKind === 'directory'))
    const untracked = snapshot.entries.find((entry) => entry.displayPath === 'new-directory/new.txt')
    const untrackedDirectory = snapshot.entries.find((entry) => entry.displayPath === 'new-directory')
    this.check('files carry a working-tree mtime and a directory takes its newest descendant',
      typeof modified?.modifiedAt === 'number'
      && typeof untracked?.modifiedAt === 'number'
      && untrackedDirectory?.modifiedAt === untracked.modifiedAt)
    const external = snapshot.entries.find((entry) => entry.path === this.externalFile)
    this.check('the Codex log adds the external file to the current list',
      external?.location === 'external' && external.sources.join() === 'chat')
    this.check('history contains both Git commits and real chat messages',
      snapshot.history.groups.some((group) => group.baseline.kind === 'git-commit')
      && snapshot.history.groups.filter((group) => group.baseline.kind === 'chat-message').length === 2)
    if (!modified || !snapshot.defaultBaseline)
      throw new Error('FAILED: Git diff inputs are missing')
    const gitDiff = SmokeFileChanges.textDiffOf(await manager.diff({
      snapshotId: snapshot.snapshotId,
      fileId: modified.fileId,
      baselineId: snapshot.defaultBaseline.baselineId,
    }))
    this.check('the HEAD diff contains before and after lines',
      SmokeFileChanges.hasLine(gitDiff, 'remove', 'before')
      && SmokeFileChanges.hasLine(gitDiff, 'add', 'after'))
    if (!untracked)
      throw new Error('FAILED: Git untracked diff inputs are missing')
    const untrackedDiff = SmokeFileChanges.textDiffOf(await manager.diff({
      snapshotId: snapshot.snapshotId,
      fileId: untracked.fileId,
      baselineId: snapshot.defaultBaseline.baselineId,
    }))
    this.check('the real Git untracked file is one direct 611-line add hunk',
      untrackedDiff.hunks.length === 1
      && untrackedDiff.hunks[0]?.beforeLines === 0
      && untrackedDiff.hunks[0]?.afterLines === 611)
    const firstChat = snapshot.history.groups.find((group) => group.baseline.kind === 'chat-message'
      && group.label === 'Add external file')
    const chatFile = firstChat?.entries.find((entry) => entry.path === this.externalFile)
    if (!firstChat || !chatFile)
      throw new Error('FAILED: external chat baseline inputs are missing')
    const chatDiff = SmokeFileChanges.textDiffOf(await manager.diff({
      snapshotId: snapshot.snapshotId,
      fileId: chatFile.fileId,
      baselineId: firstChat.baseline.baselineId,
    }))
    this.check('the chat baseline is the file state after the selected message',
      chatDiff.completeness === 'full'
      && SmokeFileChanges.hasLine(chatDiff, 'remove', 'outside before')
      && SmokeFileChanges.hasLine(chatDiff, 'add', 'outside now'))
  }

  private seedSvn(): void {
    const imported = join(this.root, 'svn-import')
    mkdirSync(join(imported, 'project', 'src'), { recursive: true })
    writeFileSync(join(imported, 'project', 'src', 'file.txt'), 'before\n', 'utf8')
    this.run('svnadmin', this.root, ['create', this.svnRepository])
    const repositoryUrl = pathToFileURL(this.svnRepository).href
    this.run('svn', this.root, [
      'import', imported, repositoryUrl, '-m', 'Initial SVN state', '--non-interactive',
    ])
    this.run('svn', this.root, [
      'checkout', repositoryUrl, this.svnWorkingCopy, '--non-interactive',
    ])
    writeFileSync(join(this.svnWorkingCopy, 'project', 'src', 'file.txt'), 'after\n', 'utf8')
    mkdirSync(join(this.svnWorkingCopy, 'project', 'new-directory'), { recursive: true })
    writeFileSync(
      join(this.svnWorkingCopy, 'project', 'new-directory', 'new.txt'),
      SmokeFileChanges.untrackedText(),
      'utf8',
    )
    writeFileSync(
      join(this.svnWorkingCopy, 'project', 'new.txt'),
      SmokeFileChanges.untrackedText(),
      'utf8',
    )
  }

  private async checkSvn(): Promise<void> {
    const cwd = join(this.svnWorkingCopy, 'project')
    const manager = new FileChangesManager({
      diffExecutor: new FileDiffComputer(),
      transcriptResolver: { resolve: async () => null },
    })
    const snapshot = SmokeFileChanges.snapshotOf(await manager.list({
      sessionId: 'svn-smoke',
      cwd,
      agent: { agentId: 'claude', nativeSessionId: 'svn-smoke' },
    }, { preferredVcs: 'svn', historyPageSize: 50 }))
    this.check('SVN is selected from a nested working copy',
      snapshot.vcs.selected === 'svn'
      && snapshot.vcs.root !== null
      && PathCompare.comparable(snapshot.vcs.root) === PathCompare.comparable(this.svnWorkingCopy))
    this.check('SVN defaults to the local BASE revision',
      snapshot.defaultBaseline?.kind === 'svn-base'
      && snapshot.defaultBaseline.label === 'BASE')
    const modified = snapshot.entries.find((entry) => entry.displayPath === 'src/file.txt')
    const untracked = snapshot.entries.find((entry) => entry.displayPath === 'new.txt')
    this.check('SVN status includes the modified tracked file and unversioned directory',
      modified?.status === 'modified'
      && snapshot.entries.some((entry) => entry.displayPath === 'new-directory'
        && entry.status === 'untracked'))
    this.check('SVN history contains the committed revision',
      snapshot.history.groups.some((group) => group.baseline.kind === 'svn-revision'))
    if (!modified || !snapshot.defaultBaseline)
      throw new Error('FAILED: SVN diff inputs are missing')
    const diff = SmokeFileChanges.textDiffOf(await manager.diff({
      snapshotId: snapshot.snapshotId,
      fileId: modified.fileId,
      baselineId: snapshot.defaultBaseline.baselineId,
    }))
    this.check('the BASE diff contains before and after lines',
      SmokeFileChanges.hasLine(diff, 'remove', 'before')
      && SmokeFileChanges.hasLine(diff, 'add', 'after'))
    if (!untracked)
      throw new Error('FAILED: SVN untracked diff inputs are missing')
    const untrackedDiff = SmokeFileChanges.textDiffOf(await manager.diff({
      snapshotId: snapshot.snapshotId,
      fileId: untracked.fileId,
      baselineId: snapshot.defaultBaseline.baselineId,
    }))
    this.check('the real SVN untracked file is one direct 611-line add hunk',
      untrackedDiff.hunks.length === 1
      && untrackedDiff.hunks[0]?.beforeLines === 0
      && untrackedDiff.hunks[0]?.afterLines === 611)
    const working = SmokeFileChanges.workingSnapshotOf(await manager.workingTree({
      sessionId: 'svn-working-smoke', cwd, agent: null, worktree: null,
    }, 'svn'))
    this.check('the current-only view offers SVN BASE without a checkpoint store',
      working.source.selected === 'svn'
      && working.source.available.join() === 'svn'
      && working.defaultBaseline?.kind === 'svn-base'
      && working.entries.some((entry) => entry.displayPath === 'src/file.txt'))
  }

  private run(command: string, cwd: string, args: readonly string[]): string {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  private static snapshotOf(result: FileChangesSnapshotResult): FileChangesSnapshot {
    if (!result.ok)
      throw new Error(`FAILED: listing refused with ${result.code}: ${result.detail}`)
    return result.value
  }

  private static workingSnapshotOf(
    result: FileChangesWorkingTreeSnapshotResult,
  ): FileChangesWorkingTreeSnapshot {
    if (!result.ok)
      throw new Error(`FAILED: working listing refused with ${result.code}: ${result.detail}`)
    return result.value
  }

  private static gitValue<T>(result: GitResult<T>): T {
    if (!result.ok) throw new Error(`FAILED: git ${result.code}: ${result.detail}`)
    return result.value
  }

  private static exists(path: string): boolean {
    try { realpathSync.native(path); return true }
    catch { return false }
  }

  private static textDiffOf(result: FileDiffResult): FileDiffData {
    if (!result.ok)
      throw new Error(`FAILED: diff refused with ${result.code}: ${result.detail}`)
    if (result.kind !== 'text')
      throw new Error(`FAILED: diff returned ${result.kind}: ${result.detail}`)
    return result.data
  }

  private static hasLine(
    diff: FileDiffData,
    kind: 'add' | 'remove',
    text: string,
  ): boolean {
    return diff.hunks.some((hunk) => hunk.lines.some((line) => line.kind === kind && line.text === text))
  }

  private static untrackedText(): string {
    return `${Array.from({ length: 611 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
  }

}

void SmokeFileChanges.run().catch((error: unknown) => SmokeRun.failed('smoke-file-changes', error))
