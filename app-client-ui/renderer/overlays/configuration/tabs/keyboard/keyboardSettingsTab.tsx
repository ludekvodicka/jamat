import { useEffect, useId, useRef, useState } from 'react'

import type { LauncherKeyPreference } from '../../../../../shared/commands'
import { KeyboardSettings } from '../../../../../shared/keyboardSettings'
import { KeyboardSettingsStore } from '../../../../keyboardSettings/keyboardSettingsStore'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './keyboardSettings.css'
import {
  KeyboardSettingsEffects,
  type KeyboardSettingsPorts,
} from './keyboardSettingsEffects'
import {
  KeyboardSettingsModel,
  type KeyboardSettingsModelState,
} from './keyboardSettingsModel'

/**
 * Which of the two launcher cards Ctrl+T opens, and therefore which one Ctrl+Shift+T opens.
 *
 * It is a swap of two fixed keys and deliberately not a key editor: every rule the command catalog
 * holds about keys - what the terminal may not take, that no two commands share one - stays true
 * under both answers, because the same two keys are claimed either way.
 *
 * It saves itself, and only when Save is pressed. There is no preview: the keys are built into the
 * native menu by the main process, which rebuilds it when the write lands.
 */
export function KeyboardSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => KeyboardSettingsModel.initial())
  const [state, setState] = useState<KeyboardSettingsModelState>(start.state)
  const stateRef = useRef<KeyboardSettingsModelState>(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const groupName = useId()

  const [ports] = useState<KeyboardSettingsPorts>(() => {
    const self: KeyboardSettingsPorts = {
      dispatch: (input) => {
        const step = KeyboardSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        // Told rather than left to hear it back: the broadcast returns through a reader that
        // coalesces first, and the one tooltip that names this key would print the old pair until
        // that read landed.
        if (input.input === 'saved' && input.ok && step.state.loaded !== null)
          KeyboardSettingsStore.committed(step.state.loaded.launcherKeys)
        const modified = KeyboardSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void KeyboardSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void KeyboardSettingsEffects.run(effect, ports)
  }, [start, ports])

  const buffer = state.buffer
  const saving = state.saving !== null
  return (
    <div className="jamat-configuration-keyboard">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      {buffer === null && (
        <p className="jamat-configuration-keyboard__hint">Reading config.json…</p>
      )}
      <ConfigurationSection title="Launcher keys">
        <p className="jamat-configuration-keyboard__hint">
          Which card the nearer key opens. The other card keeps the other key, so both are always
          one keystroke away.
        </p>
        <div
          className="jamat-configuration-keyboard__choices"
          role="radiogroup"
          aria-label="Launcher keys"
        >
          {KeyboardSettings.preferencesConst.map((preference) => (
            <LauncherKeysChoice
              key={preference}
              chosen={buffer?.launcherKeys === preference}
              disabled={buffer === null || saving}
              groupName={groupName}
              preference={preference}
              onChoose={() => ports.dispatch({ input: 'launcher-keys', preference })}
            />
          ))}
        </div>
      </ConfigurationSection>
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          disabled={buffer === null || saving}
          type="button"
          onClick={() => ports.dispatch({ input: 'reset' })}
        >
          Reset to defaults
        </button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          disabled={!KeyboardSettingsModel.isModified(state) || saving}
          type="button"
          onClick={() => ports.dispatch({ input: 'save' })}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/**
 * One of the two answers. Both lines come from `KeyboardSettings.describe`, the list the main
 * process refuses a write against, so a row cannot offer a value the store would then turn down -
 * and neither row has to be read to understand the other: each spells the whole pair out.
 */
function LauncherKeysChoice(props: {
  chosen: boolean
  disabled: boolean
  groupName: string
  preference: LauncherKeyPreference
  onChoose: () => void
}): React.JSX.Element {
  const described = KeyboardSettings.describe(props.preference)
  const className = props.chosen
    ? 'jamat-configuration-keyboard__choice jamat-configuration-keyboard__choice--chosen'
    : 'jamat-configuration-keyboard__choice'
  return (
    <label className={className}>
      <input
        className="jamat-configuration-keyboard__radio"
        checked={props.chosen}
        disabled={props.disabled}
        name={props.groupName}
        type="radio"
        value={props.preference}
        onChange={() => props.onChoose()}
      />
      <span className="jamat-configuration-keyboard__text">
        <span className="jamat-configuration-keyboard__title">
          {`Ctrl+T opens ${described.title}`}
        </span>
        <span className="jamat-configuration-keyboard__note">{described.note}</span>
      </span>
    </label>
  )
}
