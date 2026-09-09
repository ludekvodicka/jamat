import { useEffect, useRef } from 'react'

import { LauncherTime } from '../launcherTime'
import './projects.css'
import { LauncherLabels } from '../launcherLabels'
import type { LauncherInput, LauncherRow, LauncherState } from './launcherModel'
import { LauncherModel } from './launcherModel'

/**
 * The list of projects, and the one thing typed into it: a filter.
 *
 * It renders what the model decided and turns every click into the same input a key produces, which
 * is what keeps the mouse and the keyboard on one code path instead of two that drift. Nothing about
 * acting on a project reaches this file: the four actions are keys named on the card's key line, and
 * what they ask is asked in the card's strip, so no panel is ever drawn between two rows.
 */
export function LauncherProjectsScreen(props: {
  state: LauncherState
  now: number
  dispatch(input: LauncherInput): void
}): React.JSX.Element {
  const { state, dispatch } = props
  const rows = LauncherModel.rowsOf(state)
  const searchResults = LauncherModel.searchResultsOf(state)
  const labelPrefix = LauncherModel.labelPrefixOf(state)
  const listing = state.activeCategoryId === null
    ? null
    : state.search.text.length > 0
      ? LauncherModel.listingOf(state, state.activeCategoryId)
      : LauncherModel.activeListingOf(state)
  const loadError = LauncherModel.loadErrorOf(state)
  const activeCategoryLabel = state.activeCategoryId === null
    ? 'Current folder'
    : LauncherRows.categoryLabel(state, state.activeCategoryId)
  const search = useRef<HTMLInputElement | null>(null)
  // `autoFocus` only fires on mount, and this has to answer every time the filter is opened - Up
  // from the first row opens it, and the field is no use to anybody it does not put the caret in.
  useEffect(() => {
    if (state.search.active)
      search.current?.focus()
  }, [state.search.active])

  const renderRows = (items: readonly LauncherRow[], offset: number) => items.map((row, index) => {
    const globalIndex = offset + index
    return (
      <Row
        key={LauncherRows.keyOf(row, globalIndex)}
        row={row}
        index={globalIndex}
        state={state}
        now={props.now}
        dispatch={dispatch}
      />
    )
  })

  return (
    <div className="jamat-launcher-projects">
      <div className="jamat-launcher-projects__tabs" role="tablist">
        {state.categories.map((category, index) => (
          <button
            key={category.id}
            className={`jamat-launcher-projects__tab${
              category.id === state.activeCategoryId ? ' jamat-launcher-projects__tab--active' : ''}`}
            type="button"
            role="tab"
            aria-selected={category.id === state.activeCategoryId}
            title={category.available ? category.path : `${category.path} (unavailable)`}
            onClick={() => dispatch({ input: 'selectCategory', categoryId: category.id })}
          >
            <span className="jamat-launcher-projects__tab-number">{index + 1}</span>
            {category.label}
            {!category.available && <span className="jamat-launcher-projects__tab-warn">!</span>}
          </button>
        ))}
      </div>

      <input
        ref={search}
        className="jamat-launcher__search"
        type="text"
        aria-label="Filter projects"
        placeholder="filter projects…"
        value={state.search.text}
        // Autofocus only while search is on: with the field holding focus the whole time, a letter
        // could never mean "jump to the project starting with it".
        autoFocus={state.search.active}
        onFocus={() => dispatch({ input: 'searchOpen' })}
        // Whatever took the caret away - the arrow back into the list, a click on a row - the state
        // has to hear about it. Without this the model still believed the field held focus, and the
        // next Up changed nothing, so the effect above never fired and the field was reachable once.
        onBlur={() => dispatch({ input: 'searchLeave' })}
        onChange={(event) => dispatch({ input: 'searchChanged', text: event.target.value })}
      />

      {loadError !== null && (
        <p className="jamat-launcher__error">{loadError}</p>
      )}

      {/* Drawn only inside a folder: at the root the tab above already says where the list is. A
          filter takes it off the screen with it, because the list under it is then flat over every
          category and standing in no folder. */}
      {labelPrefix !== null && state.activeCategoryId !== null && (
        <p className="jamat-launcher-projects__breadcrumb">
          {LauncherLabels.breadcrumbOf(
            LauncherRows.categoryLabel(state, state.activeCategoryId),
            LauncherModel.foldersOf(state),
            labelPrefix,
          )}
          <span className="jamat-launcher-projects__breadcrumb-hint">Backspace leaves</span>
        </p>
      )}

      <div className="jamat-launcher__rows" role="listbox" aria-label="Projects">
        {searchResults === null
          ? renderRows(rows, 0)
          : <>
              <div role="group" aria-label={activeCategoryLabel}>
                {renderRows(searchResults.current, 0)}
              </div>
              {searchResults.other.length > 0 && (
                <div role="group" aria-label="Other folders">
                  <div className="jamat-launcher-projects__other-folders" aria-hidden="true">
                    Other folders
                  </div>
                  {renderRows(searchResults.other, searchResults.current.length)}
                </div>
              )}
              {renderRows(
                rows.slice(searchResults.current.length + searchResults.other.length),
                searchResults.current.length + searchResults.other.length,
              )}
            </>}
      </div>

      {listing?.truncated === true && (
        <p className="jamat-launcher__note">
          The listing was truncated; narrow it with a filter.
        </p>
      )}
    </div>
  )
}

