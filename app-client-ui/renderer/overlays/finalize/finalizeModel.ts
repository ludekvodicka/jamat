import type { RemoteControlResponse } from '../../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type {
  SessionInfo,
  SessionSetupAgreement,
  SessionsOpResult,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { IpcResult } from '../../../shared/appClientUiIpc'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import { type SessionGlyph, SessionNodeState } from '../../views/sessionsTree/sessionNodeState'
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
  /** What the person must know before choosing, such as why a Finish waits for them. */
  note?: string
  /** The choices whose accepted press starts an action with a workflow, which then comes forward. */
  startsWorkflow?: readonly string[]
}

/** What the dialog shows about the session it finishes, read when it opens; the dialog changes none of it. */
export interface FinalizeSessionFacts {
  glyph: SessionGlyph
  /** The label of the sessions tree section the row is drawn in. */
  group: string
  note: string | null
}

export interface FinalizeAsk {
  target: TerminalTarget
  scope: FinalizeScope
  sessionTitle: string
  session: FinalizeSessionFacts
  questions: readonly { specId: string; question: SessionFinalizeQuestion }[]
}

export interface FinalizeOpenRequest {
  requestId: number
  ask: FinalizeAsk
}

export class FinalizeAsks {
  /** `group` is the label of the section the opener draws the row in; the session itself does not carry it. */
  static of(
    session: SessionInfo,
    target: TerminalTarget,
    scope: FinalizeScope,
    group: string,
    catalog: readonly SessionFinalizeQuestionSpec[] = FinalizeCatalog.questions(),
  ): FinalizeAsk | null {
    const questions = FinalizeAsks.questionsOf(session, scope, catalog)
    if (questions.length === 0) return null
    return {
      target,
      scope,
      sessionTitle: session.title,
      session: {
        glyph: SessionNodeState.glyphOf(session.life, session.kind, session.activity, session.activityDetail, session.compacting),
        group,
        note: session.note ?? null,
      },
      questions,
    }
  }

  /** Whether a Finish of this session has anything to ask, without building the ask. */
  static offered(
    session: SessionInfo,
    scope: FinalizeScope,
    catalog: readonly SessionFinalizeQuestionSpec[] = FinalizeCatalog.questions(),
  ): boolean {
    return FinalizeAsks.questionsOf(session, scope, catalog).length > 0
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

  private static questionsOf(
    session: SessionInfo,
    scope: FinalizeScope,
    catalog: readonly SessionFinalizeQuestionSpec[],
  ): readonly { specId: string; question: SessionFinalizeQuestion }[] {
    return catalog
      .map((spec) => ({ specId: spec.id, question: spec.questionOf(session, scope) }))
      .filter((entry): entry is { specId: string; question: SessionFinalizeQuestion } =>
        entry.question !== null)
  }
}

export class FinalizeAgreements {
  /**
   * The commands and the hash of a `setup-not-acknowledged`, or null for every other answer. A local
   * refusal carries them beside its code; a remote one behind `error.data`, and that payload crossed
   * a network, so it is checked before it is shown or answered.
   */
  static of(answer: IpcResult<SessionsOpResult | RemoteControlResponse>): SessionSetupAgreement | null {
    if (!answer.ok || answer.value.ok) return null
    const refusal = answer.value
    if ('error' in refusal) {
      const data = refusal.error.data
      if (data?.sourceCode !== 'setup-not-acknowledged') return null
      return FinalizeAgreements.agreementOf(data.setup)
    }
    if (refusal.code !== 'setup-not-acknowledged') return null
    return refusal.setup ?? null
  }

  private static agreementOf(value: unknown): SessionSetupAgreement | null {
    if (typeof value !== 'object' || value === null) return null
    if (!('commands' in value) || !Array.isArray(value.commands)) return null
    if (!value.commands.every((command) => typeof command === 'string')) return null
    if (!('hash' in value) || typeof value.hash !== 'string') return null
    return { commands: value.commands as string[], hash: value.hash }
  }
}

export class FinalizeWorking {
  /**
   * Why the press was refused because the session still works, or null for every other answer. The
   * person reads it and finishes anyway; only this computer's window gets the refusal.
   */
  static of(answer: IpcResult<SessionsOpResult | RemoteControlResponse>): string | null {
    if (!answer.ok || answer.value.ok || 'error' in answer.value) return null
    return answer.value.code === 'session-working' ? answer.value.detail : null
  }
}
