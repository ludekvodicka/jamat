import { FinishProjection } from '../finish/finishProjection'
import type { SessionRecord, SessionRecordWorktree } from '../../sessionManager/worktreeSessionRecords'
import type { SessionWorktreeInfo, SessionWorktreePlace } from '../../sessionManager/sessionManagerApi.types'
import { SvnActionStages } from '../finish/svnActionStages'

export class WorktreeRecordView {
  static worktreePlaceOf(worktree: SessionRecordWorktree): SessionWorktreePlace {
    const kind = worktree.kind ?? 'git'
    if (kind === 'git') return { kind, worktreePath: worktree.worktreePath, url: null, baseRevision: null }
    else if (kind === 'svn') {
      const revision = /^r(\d+)$/.exec(worktree.baseCommit)?.[1]
      return {
        kind,
        worktreePath: worktree.worktreePath,
        url: worktree.branch,
        baseRevision: revision === undefined ? null : Number(revision),
      }
    }
    else throw new Error(`Unknown worktree kind: ${JSON.stringify(kind satisfies never)}`)
  }

  static legacyFinishOf(record: SessionRecord): SessionWorktreeInfo['finish'] {
    const action = FinishProjection.action(record)
    if (action === undefined || !SvnActionStages.running(record)) return undefined
    const scopeRoot = SvnActionStages.scopeRootOf(action)
    return { phase: SvnActionStages.legacyPhaseOf(action.stage), ...scopeRoot === undefined ? {} : { scopeRoot } }
  }
}
