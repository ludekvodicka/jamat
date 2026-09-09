import type { RepoCommandContext } from '../../git/git.types'
import { GitCheckpointStore } from '../../git/gitCheckpointStore'
import { GitInvoker } from '../../git/gitInvoker'
import { ErrorText } from '../../shared/errorText'
import { PathCompare } from '../../shared/pathCompare'
import type {
  FileChangesWorkingTreeContext,
  FileChangesWorkingTreeSelection,
  FileChangesWorkingTreeSource,
  FileChangesVcsDetection,
} from '../fileChangesManagerApi.types'
import type {
  FileChangesVcs,
  FileChangesVcsBaselineRef,
  FileChangesVcsEntry,
} from '../vcs/fileChangesVcs.types'
import { FileChangesVcsGit } from '../vcs/fileChangesVcsGit'
import { FileChangesVcsSvn } from '../vcs/fileChangesVcsSvn'

export interface FileChangesWorkingTreeSourcesDeps {
  checkpointStore?: Pick<GitCheckpointStore, 'existingContextOf' | 'worktreeBelongsToStore'>
  gitOf?: (commandArgs: readonly string[]) => FileChangesVcsGit
  svn?: FileChangesVcs
}

interface FileChangesWorkingTreeCandidate {
  source: FileChangesWorkingTreeSource
  adapter: FileChangesVcs
  detection: FileChangesVcsDetection
  baseRef: string | null
}

export interface FileChangesWorkingTreeRead {
  selection: FileChangesWorkingTreeSelection
  selected: {
    adapter: FileChangesVcs
    detection: FileChangesVcsDetection
    baseline: FileChangesVcsBaselineRef
    baselineLabel: string
  } | null
  entries: readonly FileChangesVcsEntry[]
  warnings: readonly string[]
}

export class FileChangesWorkingTreeSources {
  private readonly checkpointStore: Pick<
    GitCheckpointStore,
    'existingContextOf' | 'worktreeBelongsToStore'
  >
  private readonly gitOf: (commandArgs: readonly string[]) => FileChangesVcsGit
  private readonly svn: FileChangesVcs

  constructor(deps?: FileChangesWorkingTreeSourcesDeps) {
    this.checkpointStore = deps?.checkpointStore
      ?? new GitCheckpointStore(new GitInvoker())
    this.gitOf = deps?.gitOf
      ?? ((commandArgs) => new FileChangesVcsGit(undefined, commandArgs))
    this.svn = deps?.svn ?? new FileChangesVcsSvn()
  }

  async read(
    context: FileChangesWorkingTreeContext,
    requested: FileChangesWorkingTreeSource | null,
  ): Promise<FileChangesWorkingTreeRead> {
    const warnings: string[] = []
    const candidates = await this.candidates(context, warnings)
    const selected = requested === null
      ? candidates[0] ?? null
      : candidates.find((candidate) => candidate.source === requested) ?? candidates[0] ?? null
    const selection: FileChangesWorkingTreeSelection = {
      requested,
      selected: selected?.source ?? null,
      available: candidates.map((candidate) => candidate.source),
      fallbackReason: requested !== null && selected?.source !== requested
        ? `${FileChangesWorkingTreeSources.labelOf(requested)} is not available in ${context.cwd}`
          + (selected === null ? '' : `; using ${FileChangesWorkingTreeSources.labelOf(selected.source)}`)
        : null,
    }
    if (selected === null)
      return { selection, selected: null, entries: [], warnings }
    if (selected.source === 'worktree-base') {
      if (!(selected.adapter instanceof FileChangesVcsGit) || selected.baseRef === null)
        throw new Error(`Invalid worktree-base candidate: ${JSON.stringify(selected)}`)
      const status = await selected.adapter
        .statusAgainst(selected.detection, selected.baseRef)
        .catch((error) => ({ ok: false as const, detail: ErrorText.of(error) }))
      if (!status.ok) {
        warnings.push(`Worktree base: ${status.detail}`)
        return { selection, selected: null, entries: [], warnings }
      }
      return {
        selection,
        selected: {
          adapter: selected.adapter,
          detection: selected.detection,
          baseline: { kind: 'git-commit', revision: status.value.revision },
          baselineLabel: `Worktree base ${status.value.revision.slice(0, 12)}`,
        },
        entries: status.value.entries,
        warnings,
      }
    }
    else if (selected.source === 'checkpoint' || selected.source === 'svn') {
      const status = await selected.adapter
        .status(selected.detection)
        .catch((error) => ({ ok: false as const, detail: ErrorText.of(error) }))
      if (!status.ok) {
        warnings.push(`${FileChangesWorkingTreeSources.labelOf(selected.source)}: ${status.detail}`)
        return { selection, selected: null, entries: [], warnings }
      }
      return {
        selection,
        selected: {
          adapter: selected.adapter,
          detection: selected.detection,
          baseline: selected.adapter.defaultBaselineRef,
          baselineLabel: selected.source === 'checkpoint' ? 'Checkpoint HEAD' : 'SVN BASE',
        },
        entries: status.value,
        warnings,
      }
    }
    else
      throw new Error(`Unknown working tree source: ${JSON.stringify(selected.source)}`)
  }

