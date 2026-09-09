import { useEffect, useRef, useState } from 'react'

import { ErrorText } from '../../../shared/errorText'
import type { TerminalTarget } from '../../../shared/terminalTarget'
import { IpcFailure } from '../../ipc/ipcFailure'
import { ChoiceCard, ChoiceRow } from '../../widgets/choiceCards'
import { FinalizeCatalog, type SessionFinalizePorts } from './finalizeCatalog'
import { FinalizeAsks, type FinalizeOpenRequest } from './finalizeModel'
import './finalize.css'

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
  }

  const submit = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    for (const entry of ask.questions) {
      if (completed.current.has(entry.specId)) continue
      const choiceId = chosen.get(entry.specId) ?? entry.question.chosenDefault
      const choice = entry.question.choices.find((candidate) => candidate.id === choiceId)
      if (choice === undefined)
        throw new Error(`Unknown finalize choice: ${JSON.stringify(choiceId)}`)
      if (choice.submitLabel === null) continue
      try {
        const answer = await FinalizeCatalog.byId(entry.specId).perform(choiceId, ports)
        if (!mounted.current) return
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
          submit: () => void submit(),
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
          {ask.questions.map((entry) => (
            <ChoiceRow key={entry.specId} label={entry.question.label} current={false}>
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
          <div className="jamat-finalize__actions">
            <button
              className={`jamat-finalize__button jamat-finalize__button--primary${
                danger ? ' jamat-finalize__button--danger' : ''}`}
              type="button"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? 'Working…' : submitLabel}
            </button>
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

export class FinalizePorts {
  static of(target: TerminalTarget): SessionFinalizePorts {
    if (target.kind === 'local')
      return {
        finalize: () => window.appClient.sessions.finalize(target.sessionId),
        discardWorktree: () => window.appClient.sessions.discardWorktree(target.sessionId),
      }
    else if (target.kind === 'remote')
      return {
        finalize: () => window.appClient.remote.finalizeSession(
          target.remoteEndpointId,
          target.sessionId,
        ),
        discardWorktree: () => {
          throw new Error('A remote finalize ask cannot discard a worktree')
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