/**
 * The name being typed, in a strip of its own directly above the card's key line.
 *
 * There because that key line is ALREADY this edit's legend when it is open - the footer drops the
 * screen's keys for `Enter Create project` and `Esc Cancel the edit` - and a legend belongs under the
 * thing it describes. The card draws it rather than this screen, because the body scrolls: at the
 * end of a long list the strip would open below the fold, and F7 would look like it did nothing.
 * It says the place itself for the same reason - the tab row and the breadcrumb are both at the far
 * end of the card from here.
 *
 * It borrows the manage panel's classes because it is the same kind of strip, and nothing else: its
 * own key opens it, `state.newProject` alone draws it, Escape cancels it. Inside that panel it was
 * drawn under whichever row the mode was pointed at, which said the new project had something to do
 * with that row, and it went off screen with a mode it did not belong to.
 */
export function NewProjectEdit(props: {
  name: string
  place: string
  onChanged(name: string): void
}): React.JSX.Element {
  return (
    <div className="jamat-launcher-manage jamat-launcher-manage--bar">
      <div className="jamat-launcher-manage__row">
        <span className="jamat-launcher-manage__ask">{`Create project in ${props.place}`}</span>
        <input
          className="jamat-launcher-manage__edit"
          type="text"
          aria-label="New project name"
          autoFocus
          value={props.name}
          onChange={(event) => props.onChanged(event.target.value)}
        />
        {/* No hint of its own: the line directly under it already reads `Enter Create project` and
            `Esc Cancel the edit`, and the same sentence twice, one above the other, is noise. */}
      </div>
    </div>
  )
}

