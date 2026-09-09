import { useEffect, useRef } from 'react'

import './computers.css'
import type {
  ComputerRow,
  ComputersScreenInput,
  ComputersScreenState,
} from './computersScreenModel'
import { ComputersScreenModel } from './computersScreenModel'

/**
 * The remote profile's first screen: which computer this card is about.
 *
 * It draws the connected computers and nothing else. A computer that is paired but not reachable is
 * deliberately absent rather than greyed out, so the empty state carries the way to the one place
 * that says why - the settings card - instead of leaving somebody looking at a list that is short
 * for a reason it does not give.
 */
export function LauncherComputersScreen(props: {
  state: ComputersScreenState
  dispatch(input: ComputersScreenInput): void
}): React.JSX.Element {
  const { state, dispatch } = props
  const refusal = ComputersScreenModel.emptyRefusal(state)
  /*
   * Nothing is dialled until something asks. This screen is what asks on behalf of a person about
   * to start a session somewhere else, and it lets go the moment the card leaves it - otherwise
   * the first remote session could never be started, because the list only ever draws computers
   * that are connected.
   */
  useEffect(() => {
    void window.appClient.remote.hold('launcher-computers')
    return () => { void window.appClient.remote.release('launcher-computers') }
  }, [])
  return (
    <div className="jamat-launcher-computers">
      <div
        className="jamat-launcher-computers__rows"
        role="listbox"
        aria-label="Connected computers"
      >
        {state.rows.map((row, index) => (
          <ComputerListRow
            key={ComputersScreenModel.rowKeyOf(row)}
            row={row}
            index={index}
            selected={index === state.cursor}
            dispatch={dispatch}
          />
        ))}
      </div>
      {refusal !== null && (
        <div className="jamat-launcher-computers__empty">
          <p className="jamat-launcher__note">{refusal}</p>
          {state.loaded && (
            <button
              className="jamat-launcher__start-button"
              type="button"
              onClick={() => dispatch({ input: 'openSettings' })}
            >
              Open Remote connections settings
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function ComputerListRow(props: {
  row: ComputerRow
  index: number
  selected: boolean
  dispatch(input: ComputersScreenInput): void
}): React.JSX.Element {
  const { row, index, selected, dispatch } = props
  const element = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (selected) element.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  return (
    <div
      ref={element}
      className={`jamat-launcher__row${selected ? ' jamat-launcher__row--selected' : ''}`}
      role="option"
      aria-selected={selected}
      onClick={() => dispatch({ input: 'setCursor', index })}
      onDoubleClick={() => dispatch({ input: 'openRow', index })}
    >
      <span className="jamat-launcher__name">{row.displayName}</span>
      <span className="jamat-launcher__meta jamat-launcher-computers__endpoint">
        {row.endpointLabel}
      </span>
      <span className="jamat-launcher__meta">
        {row.sessionCount === null
          ? ''
          : `${row.sessionCount} ${row.sessionCount === 1 ? 'session' : 'sessions'}`}
      </span>
      <span />
    </div>
  )
}
