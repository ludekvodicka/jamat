import { useEffect, useRef, useState } from 'react'

import type { SessionGroup, SessionGroupDefinition } from '../../../../../shared/sessionsGroupsState'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './sessionGroupsSettings.css'
import {
  SessionGroupsSettingsEffects,
  type SessionGroupsSettingsPorts,
} from './sessionGroupsSettingsEffects'
import {
  SessionGroupsSettingsModel,
  type SessionGroupsSettingsModelState,
} from './sessionGroupsSettingsModel'

/**
 * The sections of the sessions tree: add one, name it, order it, take it away.
 *
 * Sessions and Pinned are in the list and can be MOVED, which is the point of having them here: the
 * order decides which sections a person reads above their own work and which below, and that answer
 * is different for different people. Neither can be removed - Sessions is the absence of a group and
 * Pinned is what the pin surfaces write - so both draw their name instead of a field.
 *
 * It saves itself, and only when Save is pressed. Leaving the card discards, and the window asks
 * that question; this tab answers only the part it owns, which is whether there is anything to lose.
 */
export function SessionGroupsSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => SessionGroupsSettingsModel.initial())
  const [state, setState] = useState<SessionGroupsSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  /*
   * Which row is waiting for a yes. Here and not in the model: what it costs is already on screen -
   * the section goes, and every session filed in it is drawn under Sessions again - so this is a
   * second click rather than a state the card has to carry through a load or a save.
   */
  const [removing, setRemoving] = useState<SessionGroup | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const [ports] = useState<SessionGroupsSettingsPorts>(() => {
    const self: SessionGroupsSettingsPorts = {
      dispatch: (input) => {
        const step = SessionGroupsSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = SessionGroupsSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void SessionGroupsSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void SessionGroupsSettingsEffects.run(effect, ports)
  }, [ports, start.effects])

  const groups = state.buffer
  const problem = SessionGroupsSettingsModel.problemOf(state)
  return (
    <div className="jamat-configuration-session-groups">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      <ConfigurationSection title="Sessions tree sections">
        <p className="jamat-configuration-session-groups__note">
          The sessions tree draws one section per group, top to bottom in this order. A section with
          nothing in it is not drawn at all, so an empty group costs nothing but this row. Sessions
          and Pinned are here to be moved: where they sit decides which sections you read above your
          own work and which below, and neither can be renamed or removed. The id beside each name
          is what <code>--group</code> takes on the command line; it is fixed when the group is made.
        </p>
        {groups === null
          ? <p className="jamat-configuration-session-groups__note">Reading config.json…</p>
          : (
              <ul className="jamat-configuration-session-groups__rows">
                {groups.map((definition, index) => (
                  <SessionGroupRow
                    definition={definition}
                    first={index === 0}
                    key={definition.id}
                    last={index === groups.length - 1}
                    ports={ports}
                    removing={removing === definition.id}
                    onRemoving={setRemoving}
                  />
                ))}
              </ul>
            )}
        <div className="jamat-configuration-session-groups__add">
          <input
            className="jamat-configuration-session-groups__title jamat-configuration-session-groups__add-field"
            value={newTitle}
            aria-label="Name of the new group"
            placeholder="New group"
            disabled={groups === null}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <button
            className="jamat-configuration__button"
            disabled={groups === null || newTitle.trim().length === 0}
            type="button"
            onClick={() => {
              ports.dispatch({ input: 'add', title: newTitle })
              setNewTitle('')
            }}
          >
            Add group
          </button>
        </div>
      </ConfigurationSection>
      {problem !== null && (
        <p className="jamat-configuration-session-groups__refusal" role="status">{problem}</p>
      )}
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          disabled={groups === null || state.saving !== null}
          type="button"
          onClick={() => ports.dispatch({ input: 'reset' })}
        >
          Restore defaults
        </button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          disabled={!SessionGroupsSettingsModel.isModified(state)
            || state.saving !== null
            || problem !== null}
          type="button"
          onClick={() => ports.dispatch({ input: 'save' })}
        >
          {state.saving !== null ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/**
 * One section, and every row draws the same five cells whether or not it can be edited: the name,
 * the id, the two arrows and the last button. That is what keeps the fields one length and the
 * buttons in one line - a row that left a cell out pulled everything after it sideways.
 *
 * A fixed row carries a disabled field rather than text for the same reason. It says "this name is
 * here and is not yours to retype", which is what is true, and it occupies the column exactly as a
 * field does.
 */
function SessionGroupRow(props: {
  definition: SessionGroupDefinition
  first: boolean
  last: boolean
  ports: SessionGroupsSettingsPorts
  removing: boolean
  onRemoving: (id: SessionGroup | null) => void
}): React.JSX.Element {
  const { definition, ports } = props
  const fixed = SessionGroupsSettingsModel.isFixed(definition)
  return (
    <li className="jamat-configuration-session-groups__entry">
      <input
        className="jamat-configuration-session-groups__title"
        value={definition.title}
        disabled={fixed}
        aria-label={`Name of ${definition.id}`}
        title={fixed
          ? `${definition.title} is always a section and cannot be renamed or removed. Move it to `
            + 'decide where the others sit around it.'
          : undefined}
        onChange={(event) =>
          ports.dispatch({ input: 'rename', id: definition.id, title: event.target.value })}
      />
      <code className="jamat-configuration-session-groups__id" title="--group on the command line">
        {definition.id}
      </code>
      <button
        className="jamat-configuration__button jamat-configuration-session-groups__move"
        disabled={props.first}
        type="button"
        aria-label={`Move ${definition.title} up`}
        onClick={() => ports.dispatch({ input: 'move', id: definition.id, delta: -1 })}
      >
        ↑
      </button>
      <button
        className="jamat-configuration__button jamat-configuration-session-groups__move"
        disabled={props.last}
        type="button"
        aria-label={`Move ${definition.title} down`}
        onClick={() => ports.dispatch({ input: 'move', id: definition.id, delta: 1 })}
      >
        ↓
      </button>
      {/* The cell stands empty on a fixed row rather than closing up, so the column survives it. */}
      {fixed
        ? <span />
        : <button
            className={props.removing
              ? 'jamat-configuration__button jamat-configuration__button--danger'
              : 'jamat-configuration__button'}
            type="button"
            aria-label={props.removing
              ? `Remove ${definition.title} and unfile its sessions`
              : `Remove ${definition.title}`}
            onClick={() => {
              if (!props.removing) return props.onRemoving(definition.id)
              ports.dispatch({ input: 'remove', id: definition.id })
              props.onRemoving(null)
            }}
          >
            {props.removing ? 'Confirm' : 'Remove'}
          </button>}
    </li>
  )
}
