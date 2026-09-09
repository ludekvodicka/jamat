import { useLayoutEffect, useRef, useState } from 'react'
import { SessionsFilterState, type SavedSessionsFilter, type SessionsFilterValue } from '../../../shared/sessionsFilterState'
import type { ContextMenuPosition } from '../../widgets/contextMenu'

export function SessionsSavedFilters(props: {
  saved: readonly SavedSessionsFilter[]
  filters: SessionsFilterValue
  filterText: string
  naming: boolean
  saving: boolean
  onReset(): void
  onApply(saved: SavedSessionsFilter): void
  onMenu(id: string, position: ContextMenuPosition): void
  onSave(name: string): void
  onCancel(): void
}): React.JSX.Element {
  return <>
    {props.saved.length > 0 && <div className="jamat-sessions__chips" role="group" aria-label="Saved session filters">
      <button type="button" className="jamat-sessions__chip"
        aria-pressed={SessionsFilterState.isAll(props.filters, props.filterText)}
        onClick={props.onReset}
        onContextMenu={(event) => { event.preventDefault(); props.onReset() }}
      >All</button>
      {props.saved.map((saved) => <button key={saved.id} type="button" className="jamat-sessions__chip" title={saved.name}
        aria-pressed={SessionsFilterState.equal(saved.filters, props.filters) && saved.filterText === props.filterText}
        onClick={() => props.onApply(saved)}
        onContextMenu={(event) => {
          event.preventDefault()
          props.onMenu(saved.id, { x: event.clientX, y: event.clientY })
        }}
      >{saved.name}</button>)}
    </div>}
    {props.naming && <SaveFilterName saved={props.saved} saving={props.saving} onSave={props.onSave} onCancel={props.onCancel} />}
  </>
}

function SaveFilterName(props: {
  saved: readonly SavedSessionsFilter[]
  saving: boolean
  onSave(name: string): void
  onCancel(): void
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const error = SessionsFilterState.nameError(name.trim(), props.saved)
  useLayoutEffect(() => { input.current?.focus() }, [])

  return <form className="jamat-sessions__save-filter" aria-label="Save session filter"
    onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && !props.saving) props.onCancel()
    }}
    onSubmit={(event) => {
      event.preventDefault()
      setSubmitted(true)
      if (error === null && !props.saving) props.onSave(name.trim())
    }}
  >
    <input ref={input} className="jamat-sessions__filter" aria-label="Filter name" placeholder="Filter name"
      value={name} maxLength={SessionsFilterState.nameLengthMaxConst} disabled={props.saving}
      onChange={(event) => setName(event.target.value)} />
    <div className="jamat-sessions__save-filter-actions">
      <button className="jamat-sessions__foot-button" type="submit" disabled={props.saving}>Save</button>
      <button className="jamat-sessions__foot-button" type="button" disabled={props.saving} onClick={props.onCancel}>Cancel</button>
    </div>
    {submitted && error !== null && <p className="jamat-sessions__error" role="alert">{error}</p>}
  </form>
}
