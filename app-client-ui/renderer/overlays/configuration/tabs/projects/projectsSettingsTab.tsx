import { useEffect, useRef, useState } from 'react'

import type { CatalogCategoryDto } from '../../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './projectsSettings.css'
import { ProjectsSettingsEffects, type ProjectsSettingsPorts } from './projectsSettingsEffects'
import {
  ProjectsSettingsModel,
  type ProjectsSettingsQuestion,
  type ProjectsSettingsState,
} from './projectsSettingsModel'

/**
 * The roots of the project catalog: add one, name it, order it, take it away.
 *
 * It saves itself, and only when the Save button is pressed. Leaving the group or closing the card
 * discards - the window asks that question and this tab answers only the part of it it owns, which
 * is whether there is anything to lose. Order is the order of the list, because the order of
 * `categories` in the file already drives the launcher's tabs and its 1-9 keys.
 */
export function ProjectsSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => ProjectsSettingsModel.initial())
  const [state, setState] = useState<ProjectsSettingsState>(start.state)
  // Read through a ref rather than through the rendered state: a load answering while an edit is in
  // flight has to see what the edit decided, not what React has drawn.
  const stateRef = useRef<ProjectsSettingsState>(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange

  const [ports] = useState<ProjectsSettingsPorts>(() => {
    const self: ProjectsSettingsPorts = {
      dispatch: (input) => {
        const step = ProjectsSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        // The one fact the window is told, and only when it changes: it draws a mark and it asks
        // before leaving, and both are about whether anything would be lost.
        const modified = ProjectsSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void ProjectsSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void ProjectsSettingsEffects.run(effect, ports)
  }, [start, ports])

  const categories = ProjectsSettingsModel.categoriesOf(state)
  return (
    <div className="jamat-configuration-projects">
      {state.staleOnDisk && (
        <p className="jamat-configuration-projects__banner" role="status">
          config.json changed on disk while you were editing. Saving replaces every root it holds;
          nothing here merges the two.
          <button
            className="jamat-configuration__button"
            type="button"
            onClick={() => ports.dispatch({ input: 'reload-requested' })}
          >
            Reload from disk
          </button>
        </p>
      )}
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      <ConfigurationSection title="Project roots">
        {state.buffer === null
          ? <p className="jamat-configuration-projects__note">Reading config.json…</p>
          : (
              <>
                {categories.length === 0 && (
                  <p className="jamat-configuration-projects__note">
                    No roots yet. The launcher lists what is here, so until a root is added it has
                    nothing to show.
                  </p>
                )}
                <ul className="jamat-configuration-projects__rows">
                  {categories.map((category, index) => (
                    <ProjectsSettingsRow
                      category={category}
                      expanded={state.expanded.has(category.id)}
                      first={index === 0}
                      key={category.id}
                      last={index === categories.length - 1}
                      ports={ports}
                    />
                  ))}
                </ul>
              </>
            )}
      </ConfigurationSection>
      <div className="jamat-configuration__actions">
        {/* With no document there is nothing to add a root to, and the picked path would vanish. */}
        <button
          className="jamat-configuration__button"
          disabled={state.buffer === null}
          type="button"
          onClick={() => ports.dispatch({ input: 'add-requested' })}
        >
          Add root…
        </button>
        {/* Enabled with nothing loaded on purpose: after a read that failed, this is the retry. */}
        <button
          className="jamat-configuration__button"
          disabled={state.saving !== null || state.reloading}
          type="button"
          onClick={() => ports.dispatch({ input: 'reload-requested' })}
        >
          Reload
        </button>
        {/* Disabled on an unsavable folder as well: the store refuses one without both halves, and
            a Save that can only come back as invalid-config is a button that lies. */}
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          disabled={!ProjectsSettingsModel.isModified(state)
            || state.saving !== null
            || !ProjectsSettingsModel.isSavable(state)}
          type="button"
          onClick={() => ports.dispatch({ input: 'save' })}
        >
          {state.saving !== null ? 'Saving…' : 'Save'}
        </button>
      </div>
      {state.asking !== null && (
        <div
          className="jamat-configuration-projects__ask"
          role="alertdialog"
          aria-label={ProjectsSettingsAsk.titleOf(state.asking)}
        >
          <p className="jamat-configuration-projects__ask-text">
            {ProjectsSettingsAsk.textOf(state.asking, categories)}
          </p>
          <div className="jamat-configuration-projects__ask-buttons">
            <button
              className="jamat-configuration__button"
              type="button"
              onClick={() => ports.dispatch({ input: 'answered', yes: false })}
            >
              Keep editing
            </button>
            <button
              className="jamat-configuration__button jamat-configuration__button--danger"
              type="button"
              onClick={() => ports.dispatch({ input: 'answered', yes: true })}
            >
              {ProjectsSettingsAsk.confirmOf(state.asking)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** What each question says. Both cost the user something the file cannot show them afterwards. */
class ProjectsSettingsAsk {
  static titleOf(asking: ProjectsSettingsQuestion): string {
    if (asking.ask === 'remove') return 'Remove root'
    else if (asking.ask === 'discard-and-reload') return 'Discard changes'
    else
      throw new Error(`Unknown projects settings question: ${JSON.stringify(asking)}`)
  }

  static confirmOf(asking: ProjectsSettingsQuestion): string {
    if (asking.ask === 'remove') return 'Remove root'
    else if (asking.ask === 'discard-and-reload') return 'Discard and reload'
    else
      throw new Error(`Unknown projects settings question: ${JSON.stringify(asking)}`)
  }

  static textOf(
    asking: ProjectsSettingsQuestion,
    categories: readonly CatalogCategoryDto[],
  ): string {
    if (asking.ask === 'remove') {
      const name = categories.find((category) => category.id === asking.id)?.label ?? asking.id
      return `Removing ${name} deletes nothing on disk. It takes the root out of the catalog, and `
        + `everything bound to ${asking.id} - sessions, projects, the launcher's keys - stops `
        + 'resolving once this is saved.'
    }
    else if (asking.ask === 'discard-and-reload')
      return 'Reading config.json back takes every change on this screen away. Nothing here has '
        + 'been written yet.'
    else
      throw new Error(`Unknown projects settings question: ${JSON.stringify(asking)}`)
  }
}

/** One root. The path is shown and not edited: it comes from the picker, which the OS owns. */
function ProjectsSettingsRow(props: {
  category: CatalogCategoryDto
  expanded: boolean
  first: boolean
  last: boolean
  ports: ProjectsSettingsPorts
}): React.JSX.Element {
  const { category, ports } = props
  return (
    <li className="jamat-configuration-projects__entry">
      <div className="jamat-configuration-projects__row">
        <input
          className="jamat-configuration-projects__label"
          value={category.label}
          aria-label={`Name of ${category.path}`}
          onChange={(event) =>
            ports.dispatch({ input: 'rename', id: category.id, label: event.target.value })}
        />
        <span className="jamat-configuration-projects__path" title={category.path}>
          {category.path}
        </span>
        <button
          className="jamat-configuration__button"
          disabled={props.first}
          type="button"
          aria-label={`Move ${category.label} up`}
          onClick={() => ports.dispatch({ input: 'move', id: category.id, delta: -1 })}
        >
          ↑
        </button>
        <button
          className="jamat-configuration__button"
          disabled={props.last}
          type="button"
          aria-label={`Move ${category.label} down`}
          onClick={() => ports.dispatch({ input: 'move', id: category.id, delta: 1 })}
        >
          ↓
        </button>
        <button
          className="jamat-configuration__button"
          type="button"
          aria-label={`Remove ${category.label}`}
          onClick={() => ports.dispatch({ input: 'remove', id: category.id })}
        >
          Remove
        </button>
      </div>
      <ProjectsSettingsFolders
        category={category}
        expanded={props.expanded}
        ports={ports}
      />
    </li>
  )
}

/**
 * The virtual folders of one root: a display grouping by name prefix, with no directory behind it.
 *
 * Collapsed by default and counted on the summary line, because most roots have none and the ones
 * that do are read far more often than they are edited.
 */
function ProjectsSettingsFolders(props: {
  category: CatalogCategoryDto
  expanded: boolean
  ports: ProjectsSettingsPorts
}): React.JSX.Element {
  const { category, ports } = props
  const folders = ProjectsSettingsModel.foldersOf(category)
  const problems = ProjectsSettingsModel.folderProblemsOf(category)
  return (
    <div className="jamat-configuration-projects__folders">
      <button
        className="jamat-configuration-projects__folders-toggle"
        type="button"
        aria-expanded={props.expanded}
        onClick={() => ports.dispatch({ input: 'folders-toggled', id: category.id })}
      >
        {`${props.expanded ? '▾' : '▸'} Virtual folders (${folders.length})`}
      </button>
      {props.expanded && (
        <>
          {folders.length === 0 && (
            <p className="jamat-configuration-projects__note">
              A folder groups the projects of this root whose name starts with its prefix.
              {' '}
              <code>house</code>
              {' groups '}
              <code>houseBazen</code>
              {' but not '}
              <code>housebazen</code>
              {'; a prefix ending in - or _ matches without the capital letter.'}
            </p>
          )}
          {folders.map((folder, index) => (
            <div className="jamat-configuration-projects__folder" key={index}>
              <input
                className="jamat-configuration-projects__prefix"
                value={folder.prefix}
                placeholder="prefix"
                aria-label={`Prefix of folder ${index + 1} in ${category.label}`}
                onChange={(event) => ports.dispatch({
                  input: 'folder-changed',
                  id: category.id,
                  index,
                  field: 'prefix',
                  value: event.target.value,
                })}
              />
              {/* Its own class, not the root's: a test that reads every root name off the screen
                  must not pick up folder names too. */}
              <input
                className="jamat-configuration-projects__folder-title"
                value={folder.title}
                placeholder="name"
                aria-label={`Name of folder ${index + 1} in ${category.label}`}
                onChange={(event) => ports.dispatch({
                  input: 'folder-changed',
                  id: category.id,
                  index,
                  field: 'title',
                  value: event.target.value,
                })}
              />
              {/* A folder has nothing stable to key a row by - both of its fields are typed into
                  here, so a key built from either would remount the row on every character and
                  take the caret with it. The rows therefore stay keyed by position, and the row
                  that goes takes the focus off this button first: without it the same DOM node
                  survives the removal pointing at the NEXT folder, and the following Enter would
                  remove a folder nobody chose. */}
              <button
                className="jamat-configuration__button"
                type="button"
                aria-label={`Remove folder ${index + 1} from ${category.label}`}
                onClick={(event) => {
                  event.currentTarget.blur()
                  ports.dispatch({ input: 'folder-removed', id: category.id, index })
                }}
              >
                Remove
              </button>
              {problems.has(index) && (
                <span className="jamat-configuration-projects__warn" role="status">
                  {problems.get(index)}
                </span>
              )}
            </div>
          ))}
          <button
            className="jamat-configuration__button"
            type="button"
            onClick={() => ports.dispatch({ input: 'folder-added', id: category.id })}
          >
            {`Add folder to ${category.label}`}
          </button>
        </>
      )}
    </div>
  )
}
