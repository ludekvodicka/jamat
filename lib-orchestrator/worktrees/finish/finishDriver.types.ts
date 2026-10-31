import type { SvnWorktreeManager } from '../../svn/svnWorktreeManager'
import type { WorktreeLifecycle } from '../worktreeState'
import type { WorktreeSvnCommands } from '../worktreeSvnCommands'
import type { SvnActionFlowDeps } from './svnActionFlow'
import type { MainCopyUpdate } from '../landing/mainCopyUpdate'
import type { SyncStep } from './syncStep'
import type { WorkerHandoffs } from '../../sessionManager/worktreeSessionRuntime'

export interface FinishDriverPorts {
  commands: Pick<WorktreeSvnCommands, 'lease' | 'verify' | 'accept' | 'acceptInterrupted'>
  sync: Pick<SyncStep, 'run' | 'resolve' | 'withControl' | 'recover'>
  handoffs: Pick<WorkerHandoffs, 'checksFailed' | 'conflicts' | 'notifyCaller' | 'messageWanted'>
  idle(sessionId: string): boolean
  /** Why the worker does not count as idle, as a person reads it; null when it does. */
  busyReason(sessionId: string): string | null
  holdInput(sessionId: string): () => void
  awaitExit(sessionId: string): Promise<boolean>
  liveness(sessionId: string, completedStep?: WorktreeLifecycle['step']): Promise<void>
}

export type FinishDriverDeps = SvnActionFlowDeps & FinishDriverPorts & {
  svn: SvnActionFlowDeps['svn'] & Pick<SvnWorktreeManager, 'publicationRows'>
  update: MainCopyUpdate
}
