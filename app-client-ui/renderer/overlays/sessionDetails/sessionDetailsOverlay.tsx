import { useEffect, useRef, useState } from 'react'

import type {
  SessionColorName,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionLimits } from '../../../../lib-orchestrator/sessionManager/sessionLimits'
import { AppClientUiReport } from '../../../shared/appClientUiReport'
import { IpcFailure } from '../../ipc/ipcFailure'
import type { SnapshotStore } from '../../ipc/snapshotStore'
import type { TerminalInputRegistry } from '../../shell/terminalInputRegistry'
import { SessionPalette } from '../../../shared/sessionPalette'
import './sessionDetails.css'
import {
  type SessionDetailsBaseline,
  type SessionDetailsDraft,
  SessionDetailsModel,
  type SessionDetailsOpenRequest,
} from './sessionDetailsModel'

/**
 * The third overlay of this shell, and the same shape as the other two: no registry key, nothing
 * serialized into a saved layout, gone after a restart. A half-typed rename is not work a restart
 * should resurrect, which is why this is not a panel.
 *
 * The card captures its session ONCE, when it opens - like the tab menu captures its facts - and
 * Save is its only boundary to the main process. A refusal keeps the card open with the reason on
 * it; a success closes it, after the one provider write that is the renderer's to make: typing
 * `/rename` into a live Codex terminal, the same way the Compact button types `/compact`.
 */