function Row(props: {
  row: LauncherRow
  index: number
  state: LauncherState
  now: number
  dispatch(input: LauncherInput): void
}): React.JSX.Element {
  const { row, index, state, dispatch } = props
  const selected = index === state.cursor
  const element = useRef<HTMLDivElement | null>(null)
  // The list is taller than the card, so the cursor can stand on a row nobody can see: with the
  // arrows, and after a create, which lands the cursor on a name that sorted itself to the end.
  // `nearest` moves the list the least that makes the row visible, and not at all when it is.
  useEffect(() => {
    if (selected)
      element.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div
      ref={element}
      className={`jamat-launcher__row${
        selected ? ' jamat-launcher__row--selected' : ''}`}
      role="option"
      aria-selected={selected}
      // Selecting is a click, activating is a second one. A double click would put opening a project
      // on the same gesture as picking it, and every destructive action lives one keystroke away.
      onClick={() => dispatch({ input: 'setCursor', index })}
      onDoubleClick={() => dispatch({ input: 'openRow', index })}
    >
      <RowContent row={row} state={state} now={props.now} />
    </div>
  )
}

/** What each kind of row puts in the columns. The container above is the same for all of them. */
function RowContent(props: {
  row: LauncherRow
  state: LauncherState
  now: number
}): React.JSX.Element {
  const { row, state } = props

  if (row.kind === 'pickFolder' || row.kind === 'categoryRoot')
    return (
      <span className="jamat-launcher-projects__label">
        <span className="jamat-launcher__name jamat-launcher__name--tail">
          {LauncherRows.tailLabelOf(row)}
        </span>
      </span>
    )
  else if (row.kind === 'virtualFolder')
    return (
      <>
        <span className="jamat-launcher-projects__label">
          <span className="jamat-launcher__name">{`▸ ${row.title}`}</span>
        </span>
        {/* The grid puts this in the column a project row spends on its session count. */}
        <span className="jamat-launcher__meta">{`${row.count} projects`}</span>
      </>
    )
  else if (row.kind === 'project')
    return (
      <>
        <span className="jamat-launcher-projects__label">
          {/* Inside a folder the prefix is the folder, and the folder is the line above the list. */}
          <span className="jamat-launcher__name">
            {LauncherLabels.projectLabelOf(
              row.project.name,
              row.categoryId === state.activeCategoryId ? LauncherModel.labelPrefixOf(state) : null,
            )}
          </span>
          {row.categoryId !== state.activeCategoryId && (
            <span className="jamat-launcher-projects__foreign">
              {LauncherRows.categoryLabel(state, row.categoryId)}
            </span>
          )}
        </span>
        <span className="jamat-launcher__meta">
          {LauncherRows.sessionsOf(state, row.categoryId, row.project.name)}
        </span>
        <span className="jamat-launcher__meta">
          {LauncherTime.agoOf(row.project.lastActivity, props.now)}
        </span>
        <LastAgent state={state} categoryId={row.categoryId} name={row.project.name} />
      </>
    )
  else
    throw new Error(`Unknown launcher row: ${JSON.stringify(row)}`)
}

/** One letter, or nothing at all. A project nobody has run an agent in gets no mark for it. */
function LastAgent(props: {
  state: LauncherState
  categoryId: string
  name: string
}): React.JSX.Element {
  const agent = props.state.summaries
    .get(LauncherModel.summaryKeyOf(props.categoryId, props.name))?.lastAgentId ?? null
  if (agent === null)
    return <span className="jamat-launcher__agent" />
  else if (agent === 'claude')
    return <span className="jamat-launcher__agent jamat-launcher__agent--claude">C</span>
  else if (agent === 'codex')
    return <span className="jamat-launcher__agent jamat-launcher__agent--codex">X</span>
  else
    throw new Error(`Unknown agent: ${JSON.stringify(agent)}`)
}

class LauncherRows {
  /**
   * Empty until the count is known, and only then a number. Drawing a zero for a row nobody has read
   * yet says "no sessions" about a project that may have a hundred.
   */
  static sessionsOf(state: LauncherState, categoryId: string, name: string): string {
    const summary = state.summaries.get(LauncherModel.summaryKeyOf(categoryId, name))
    if (!summary)
      return ''
    return summary.sessionCount === 1 ? '1 session' : `${summary.sessionCount} sessions`
  }

  /**
   * The index only where the row's own facts cannot tell it apart from the one beside it. Two
   * folders may carry the same prefix - the configuration tab warns about that pair and saves it -
   * and two children under one key is a React list that draws one of them. A project row keeps a key
   * made of what it is, so it survives the list being sorted or filtered around it.
   */
  static keyOf(row: LauncherRow, index: number): string {
    if (row.kind === 'project')
      return `project:${row.categoryId}/${row.project.name}`
    else if (row.kind === 'virtualFolder')
      return `folder:${index}:${row.prefix}`
    else if (row.kind === 'pickFolder')
      return 'pickFolder'
    else if (row.kind === 'categoryRoot')
      return 'categoryRoot'
    else
      throw new Error(`Unknown launcher row: ${JSON.stringify(row)}`)
  }

  /** The root row names the category it belongs to: under a filter the list is flat over all of them. */
  static tailLabelOf(row: Extract<LauncherRow, { kind: 'pickFolder' | 'categoryRoot' }>): string {
    if (row.kind === 'pickFolder')
      return 'Pick folder…'
    else if (row.kind === 'categoryRoot')
      return `Root project (${row.label})`
    else
      throw new Error(`Unknown tail row: ${JSON.stringify(row)}`)
  }

  static categoryLabel(state: LauncherState, categoryId: string): string {
    return state.categories.find((category) => category.id === categoryId)?.label ?? categoryId
  }
}
