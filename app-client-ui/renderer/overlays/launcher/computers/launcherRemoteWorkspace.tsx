import type { ReactNode } from 'react'

import type { ComputersScreenInput, ComputersScreenState } from './computersScreenModel'
import { ComputersScreenModel } from './computersScreenModel'
import './computers.css'

export function LauncherRemoteWorkspace(props: {
  state: ComputersScreenState
  creating: boolean
  configuring: boolean
  locked: boolean
  dispatch(input: ComputersScreenInput): void
  onSessions(): void
  onProjects(): void
  children: ReactNode
}): React.JSX.Element {
  const { state, dispatch } = props
  const row = state.rows[state.cursor]
  const refusal = ComputersScreenModel.emptyRefusal(state)
  return (
    <div className="jamat-launcher-computers">
      <aside className="jamat-launcher-computers__sidebar" aria-label="Remote computers"
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') return
          event.stopPropagation()
          if (props.locked || !(event.target instanceof HTMLElement)) return
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target.getAttribute('role') === 'option') {
            event.preventDefault()
            const index = Math.max(0, Math.min(state.rows.length - 1, state.cursor + (event.key === 'ArrowDown' ? 1 : -1)))
            dispatch({ input: 'setCursor', index })
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus()
          }
        }}>
        <div className="jamat-launcher-computers__rows" role="listbox" aria-label="Saved computers">
          {state.rows.map((computer, index) => (
            <button key={computer.remoteEndpointId} type="button" role="option"
              aria-selected={index === state.cursor} disabled={props.locked}
              className={`jamat-launcher-computers__computer${index === state.cursor ? ' jamat-launcher-computers__computer--selected' : ''}`}
              onClick={() => dispatch({ input: 'setCursor', index })}>
              <strong>{computer.displayName}</strong>
              <span className="jamat-launcher-computers__endpoint">{computer.endpointLabel}</span>
              <span>{computer.status}</span>
            </button>
          ))}
        </div>
        <button type="button" className="jamat-launcher__start-button" disabled={props.locked}
          onClick={() => dispatch({ input: 'openSettings' })}>Manage computers</button>
      </aside>
      <section className="jamat-launcher-computers__workspace" aria-label="Remote workspace">
        {refusal !== null && <p className="jamat-launcher-computers__empty">{refusal}</p>}
        {row && <>
          <div className="jamat-launcher-computers__heading" onKeyDown={(event) => {
            if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
          }}>
            <strong>{row.displayName}</strong>
            {row.status === 'connected'
              ? <span className="jamat-launcher-computers__connection">Connected</span>
              : <button type="button" className="jamat-launcher__start-button"
                disabled={row.status === 'connecting' || props.locked}
                onClick={() => dispatch({ input: 'activate' })}>
                {row.status === 'connecting' ? 'Connecting…' : 'Connect'}
              </button>}
          </div>
          {row.error && <p role="alert" className="jamat-launcher__note">{row.error}</p>}
          <div className="jamat-launcher-computers__tabs" role="tablist" aria-label="Remote action"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
            }}>
            <button type="button" role="tab" aria-selected={!props.creating} disabled={props.locked}
              onClick={props.onSessions}>Sessions</button>
            <button type="button" role="tab" aria-selected={props.creating}
              disabled={row.status !== 'connected' || props.locked}
              onClick={() => { if (!props.creating) dispatch({ input: 'newSession' }) }}>New session</button>
          </div>
          {props.creating && <div className="jamat-launcher-computers__steps">
            <button type="button" aria-current={props.configuring ? undefined : 'step'} disabled={!props.configuring || props.locked}
              onClick={props.onProjects}>1. Project</button>
            <span aria-hidden="true">›</span>
            <span aria-current={props.configuring ? 'step' : undefined}>2. Parameters</span>
          </div>}
          <div role="tabpanel" aria-label={props.creating ? 'New session' : 'Sessions'} className={`jamat-launcher-computers__content${props.creating ? ' jamat-launcher-computers__content--form' : ''}`}>
            {props.creating || row.status === 'connected'
              ? props.children
              : <p className="jamat-launcher__note">Press Connect to load sessions. This computer is contacted only when you request it.</p>}
          </div>
        </>}
        {state.error && <p role="alert" className="jamat-launcher__note">{state.error}</p>}
      </section>
    </div>
  )
}