export function SessionDetailsOverlay(props: {
  request: SessionDetailsOpenRequest
  snapshot: SnapshotStore<SessionsSnapshot>
  inputs: TerminalInputRegistry
  onClose(): void
}): React.JSX.Element | null {
  const name = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  const [baseline] = useState<SessionDetailsBaseline | null>(() => {
    const info = props.snapshot.current().snapshot?.sessions
      .find((session) => session.sessionId === props.request.sessionId)
    return info === undefined ? null : SessionDetailsModel.baselineOf(info)
  })
  const [draft, setDraft] = useState<SessionDetailsDraft>(() => (baseline === null
    ? { name: '', note: '', color: null }
    : { name: baseline.name, note: baseline.note, color: baseline.color }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A session gone between the menu and the click has nothing to edit, so the card never opens.
  useEffect(() => {
    if (baseline === null) closeRef.current()
  }, [baseline])

  // Whoever had focus gets it back when the card goes. The caret lands in the name with the text
  // selected, because renaming is what the menu item says this card is for.
  useEffect(() => {
    if (baseline === null) return
    const restore = document.activeElement
    name.current?.focus()
    name.current?.select()
    return () => {
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [baseline])

  if (baseline === null) return null

  const close = (): void => {
    if (!saving) props.onClose()
  }

  const save = async (): Promise<void> => {
    if (saving) return
    const update = SessionDetailsModel.updateOf(baseline, draft)
    if (update === null) {
      props.onClose()
      return
    }
    setSaving(true)
    const answer = await window.appClient.sessions.setDetails(baseline.sessionId, update)
    // ONE branch for both refusals, the channel's and the library's: `IpcFailure.of` reads them
    // both, and a failed answer always carries a reason - the fallback is for the type alone.
    if (!answer.ok || !answer.value.ok) {
      setError(IpcFailure.of(answer) ?? 'The save was refused with no reason')
      setSaving(false)
      return
    }
    // What the library says is still owed to the agent. Whether there is anything, and what it
    // says, are questions about the record; this surface writes keystrokes and reports when it
    // has nowhere to write them.
    const notice = answer.value.value.notifyAgent
    /*
     * The save landed; the keystrokes may not have. `TerminalInputRegistry.submit` writes to a panel
     * in THIS document, so it answers false whenever this session has no tab open here - and the
     * card does not open one. Until 2026-08-21 that went to `console.error`, so the card closed on
     * what looked like a clean save while Codex kept the old name in its own index.
     *
     * The card stays open instead, saying which half did not happen. Closing it is the person's,
     * and the sentence has to survive being read after the fact: it says the save is done.
     */
    if (notice !== null && !props.inputs.submit(baseline.sessionId, notice.text)) {
      setError(
        'Saved. Codex was not told the new name: this session has no terminal open in this window. '
        + 'Open its tab and type the rename there, or rename it again from that window.',
      )
      setSaving(false)
      return
    }
    props.onClose()
  }

  return (
    <div
      className="jamat-session-details"
      // The backdrop closes and the card does not, so the press must have landed on the backdrop
      // itself. mousedown rather than click: a drag that starts inside the card and ends outside it
      // is a text selection, not a request to close. Not while a save is in flight.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        className="jamat-session-details__card"
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        tabIndex={-1}
        // The only keydown of this surface, and it is on the card. A second listener on the
        // document is how V1 ran every command twice.
        onKeyDown={(event) => SessionDetailsKeys.handle(event, { save: () => void save(), close })}
      >
        <header className="jamat-session-details__head">
          <span className="jamat-session-details__title">Session details</span>
          <button
            className="jamat-session-details__close"
            type="button"
            aria-label="Close Session details"
            onClick={close}
          >
            ×
          </button>
        </header>
        <div className="jamat-session-details__body">
          <label className="jamat-session-details__field">
            <span className="jamat-session-details__label">Name</span>
            <span className="jamat-session-details__name-row">
              {baseline.numberChip !== null && (
                <span className="jamat-session-details__chip">{baseline.numberChip}</span>
              )}
              <input
                ref={name}
                className="jamat-session-details__name"
                type="text"
                aria-label="Session name"
                spellCheck={false}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </span>
          </label>
          <label className="jamat-session-details__field">
            <span className="jamat-session-details__label">Note</span>
            <textarea
              className="jamat-session-details__note"
              aria-label="Session note"
              placeholder="What is this session about?"
              maxLength={SessionLimits.noteCharacters}
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
          </label>
          <div className="jamat-session-details__field">
            <span className="jamat-session-details__label">Color</span>
            <div className="jamat-session-details__swatches">
              {SessionDetailsSwatches.choicesConst.map((choice) => (
                <button
                  key={choice ?? 'none'}
                  className={SessionDetailsSwatches.classOf(choice, draft.color)}
                  type="button"
                  title={SessionPalette.labelOf(choice)}
                  aria-label={SessionPalette.labelOf(choice)}
                  aria-pressed={draft.color === choice}
                  onClick={() => setDraft({ ...draft, color: choice })}
                />
              ))}
            </div>
          </div>
          <p className="jamat-session-details__hint">
            The note and the colour stay in Jamat. The name is passed on to the agent.
          </p>
          <div className="jamat-session-details__meta">
            <span className="jamat-session-details__meta-label">Session ID</span>
            <span className="jamat-session-details__meta-value jamat-session-details__meta-value--mono">
              {baseline.displaySessionId}
              <button
                className="jamat-session-details__copy"
                type="button"
                onClick={() => void SessionDetailsCopy.copy(baseline.displaySessionId)}
              >
                Copy
              </button>
            </span>
            <span className="jamat-session-details__meta-label">Project</span>
            <span className="jamat-session-details__meta-value">{baseline.projectLabel}</span>
            <span className="jamat-session-details__meta-label">Folder</span>
            <span className="jamat-session-details__meta-value jamat-session-details__meta-value--mono">
              {baseline.folderPath ?? 'Default'}
            </span>
            <span className="jamat-session-details__meta-label">Agent</span>
            <span className="jamat-session-details__meta-value">{baseline.agentLabel}</span>
          </div>
          {error !== null && (
            <p className="jamat-session-details__error" role="alert">{error}</p>
          )}
          <div className="jamat-session-details__actions">
            <button
              className="jamat-session-details__button jamat-session-details__button--primary"
              type="button"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              className="jamat-session-details__button"
              type="button"
              disabled={saving}
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

class SessionDetailsSwatches {
  /** None first, then the twelve the library names - the same row the colour submenu offers. */
  static readonly choicesConst: readonly (SessionColorName | null)[] =
    [null, ...SessionPalette.namesConst]

  static classOf(choice: SessionColorName | null, current: SessionColorName | null): string {
    const base = choice === null
      ? 'jamat-session-details__swatch jamat-session-details__swatch--none'
      : `jamat-session-details__swatch jamat-session-details__swatch--${choice}`
    return choice === current ? `${base} is-current` : base
  }
}

class SessionDetailsKeys {
  /**
   * Escape and Enter belong to the surface wherever focus sits. Enter saves from the name and
   * Ctrl+Enter from the note, where a plain Enter is a newline being typed. Tab is swallowed, not
   * trapped - the launcher's rule: it must never take focus out of an overlay the user cannot see
   * they have left. `close` and `save` guard the in-flight save themselves.
   */
  static handle(
    event: React.KeyboardEvent,
    surface: { save(): void; close(): void },
  ): void {
    if (event.key === 'Tab') return event.preventDefault()
    if (event.key === 'Enter' && event.target instanceof HTMLTextAreaElement) {
      if (!event.ctrlKey) return
      event.preventDefault()
      return surface.save()
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      return surface.close()
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault()
      surface.save()
    }
  }
}

class SessionDetailsCopy {
  /** A copy that failed says so in the console; the card has no room for a sentence about it. */
  static async copy(text: string): Promise<void> {
    const written = await window.appClient.clipboard.writeText(text)
    if (!written.ok)
      AppClientUiReport.error(`Copying the session id failed: ${written.error}`)
  }
}
