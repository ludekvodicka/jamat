import { useEffect, useRef, useState } from 'react'

import { AppClientUiReport } from '../../../shared/appClientUiReport'
import type { RemarkableErrorCode } from '../../../shared/remarkableApi.types'
import { RemarkableEffects } from './remarkableEffects'
import './remarkable.css'
import {
  type RemarkableInput,
  RemarkableModel,
  type RemarkableOverlayState,
} from './remarkableModel'

export function RemarkableOverlay(props: {
  /** The terminal the card was opened over; where a project-scoped import lands is resolved from it. */
  sessionId: string
  onInsert(path: string): boolean
  onClose(): void
}): React.JSX.Element {
  const card = useRef<HTMLDivElement | null>(null)
  const [start] = useState(() => RemarkableModel.initial())
  const [state, setState] = useState<RemarkableOverlayState>(start.state)
  const stateRef = useRef(start.state)
  const dispatchRef = useRef<(input: RemarkableInput) => void>(() => undefined)
  const insertRef = useRef(props.onInsert)
  const closeRef = useRef(props.onClose)
  insertRef.current = props.onInsert
  closeRef.current = props.onClose

  const [effects] = useState(() => new RemarkableEffects(window.appClient, {
    dispatch: (input) => dispatchRef.current(input),
    insert: (path) => insertRef.current(path),
    close: () => closeRef.current(),
  }, props.sessionId))
  const [dispatch] = useState(() => (input: RemarkableInput): void => {
    const step = RemarkableModel.transition(stateRef.current, input)
    stateRef.current = step.state
    setState(step.state)
    for (const effect of step.effects) void effects.run(effect)
  })
  dispatchRef.current = dispatch

  useEffect(() => {
    for (const effect of start.effects) void effects.run(effect)
    return () => effects.dispose()
  }, [effects, start.effects])

  useEffect(() => {
    const restore = document.activeElement
    card.current?.focus()
    return () => {
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [])

  const outputPath = state.outputPath

  return (
    <div
      className="jamat-remarkable"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dispatch({ input: 'close' })
      }}
    >
      <div
        className="jamat-remarkable__card"
        role="dialog"
        aria-modal="true"
        aria-label="reMarkable"
        tabIndex={-1}
        ref={card}
        onKeyDown={(event) => RemarkableKeys.handle(event, card.current, dispatch)}
      >
        <header className="jamat-remarkable__head">
          <span className="jamat-remarkable__title">reMarkable</span>
          <button
            className="jamat-remarkable__close"
            type="button"
            aria-label="Close reMarkable"
            onClick={() => dispatch({ input: 'close' })}
          >
            ×
          </button>
        </header>
        <div className="jamat-remarkable__body">
          {state.storageNote !== null && (
            <p className="jamat-remarkable__storage-note" role="status">{state.storageNote}</p>
          )}
          <div className="jamat-remarkable__columns">
            <div className="jamat-remarkable__main">
              <fieldset className="jamat-remarkable__sources">
                <legend>Choose a page</legend>
                <label className="jamat-remarkable__source">
                  <input
                    type="radio"
                    name="remarkable-source"
                    checked={state.source === 'current'}
                    disabled={!RemarkableModel.canChooseSource(state)
                      || !RemarkableModel.canUseCurrentPage(state)}
                    onChange={() => dispatch({ input: 'source-selected', source: 'current' })}
                  />
                  <span>
                    <strong>Current page</strong>
                    <small>
                      {RemarkableModel.canUseCurrentPage(state)
                        ? 'The page currently visible on the tablet'
                        : 'The tablet does not say which page is open'}
                    </small>
                  </span>
                </label>
                <label className="jamat-remarkable__source">
                  <input
                    type="radio"
                    name="remarkable-source"
                    checked={state.source === 'listed-page'}
                    disabled={!RemarkableModel.canChooseSource(state)}
                    onChange={() => dispatch({ input: 'source-selected', source: 'listed-page' })}
                  />
                  <span>
                    <strong>Another page</strong>
                    <small>Choose from the document open on the tablet</small>
                  </span>
                </label>
              </fieldset>

              <label className="jamat-remarkable__auto-preview">
                <input
                  type="checkbox"
                  checked={state.autoPreviewOnOpen}
                  disabled={state.phase === 'starting'}
                  onChange={(event) => dispatch({
                    input: 'auto-preview-toggled',
                    enabled: event.currentTarget.checked,
                  })}
                />
                <span>Preview the current page as soon as this opens</span>
              </label>

              {/* The confirm answered instead of the card, so the card has to say what happened. */}
              {state.currentPageRefused && state.phase !== 'failed' && (
                <p className="jamat-remarkable__status" role="status">
                  {RemarkableMessage.instructionOf('no-open-page')}
                </p>
              )}

              {state.source === 'listed-page' && state.pages !== null && (
                <section className="jamat-remarkable__document" aria-label="Open document pages">
                  <h2>{state.pages.documentName}</h2>
                  <div className="jamat-remarkable__pages">
                    {state.pages.pages.map((page) => {
                      const current = page.number === state.pages?.currentPageNumber
                      return (
                        <label className="jamat-remarkable__page" key={page.pageId}>
                          <input
                            type="radio"
                            name="remarkable-page"
                            aria-label={`Page ${page.number}${current ? ', current' : ''}`}
                            checked={state.selectedPageId === page.pageId}
                            disabled={state.phase !== 'ready'}
                            onChange={() => dispatch({ input: 'page-selected', pageId: page.pageId })}
                          />
                          <span className="jamat-remarkable__page-number">Page {page.number}</span>
                          {current && <span className="jamat-remarkable__current">Current</span>}
                          {page.template !== null && (
                            <span className="jamat-remarkable__template">{page.template}</span>
                          )}
                          {page.modified && <span className="jamat-remarkable__modified">Modified</span>}
                        </label>
                      )
                    })}
                  </div>
                </section>
              )}

              <RemarkableStatus state={state} />
            </div>

            <RemarkablePreview state={state} dispatch={dispatch} />
          </div>

          {outputPath !== null && (
            <div className="jamat-remarkable__output" role="alert">
              <p>The page is ready, but the selected terminal could not accept its path.</p>
              <input
                className="jamat-remarkable__path"
                aria-label="Rendered page path"
                value={outputPath}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <button
                className="jamat-remarkable__button"
                type="button"
                onClick={() => void RemarkableCopy.path(outputPath)}
              >
                Copy path
              </button>
            </div>
          )}

          <div className="jamat-remarkable__actions">
            {RemarkableModel.canRetry(state) && (
              <button
                className="jamat-remarkable__button"
                type="button"
                onClick={() => dispatch({ input: 'retry' })}
              >
                Retry
              </button>
            )}
            <button
              className="jamat-remarkable__button jamat-remarkable__button--primary"
              type="button"
              disabled={!RemarkableModel.canConfirm(state)}
              onClick={() => dispatch({ input: 'confirm' })}
            >
              Insert page
            </button>
            <button
              className="jamat-remarkable__button"
              type="button"
              onClick={() => dispatch({ input: 'close' })}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * A picture of the page, never an import. The pane draws the listed page the user picked, because
 * listing already downloaded the document; the tablet's own page costs a device round trip, so that
 * one waits for the button.
 */
function RemarkablePreview(props: {
  state: RemarkableOverlayState
  dispatch(input: RemarkableInput): void
}): React.JSX.Element {
  const { state } = props
  return (
    <aside className="jamat-remarkable__preview" aria-label="Page preview">
      {state.previewPhase === 'ready' && state.preview !== null
        ? (
          <img
            className="jamat-remarkable__preview-image"
            src={`data:image/png;base64,${state.preview.pngBase64}`}
            width={state.preview.width}
            height={state.preview.height}
            alt={`Preview of page ${state.preview.pageNumber}`}
          />
        )
        : <RemarkablePreviewNote state={state} dispatch={props.dispatch} />}
    </aside>
  )
}

function RemarkablePreviewNote(props: {
  state: RemarkableOverlayState
  dispatch(input: RemarkableInput): void
}): React.JSX.Element {
  const { state } = props
  if (state.previewPhase === 'loading')
    return <p className="jamat-remarkable__preview-note">Rendering preview…</p>
  else if (state.previewPhase === 'failed' && state.previewFailure !== null)
    return (
      <div className="jamat-remarkable__preview-note">
        <p>{RemarkableMessage.instructionOf(state.previewFailure.code)}</p>
        <p className="jamat-remarkable__detail">{state.previewFailure.detail}</p>
        <button
          className="jamat-remarkable__button"
          type="button"
          disabled={state.phase !== 'ready'}
          onClick={() => props.dispatch({ input: 'preview-requested' })}
        >
          Try again
        </button>
      </div>
    )
  else if (state.source === 'listed-page')
    return <p className="jamat-remarkable__preview-note">Choose a page to see it here.</p>
  else return (
    <div className="jamat-remarkable__preview-note">
      <p>The tablet has to send the page before it can be shown.</p>
      <button
        className="jamat-remarkable__button"
        type="button"
        disabled={state.phase !== 'ready' || !RemarkableModel.canUseCurrentPage(state)}
        onClick={() => props.dispatch({ input: 'preview-requested' })}
      >
        Preview current page
      </button>
    </div>
  )
}

function RemarkableStatus(props: { state: RemarkableOverlayState }): React.JSX.Element | null {
  if (props.state.phase === 'starting')
    return <p className="jamat-remarkable__status" role="status">Preparing reMarkable…</p>
  else if (props.state.phase === 'loading-pages')
    return <p className="jamat-remarkable__status" role="status">Downloading open document…</p>
  else if (props.state.phase === 'rendering')
    return <p className="jamat-remarkable__status" role="status">Downloading and rendering page…</p>
  else if (props.state.phase === 'failed' && props.state.failure !== null)
    return (
      <div className="jamat-remarkable__error" role="alert">
        <p>{RemarkableMessage.instructionOf(props.state.failure.code)}</p>
        <p className="jamat-remarkable__detail">{props.state.failure.detail}</p>
      </div>
    )
  else if (props.state.phase === 'ready'
    || props.state.phase === 'output-ready') return null
  else throw new Error(`Unknown reMarkable phase: ${JSON.stringify(props.state.phase)}`)
}

class RemarkableMessage {
  static instructionOf(code: RemarkableErrorCode): string {
    if (code === 'device-sleeping')
      return 'Wake the tablet, keep it awake and lift the pen, then retry.'
    else if (code === 'device-busy')
      return 'Another reMarkable operation holds the device lock. Wait for it to finish, then retry.'
    else if (code === 'nothing-open')
      return 'Open a document on the tablet and leave the page visible.'
    else if (code === 'no-open-page')
      return 'The tablet is not showing a page. Wake it, or choose one from the list.'
    else if (code === 'host-key-changed')
      return 'The tablet fingerprint changed. Detect and explicitly save it again in Settings.'
    else if (code === 'web-interface-unavailable')
      return 'Enable Web Interface in the tablet storage settings, then try again.'
    else if (code === 'settings-incomplete')
      return 'Finish the reMarkable host and fingerprint setup in Settings.'
    else if (code === 'password-missing')
      return 'Set the reMarkable password in Settings before importing a page.'
    else if (code === 'credential-unavailable')
      return 'Secure credential storage is unavailable. Check the reMarkable settings.'
    else if (code === 'sidecar-not-installed')
      return 'Install the reMarkable dependencies in Settings before importing a page.'
    else if (code === 'sidecar-damaged')
      return 'Repair the reMarkable dependencies in Settings before trying again.'
    else if (code === 'import-failed')
      return 'The page could not be written to the storage folder. Check it in Settings.'
    else if (code === 'install-failed')
      return 'The reMarkable dependencies could not be installed. Open Settings for details.'
    else if (code === 'unsupported-platform')
      return 'This computer cannot run the bundled reMarkable tools.'
    else if (code === 'timeout')
      return 'The tablet did not answer in time. Wake it and try again.'
    else if (code === 'invalid-cli-output')
      return 'The reMarkable tools returned an invalid page, so nothing was inserted.'
    else if (code === 'invalid-operation')
      return 'This reMarkable request is no longer valid. Close this dialog and open it again.'
    else if (code === 'cancelled') return 'The reMarkable operation was cancelled.'
    else if (code === 'cli-failed')
      return 'The reMarkable tools failed. Check the setup and try again.'
    else {
      const unhandled: never = code
      throw new Error(`Unknown reMarkable error code: ${JSON.stringify(unhandled)}`)
    }
  }
}

class RemarkableKeys {
  private static readonly focusableConst = 'button:not([disabled]), input:not([disabled]), '
    + '[href], [tabindex]:not([tabindex="-1"])'

  static handle(
    event: React.KeyboardEvent,
    card: HTMLElement | null,
    dispatch: (input: RemarkableInput) => void,
  ): void {
    if (event.key === 'Tab') {
      if (card !== null) RemarkableKeys.trap(event, card)
      return
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch({ input: 'close' })
    }
  }

  private static trap(event: React.KeyboardEvent, card: HTMLElement): void {
    const focusable = [...card.querySelectorAll<HTMLElement>(RemarkableKeys.focusableConst)]
    if (focusable.length === 0) return event.preventDefault()
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === card)) {
      event.preventDefault()
      last.focus()
    }
    else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
}

class RemarkableCopy {
  static async path(path: string): Promise<void> {
    try {
      const answer = await window.appClient.clipboard.writeText(path)
      if (!answer.ok) AppClientUiReport.error(`Copying the reMarkable path failed: ${answer.error}`)
    } catch {
      AppClientUiReport.error('Copying the reMarkable path failed: the clipboard did not answer')
    }
  }
}
