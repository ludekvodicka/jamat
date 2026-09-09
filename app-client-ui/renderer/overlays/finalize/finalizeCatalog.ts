import type { RemoteControlResponse } from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionInfo,
  SessionsOpResult,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { CatalogEntries } from '../../../shared/catalogEntries'
import type { FinalizeScope, SessionFinalizeQuestion } from './finalizeModel'
import { WorktreeQuestion } from './worktreeQuestion'

export interface SessionFinalizePorts {
  finalize(): Promise<IpcResult<SessionsOpResult | RemoteControlResponse>>
  discardWorktree(): Promise<IpcResult<SessionsOpResult>>
}

export interface SessionFinalizeQuestionSpec {
  id: string
  order: number
  questionOf(session: SessionInfo, scope: FinalizeScope): SessionFinalizeQuestion | null
  perform(
    choiceId: string,
    ports: SessionFinalizePorts,
  ): Promise<IpcResult<SessionsOpResult | RemoteControlResponse>>
}

export class FinalizeCatalog {
  private static readonly catalogConst: readonly SessionFinalizeQuestionSpec[] =
    [WorktreeQuestion.spec]

  static questions(
    catalog: readonly SessionFinalizeQuestionSpec[] = FinalizeCatalog.catalogConst,
  ): readonly SessionFinalizeQuestionSpec[] {
    CatalogEntries.assertDistinct('finalize questions', catalog)
    return [...catalog].sort((left, right) => left.order - right.order)
  }

  static byId(id: string): SessionFinalizeQuestionSpec {
    const found = FinalizeCatalog.questions().find((question) => question.id === id)
    if (found === undefined)
      throw new Error(`Unknown finalize question: ${JSON.stringify(id)}`)
    return found
  }
}
