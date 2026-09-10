import { useEffect, useRef } from 'react'

import { AgentGlyph } from '../../../sessions/agentGlyph'
import { LauncherTime } from '../launcherTime'
import type {
  CreateScreenInput,
  CreateScreenState,
  ExistingRow,
} from './createScreenModel'
import { CreateScreenModel } from './createScreenModel'

/**
 * The Continue list. What fills it depends on which computer the card is aimed at - this machine's
 * provider conversations, or the sessions the target computer keeps - and the model hands both over
 * as the same row, because the list itself is one thing: a cursor, a scroll and an empty state.
 */
export function ExistingSessions(props: {
  state: CreateScreenState
  now: number
  dispatch(input: CreateScreenInput): void
}): React.JSX.Element {
  const rows = CreateScreenModel.existingDisplayRowsOf(props.state)
  const loaded = CreateScreenModel.existingLoaded(props.state)
  const emptyMessage = CreateScreenModel.existingEmptyMessage(props.state)
  return (
    <>
      {props.state.existingSessionsError !== null && (
        <p className="jamat-launcher-create__sessions-error">
          {props.state.existingSessionsError}
        </p>
      )}
      <div
        className="jamat-launcher-create__sessions"
        role="listbox"
        aria-label="Existing sessions"
      >
        {rows.map((row, index) => (
          <ExistingSessionRow
            key={row.key}
            row={row}
            index={index}
            selected={index === props.state.existingCursor}
            now={props.now}
            dispatch={props.dispatch}
          />
        ))}
        {!loaded && (
          <p className="jamat-launcher-create__sessions-empty">Loading sessions…</p>
        )}
        {emptyMessage !== null && (
          <p className="jamat-launcher-create__sessions-empty">{emptyMessage}</p>
        )}
      </div>
    </>
  )
}

function ExistingSessionRow(props: {
  row: ExistingRow
  index: number
  selected: boolean
  now: number
  dispatch(input: CreateScreenInput): void
}): React.JSX.Element {
  const { row, index, selected, dispatch } = props
  const element = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (selected) element.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div
      ref={element}
      className={`jamat-launcher__row jamat-launcher-create__session-row${
        selected ? ' jamat-launcher__row--selected' : ''}`}
      role="option"
      aria-selected={selected}
      onClick={() => dispatch({ input: 'setExistingCursor', index })}
      onDoubleClick={() => dispatch({ input: 'activate' })}
    >
      <span
        className={`jamat-launcher__name${
          row.untitled ? ' jamat-launcher-create__session-untitled' : ''}`}
      >
        {row.label}
        {row.mark !== null && (
          <span className="jamat-launcher-create__session-mark">{row.mark}</span>
        )}
      </span>
      {row.active
        ? (
            <span
              className="jamat-launcher-create__session-live"
              title="Running now"
              aria-label="Running now"
            />
          )
        : <span />}
      <span className="jamat-launcher__meta jamat-launcher-create__session-time">
        {row.times === null
          ? <span />
          : (
              <>
                <span>{LauncherTime.agoOf(row.times.lastActivity, props.now)}</span>
                <span>{`(${LauncherTime.ageOf(row.times.createdAt, props.now)} old)`}</span>
              </>
            )}
      </span>
      {row.agentId === null
        ? <span />
        : (
            <span className={`jamat-launcher__agent jamat-launcher__agent--${row.agentId}`}>
              {AgentGlyph.markOf(row.agentId)}
            </span>
          )}
    </div>
  )
}
