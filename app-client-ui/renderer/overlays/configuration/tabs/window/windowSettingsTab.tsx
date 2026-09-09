import { useEffect, useId, useRef, useState } from 'react'

import { type WindowAppearance, WindowAppearanceLimits } from '../../../../../shared/windowInfo'
import { WindowInfoStore } from '../../../../shell/windowInfoStore'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './windowSettings.css'
import { WindowPalette } from './windowPalette'

export function WindowSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [initial] = useState(() => WindowSettingsTabState.appearance())
  const [loaded, setLoaded] = useState<WindowAppearance>(initial)
  const [buffer, setBuffer] = useState<WindowAppearance>(initial)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const nameId = useId()
  const palette = WindowPalette.read()
  const modified = !saving && !WindowSettingsTabState.equals(loaded, buffer)

  useEffect(() => {
    dirtyChange.current(modified)
  }, [modified])

  useEffect(() => WindowInfoStore.subscribe(() => {
    const appearance = WindowSettingsTabState.appearance()
    setLoaded(appearance)
    setBuffer(appearance)
    setProblem(null)
  }), [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setProblem(null)
    const answer = await window.appClient.windows.saveAppearance(buffer)
    if (!answer.ok) {
      setSaving(false)
      setProblem(answer.error)
      return
    }
    const appearance = WindowSettingsTabState.fromInfo(answer.value)
    setLoaded(appearance)
    setBuffer(appearance)
    setSaving(false)
  }

  return (
    <div className="jamat-configuration-window">
      {problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{problem}</p>
      )}
      <ConfigurationSection title="Name">
        <label className="jamat-configuration-window__label" htmlFor={nameId}>Window name</label>
        <input
          className="jamat-configuration-window__name"
          disabled={saving}
          id={nameId}
          maxLength={WindowAppearanceLimits.nameCharacters}
          type="text"
          value={buffer.name ?? ''}
          onChange={(event) => setBuffer({ ...buffer, name: event.currentTarget.value })}
        />
        <span className="jamat-configuration-window__hint">
          Named windows remain available from the Window menu after they are closed.
        </span>
      </ConfigurationSection>
      <ConfigurationSection title="Color">
        <div
          className="jamat-configuration-window__palette"
          role="radiogroup"
          aria-label="Window color"
        >
          {palette.map((entry) => (
            <button
              aria-label={entry.name}
              aria-checked={entry.color === buffer.color}
              className={entry.color === buffer.color
                ? 'jamat-configuration-window__swatch jamat-configuration-window__swatch--selected'
                : 'jamat-configuration-window__swatch'}
              disabled={saving}
              key={entry.name}
              role="radio"
              style={entry.color === null ? undefined : { backgroundColor: entry.color }}
              title={entry.name}
              type="button"
              onClick={() => setBuffer({ ...buffer, color: entry.color })}
            >
              {entry.color === null ? 'None' : ''}
            </button>
          ))}
        </div>
      </ConfigurationSection>
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          disabled={!modified || saving}
          type="button"
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

class WindowSettingsTabState {
  static appearance(): WindowAppearance {
    return WindowSettingsTabState.fromInfo(WindowInfoStore.current())
  }

  static fromInfo(info: WindowAppearance): WindowAppearance {
    return { name: info.name, color: info.color }
  }

  static equals(one: WindowAppearance, other: WindowAppearance): boolean {
    return one.name === other.name && one.color === other.color
  }
}
