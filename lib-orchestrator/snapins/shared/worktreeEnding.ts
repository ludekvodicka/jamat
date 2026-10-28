import type { SessionInfo } from '../../sessionManager/sessionManagerApi.types'

export class WorktreeEnding {
  static of(session: Pick<SessionInfo, 'worktreeView'> | undefined): 'terminal' | 'open' | 'missing' {
    if (!session) return 'missing'
    const phase = session.worktreeView?.phase
    switch (phase) {
      case 'landed': case 'removed': return 'terminal'
      case undefined: case 'active': case 'finishing': case 'waiting': case 'kept': return 'open'
      default: throw new Error(`Unknown worktree phase ${phase satisfies never}`)
    }
  }
}
