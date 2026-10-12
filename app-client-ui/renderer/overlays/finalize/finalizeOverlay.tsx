import { useEffect, useRef, useState } from 'react'

import type { SessionSetupAgreement } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../../shared/errorText'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import { IpcFailure } from '../../ipc/ipcFailure'
import { SessionNodeState } from '../../views/sessionsTree/sessionNodeState'
import { ChoiceCard, ChoiceRow } from '../../widgets/choiceCards'
import { type FinalizeAgreement, FinalizeCatalog, type SessionFinalizePorts } from './finalizeCatalog'
import {
  FinalizeAgreements,
  FinalizeAsks,
  FinalizeWorking,
  type FinalizeOpenRequest,
  type FinalizeSessionFacts,
} from './finalizeModel'
import './finalize.css'
import { AppControl } from '../../ipc/appControl'

export function FinalizeOverlay(props: {
  request: FinalizeOpenRequest
  onClose(): void
}): React.JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const completed = useRef<ReadonlySet<string>>(new Set())
  const ask = props.request.ask
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(
    () => new Map(ask.questions.map((entry) => [entry.specId, entry.question.chosenDefault])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The commands a question's target asked this person to agree to. The hash travels with the ONE
   * press that answers it, and only after the target asked, so an older target never meets the key.
   */
  const [agreement, setAgreement] = useState<{ specId: string; setup: SessionSetupAgreement } | null>(null)
  /** A session that still works: the person reads why and finishes it anyway, or cancels. */
  const [working, setWorking] = useState<{ specId: string; detail: string } | null>(null)
  const ports = FinalizePorts.of(ask.target)
  const remainingAsk = {
    ...ask,
    questions: ask.questions.filter((entry) => !completed.current.has(entry.specId)),
  }
  const submitLabel = FinalizeAsks.submitLabelOf(remainingAsk, chosen)
  const danger = remainingAsk.questions.some((entry) => {
    const choiceId = chosen.get(entry.specId) ?? entry.question.chosenDefault
    return entry.question.choices.find((choice) => choice.id === choiceId)?.danger === true
  })

  useEffect(() => {
    mounted.current = true
    const restore = document.activeElement
    card.current?.focus()
    return () => {
      mounted.current = false
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [])

  const close = (): void => {
    if (!inFlight.current) props.onClose()
  }

  const choose = (specId: string, choiceId: string): void => {
    if (inFlight.current || completed.current.has(specId)) return
    setChosen((current) => new Map(current).set(specId, choiceId))
    setError(null)
    setAgreement(null)
    setWorking(null)
  }

  const submit = async (agreed?: { specId: string; agreement: FinalizeAgreement }): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setAgreement(null)
    setWorking(null)
    for (const entry of ask.questions) {
      if (completed.current.has(entry.specId)) continue
      const choiceId = chosen.get(entry.specId) ?? entry.question.chosenDefault
      const choice = entry.question.choices.find((candidate) => candidate.id === choiceId)
      if (choice === undefined)
        throw new Error(`Unknown finalize choice: ${JSON.stringify(choiceId)}`)
      if (choice.submitLabel === null) continue
      try {
        const answer = await FinalizeCatalog.byId(entry.specId)
          .perform(choiceId, ports, agreed?.specId === entry.specId ? agreed.agreement : {})
        if (!mounted.current) return
        const asked = FinalizeAgreements.of(answer)
        if (asked !== null) {
          inFlight.current = false
          setBusy(false)
          setAgreement({ specId: entry.specId, setup: asked })
          return
        }
        const stillWorking = FinalizeWorking.of(answer)
        if (stillWorking !== null) {
          inFlight.current = false
          setBusy(false)
          setWorking({ specId: entry.specId, detail: stillWorking })
          return
        }
        const failure = IpcFailure.of(answer, choice.title)
        if (failure !== null) {
          inFlight.current = false
          setBusy(false)
          setError(failure)
          return
        }
        completed.current = new Set(completed.current).add(entry.specId)
      } catch (thrown: unknown) {
        inFlight.current = false
        if (!mounted.current) return
        setBusy(false)
        setError(`${choice.title} failed: ${ErrorText.of(thrown)}`)
        return
      }
    }
    if (mounted.current) props.onClose()
  }

  return (
    <div
      className="jamat-finalize"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={card}
        className="jamat-finalize__card"
        role="dialog"
        aria-modal="true"
        aria-label={`Finish ${ask.sessionTitle}`}
        tabIndex={-1}
        onKeyDown={(event) => FinalizeKeys.handle(event, {
          // Agreeing to run commands is a click on the button that names it, never a stray Enter.
          submit: () => { if (agreement === null && working === null) void submit() },
          close,
        })}
      >
        <header className="jamat-finalize__head">
          <span className="jamat-finalize__title">Finish session</span>
          <span className="jamat-finalize__session">{ask.sessionTitle}</span>
          <button
            className="jamat-finalize__close"
            type="button"
            aria-label="Close Finish session"
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="jamat-finalize__body">
          <FinalizeSessionFactsLine facts={ask.session} />
          {ask.questions.map((entry) => (
            <ChoiceRow key={entry.specId} label={entry.question.label} current={false}>
              {entry.question.note !== undefined
                && <p className="jamat-finalize__note" role="status">{entry.question.note}</p>}
              <div className="jamat-choice__cards">
                {entry.question.choices.map((choice) => (
                  <ChoiceCard
                    key={choice.id}
                    title={choice.title}
                    note={choice.note}
                    glyph={choice.glyph}
                    chosen={(chosen.get(entry.specId) ?? entry.question.chosenDefault) === choice.id}
                    refusal={completed.current.has(entry.specId) ? 'Already completed' : null}
                    danger={choice.danger}
                    onChoose={() => choose(entry.specId, choice.id)}
                  />
                ))}
              </div>
            </ChoiceRow>
          ))}
          {error !== null && <p className="jamat-finalize__error" role="alert">{error}</p>}
          {agreement !== null && (
            <div className="jamat-finalize__agreement" role="group" aria-label="Command agreement">
              <p>This project asks to run these commands in its worktrees before the Finish goes on:</p>
              <ul>
                {agreement.setup.commands.map((command, index) =>
                  <li key={index}><code>{command}</code></li>)}
              </ul>
            </div>
          )}
          {working !== null && (
            <p className="jamat-finalize__agreement" role="alert">{working.detail}</p>
          )}
          <div className="jamat-finalize__actions">
            {working !== null
              ? (
                  <button
                    className="jamat-finalize__button jamat-finalize__button--primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void submit({ specId: working.specId, agreement: { confirmWorking: true } })}
                  >
                    Finish anyway
                  </button>
                )
              : agreement === null
              ? (
                  <button
                    className={`jamat-finalize__button jamat-finalize__button--primary${
                      danger ? ' jamat-finalize__button--danger' : ''}`}
                    type="button"
                    disabled={busy}
                    onClick={() => void submit()}
                  >
                    {busy ? 'Working…' : submitLabel}
                  </button>
                )
              : (
                  <button
                    className="jamat-finalize__button jamat-finalize__button--primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void submit({ specId: agreement.specId, agreement: { acknowledgeSetup: agreement.setup.hash } })}
                  >
                    Agree and finish
                  </button>
                )}
            <button
              className="jamat-finalize__button"
              type="button"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Read-only: the dialog shows where the session stands and never moves it between groups. */
function FinalizeSessionFactsLine(props: { facts: FinalizeSessionFacts }): React.JSX.Element {
  const { glyph, group, note } = props.facts
  return (
    <dl className="jamat-finalize__facts" aria-label="Session state">
      <div className="jamat-finalize__fact">
        <dt>Activity</dt>
        <dd>
          <span
            className={`jamat-finalize__glyph jamat-finalize__glyph--paint-${SessionNodeState.paintOf(glyph, false)}`}
            aria-hidden="true"
          >
            {SessionNodeState.characterOf(glyph, false)}
          </span>
          {SessionNodeState.glyphTitleOf(glyph, false)}
        </dd>
      </div>
      <div className="jamat-finalize__fact">
        <dt>Group</dt>
        <dd>{group}</dd>
      </div>
      {note !== null && (
        <div className="jamat-finalize__fact jamat-finalize__fact--note">
          <dt>Note</dt>
          <dd>{note}</dd>
        </div>
      )}
    </dl>
  )
}

export class FinalizePorts {
  static of(target: TerminalTarget): SessionFinalizePorts {
    if (target.kind === 'local')
      return {
        finalize: (acknowledgeSetup) => AppControl.sessionsDone('sessions.finalize', {
          session: AppControl.sessionOf(target.sessionId),
          ...(acknowledgeSetup === undefined ? {} : { acknowledgeSetup }),
        }),
        finishWorktree: (choice, agreement) => AppControl.sessionsDone('sessions.finishWorktree', {
          session: AppControl.sessionOf(target.sessionId),
          choice,
          ...(agreement.acknowledgeSetup === undefined ? {} : { acknowledgeSetup: agreement.acknowledgeSetup }),
          ...(agreement.confirmWorking === true ? { confirmWorking: true } : {}),
        }),
      }
    else if (target.kind === 'remote')
      return {
        finalize: (acknowledgeSetup) => window.appClient.remote.finalizeSession(
          target.remoteEndpointId,
          target.sessionId,
          acknowledgeSetup,
        ),
        // A peer finishes through `sessions.finalize`: Commit is its only worktree press.
        finishWorktree: (choice, agreement) => {
          if (choice !== 'commit') throw new Error(`A remote finalize ask cannot ${choice} a worktree`)
          return window.appClient.remote.finalizeSession(target.remoteEndpointId, target.sessionId, agreement.acknowledgeSetup)
        },
      }
    else
      throw new Error(`Unknown terminal target: ${JSON.stringify(target)}`)
  }
}

class FinalizeKeys {
  static handle(
    event: React.KeyboardEvent,
    surface: { submit(): void; close(): void },
  ): void {
    if (event.key === 'Tab') return event.preventDefault()
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      return surface.close()
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      surface.submit()
    }
  }
}