  private async candidates(
    context: FileChangesWorkingTreeContext,
    warnings: string[],
  ): Promise<FileChangesWorkingTreeCandidate[]> {
    const git = await this.gitCandidates(context, warnings)
    const svnDetection = await this.svn.detect(context.cwd).catch(() => null)
    const svn = svnDetection === null
      ? []
      : [{ source: 'svn' as const, adapter: this.svn, detection: svnDetection, baseRef: null }]
    if (context.worktree !== null) return [...git, ...svn]
    return [...svn, ...git]
  }

  private async gitCandidates(
    context: FileChangesWorkingTreeContext,
    warnings: string[],
  ): Promise<FileChangesWorkingTreeCandidate[]> {
    if (context.worktree !== null) {
      if (!PathCompare.isInside(context.worktree.worktreePath, context.cwd)) return []
      const adapter = this.gitOf([])
      const detection = await adapter.detect(context.cwd).catch(() => null)
      if (detection === null) return []
      const belongs = await this.checkpointStore
        .worktreeBelongsToStore(context.worktree.worktreePath)
        .catch(() => false)
      return [
        {
          source: 'worktree-base',
          adapter,
          detection,
          baseRef: context.worktree.baseCommit,
        },
        ...(belongs
          ? [{ source: 'checkpoint' as const, adapter, detection, baseRef: null }]
          : []),
      ]
    }
    let existing: Awaited<ReturnType<GitCheckpointStore['existingContextOf']>>
    try { existing = await this.checkpointStore.existingContextOf(context.cwd) }
    catch (error) {
      warnings.push(`Checkpoint discovery: ${ErrorText.of(error)}`)
      return []
    }
    if (!existing.ok) {
      warnings.push(`Checkpoint discovery: ${existing.detail}`)
      return []
    }
    if (existing.value === null) return []
    return this.mainCheckpointCandidate(context, existing.value)
  }

  private async mainCheckpointCandidate(
    context: FileChangesWorkingTreeContext,
    command: RepoCommandContext,
  ): Promise<FileChangesWorkingTreeCandidate[]> {
    const adapter = this.gitOf(command.gitDirArgs)
    const detection = await adapter.detect(context.cwd).catch(() => null)
    return detection === null
      ? []
      : [{ source: 'checkpoint', adapter, detection, baseRef: null }]
  }

  static labelOf(source: FileChangesWorkingTreeSource): string {
    if (source === 'checkpoint') return 'Checkpoint'
    else if (source === 'svn') return 'SVN BASE'
    else if (source === 'worktree-base') return 'Worktree base'
    else throw new Error(`Unknown working tree source: ${JSON.stringify(source)}`)
  }
}
