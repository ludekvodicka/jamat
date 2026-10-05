import { useLayoutEffect, useRef } from 'react'

import { DirectoryNotes } from '../../../../shared/directoryNotes'
import type { TerminalNotesModel } from './useTerminalNotes'

import './terminalNotesPanel.css'

/** Draws the Notes model and nothing else: what may be pasted or imported arrives as props. */
export function TerminalNotesPanel(props: {
  model: TerminalNotesModel
  canPaste: boolean
  canImport: boolean
}): React.JSX.Element {
  const model = props.model
  const editors = useRef(new Map<string, HTMLTextAreaElement>())

  useLayoutEffect(() => {
    if (model.focusId !== null) editors.current.get(model.focusId)?.focus()
  }, [model.focusId])

  if (model.phase === 'idle' || model.phase === 'loading')
    return <div className="terminal-notes"><p className="terminal-notes__status">Loading notes…</p></div>
  else if (model.phase === 'failed')
    return (
      <div className="terminal-notes">
        <p className="terminal-notes__error">
          {model.error}{' '}
          <button type="button" onClick={model.retry}>Retry</button>
        </p>
      </div>
    )
  else if (model.phase !== 'ready')
    throw new Error(`Unknown notes phase: ${JSON.stringify(model.phase)}`)

  const single = model.entries.length <= 1
  return (
    <div className="terminal-notes">
      <p className="terminal-notes__scope" title={model.directory ?? ''}>{model.directory}</p>
      {model.error !== null && (
        <p className="terminal-notes__error">
          {model.error}{' '}
          <button type="button" onClick={model.retry}>Retry</button>
        </p>
      )}
      <ol className="terminal-notes__list">
        {model.entries.map((entry, index) => (
          <li key={entry.id} className="terminal-notes__entry">
            <div className="terminal-notes__toolbar">
              <span className="terminal-notes__label">#{index + 1}</span>
              <button
                type="button"
                className="terminal-notes__paste"
                disabled={!props.canPaste || model.importing || entry.text.trim() === ''}
                title={entry.sticky ? 'Paste into the prompt and keep the note' : 'Paste into the prompt and drop the note'}
                aria-label="Paste"
                onClick={() => model.paste(entry.id)}
              >
                <TerminalNotesIcon kind="paste" />
              </button>
              <button
                type="button"
                aria-pressed={entry.sticky}
                disabled={model.importing}
                title="Keep the note after Paste"
                aria-label="Sticky"
                onClick={() => model.toggleSticky(entry.id)}
              >
                <TerminalNotesIcon kind="sticky" />
              </button>
              <button
                type="button"
                aria-pressed={entry.large}
                disabled={model.importing}
                title="Taller editor"
                aria-label="Large"
                onClick={() => model.toggleLarge(entry.id)}
              >
                <TerminalNotesIcon kind="large" />
              </button>
              <button
                type="button"
                className="terminal-notes__remove"
                aria-label={single ? 'Clear note' : 'Remove note'}
                title={single ? 'Clear note' : 'Remove note'}
                disabled={model.importing}
                onClick={() => model.removeOrClear(entry.id)}
              >
                <TerminalNotesIcon kind="remove" />
              </button>
            </div>
            <textarea
              ref={(element) => {
                if (element === null) editors.current.delete(entry.id)
                else editors.current.set(entry.id, element)
              }}
              className={entry.large ? 'terminal-notes__text terminal-notes__text--large' : 'terminal-notes__text'}
              aria-label={`Note ${index + 1}`}
              value={entry.text}
              readOnly={model.importing}
              maxLength={DirectoryNotes.noteCharactersMaxConst}
              spellCheck={false}
              placeholder="Write a note"
              onChange={(event) => model.update(entry.id, event.target.value)}
              onBlur={model.commitNow}
            />
          </li>
        ))}
      </ol>
      <div className="terminal-notes__actions">
        <button
          type="button"
          disabled={model.importing || model.entries.length >= DirectoryNotes.notesMaxConst}
          onClick={model.add}
        >
          + Add note
        </button>
        {props.canImport && (
          <button
            type="button"
            disabled={model.importing}
            title="Save the unsent prompt as a note, then erase it from the prompt"
            onClick={() => { void model.importPrompt() }}
          >
            {model.importing ? 'Importing…' : 'Import from prompt'}
          </button>
        )}
        {model.notice !== null && <span className="terminal-notes__notice" role="status">{model.notice}</span>}
      </div>
    </div>
  )
}

/** Text glyphs draw as colour emoji on Windows, so each control icon is a path in the button's colour. */
function TerminalNotesIcon(props: { kind: 'paste' | 'sticky' | 'large' | 'remove' }): React.JSX.Element {
  if (props.kind === 'sticky')
    return (
      <svg className="terminal-notes__icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M10 1.5 14.5 6l-1.4 1.4-1-.6-2.6 2.6.4 3-1.4 1.4-2.6-2.6L2 15l-1-1 3.8-3.9-2.6-2.6L3.6 6l3 .4 2.6-2.6-.6-1z" />
      </svg>
    )
  else if (props.kind === 'paste')
    return (
      <svg className="terminal-notes__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M5.5 3H3.5v11.5h9V3h-2M6 1.75h4v2.5H6zM6 8h4M6 11h4" />
      </svg>
    )
  else if (props.kind === 'large')
    return (
      <svg className="terminal-notes__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M8 1.75v12.5M4.75 5 8 1.75 11.25 5M4.75 11 8 14.25 11.25 11" />
      </svg>
    )
  else if (props.kind === 'remove')
    return (
      <svg className="terminal-notes__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M2.5 4.25h11M6.25 4.25V2.5h3.5v1.75M4 4.25l.75 10h6.5l.75-10M6.75 7v4.5M9.25 7v4.5" />
      </svg>
    )
  else throw new Error(`Unknown note icon: ${String(props.kind)}`)
}
