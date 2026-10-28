import type {
  FileChangeStatus,
  FileChangesVcsId,
  FileChangesWorkingTreeSource,
} from '../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'

/** Whose letters a list writes: svn's R is a replaced node, git's R a rename. */
export type FileChangesMarkConventions = 'svn' | 'git'

export class FileChangesStatusMark {
  static of(status: FileChangeStatus, conventions: FileChangesMarkConventions): string {
    if (status === 'added') return 'A'
    else if (status === 'modified') return 'M'
    else if (status === 'deleted') return 'D'
    else if (status === 'renamed') return FileChangesStatusMark.renamedOf(conventions)
    else if (status === 'replaced') return FileChangesStatusMark.replacedOf(conventions)
    else if (status === 'copied') return 'C'
    else if (status === 'untracked') return '?'
    else if (status === 'conflicted') return '!'
    else if (status === 'missing') return '−'
    else if (status === 'obstructed') return 'X'
    else throw new Error(`Unknown file change status: ${JSON.stringify(status)}`)
  }

  /** Only an SVN BASE source reads svn's own status; a checkpoint and a worktree base are git stores. */
  static ofSource(source: FileChangesWorkingTreeSource | null): FileChangesMarkConventions {
    return source === 'svn' ? 'svn' : 'git'
  }

  /** No VCS lists only what the transcript changed, where git's letters are as good as any. */
  static ofVcs(vcs: FileChangesVcsId | null): FileChangesMarkConventions {
    return vcs === 'svn' ? 'svn' : 'git'
  }

  private static renamedOf(conventions: FileChangesMarkConventions): string {
    switch (conventions) {
      case 'svn': return '→'
      case 'git': return 'R'
      default: throw new Error(`Unknown mark conventions: ${JSON.stringify(conventions satisfies never)}`)
    }
  }

  private static replacedOf(conventions: FileChangesMarkConventions): string {
    switch (conventions) {
      case 'svn': return 'R'
      case 'git': return 'T'
      default: throw new Error(`Unknown mark conventions: ${JSON.stringify(conventions satisfies never)}`)
    }
  }
}
