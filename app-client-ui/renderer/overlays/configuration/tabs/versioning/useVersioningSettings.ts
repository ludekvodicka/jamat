import { useEffect, useRef, useState } from 'react'
import type { VersioningSettingsValue } from '../../../../../shared/versioningSettings'
import { VersioningSettingsEffects, type VersioningSettingsPorts } from './versioningSettingsEffects'
import { VersioningSettingsModel, type VersioningSettingsModelState } from './versioningSettingsModel'

export function useVersioningSettings(field: keyof VersioningSettingsValue, onDirtyChange: (dirty: boolean) => void) {
  const [start] = useState(() => VersioningSettingsModel.initial())
  const [state, setState] = useState<VersioningSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(onDirtyChange)
  const mounted = useRef(true)
  dirtyChange.current = onDirtyChange
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [ports] = useState<VersioningSettingsPorts>(() => {
    const self: VersioningSettingsPorts = {
      dispatch: (input) => {
        if (!mounted.current) return
        const step = VersioningSettingsModel.transition(stateRef.current, input, field)
        stateRef.current = step.state
        setState(step.state)
        const modified = VersioningSettingsModel.isModified(step.state, field)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects) void VersioningSettingsEffects.run(effect, self, field)
      },
    }
    return self
  })
  useEffect(() => {
    for (const effect of start.effects) void VersioningSettingsEffects.run(effect, ports, field)
  }, [ports, start.effects, field])
  return { state, dispatch: ports.dispatch, modified: VersioningSettingsModel.isModified(state, field) }
}
