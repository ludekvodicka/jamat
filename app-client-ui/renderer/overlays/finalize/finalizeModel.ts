import type { SessionInfo } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import { FinalizeCatalog, type SessionFinalizeQuestionSpec } from './finalizeCatalog'

export type FinalizeScope = 'local' | 'remote'

export interface SessionFinalizeChoice {
  id: string
  title: string
  note: string | null
  glyph: string
  submitLabel: string | null
  danger?: boolean
}

export interface SessionFinalizeQuestion {
  label: string
  choices: readonly SessionFinalizeChoice[]
  chosenDefault: string
}

export interface FinalizeAsk {
  target: TerminalTarget
  scope: FinalizeScope
  sessionTitle: string
  questions: readonly { specId: string; question: SessionFinalizeQuestion }[]
}

export interface FinalizeOpenRequest {
  requestId: number
  ask: FinalizeAsk
}

export class FinalizeAsks {
  static of(
    session: SessionInfo,
    target: TerminalTarget,
    scope: FinalizeScope,
    catalog: readonly SessionFinalizeQuestionSpec[] = FinalizeCatalog.questions(),
  ): FinalizeAsk | null {
    const questions = catalog
      .map((spec) => ({ specId: spec.id, question: spec.questionOf(session, scope) }))
      .filter((entry): entry is { specId: string; question: SessionFinalizeQuestion } =>
        entry.question !== null)
    if (questions.length === 0) return null
    return { target, scope, sessionTitle: session.title, questions }
  }

  static submitLabelOf(ask: FinalizeAsk, chosen: ReadonlyMap<string, string>): string {
    const labels: string[] = []
    for (const entry of ask.questions) {
      const choiceId = chosen.get(entry.specId) ?? entry.question.chosenDefault
      const choice = entry.question.choices.find((candidate) => candidate.id === choiceId)
      if (choice === undefined)
        throw new Error(`Unknown finalize choice: ${JSON.stringify(choiceId)}`)
      if (choice.submitLabel !== null) labels.push(choice.submitLabel)
    }
    if (labels.length === 0) return 'Close'
    else if (labels.length === 1) return labels[0]
    else return 'Finish'
  }
}
