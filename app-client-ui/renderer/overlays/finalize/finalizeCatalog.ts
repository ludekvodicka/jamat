import type { RemoteControlResponse } from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionInfo,
  SessionsOpResult,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import { CatalogEntries } from '../../../shared/catalogEntries'
import type { FinalizeScope, SessionFinalizeQuestion } from './finalizeModel'
import { WorktreeQuestion } from './worktreeQuestion'

/** What the person agreed to on the press that answers a target's question, and nothing before it asked. */
export interface FinalizeAgreement {
  /** The hash of the commands the target asked about. */
  acknowledgeSetup?: string
  /** The person finishes a session that is still working. */
  confirmWorking?: true; overrideChecks?: true
}

export interface SessionFinalizePorts {
  /** `acknowledgeSetup` is the hash of an agreement the target asked for, on the press that answers it. */
  finalize(acknowledgeSetup?: string): Promise<IpcResult<SessionsOpResult | RemoteControlResponse>>
  /** One press of an SVN worktree's Finish, answered once its action is written; Discard of a Git one too. */
  finishWorktree(
    choice: 'commit' | 'discard' | 'keep',
    agreement: FinalizeAgreement,
  ): Promise<IpcResult<SessionsOpResult | RemoteControlResponse>>
}

export interface SessionFinalizeQuestionSpec {
  id: string
  order: number
  questionOf(session: SessionInfo, scope: FinalizeScope): SessionFinalizeQuestion | null
  perform(
    choiceId: string,
    ports: SessionFinalizePorts,
    agreement: FinalizeAgreement,
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
