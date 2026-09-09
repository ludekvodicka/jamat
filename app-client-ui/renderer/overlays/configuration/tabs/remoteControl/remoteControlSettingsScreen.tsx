import { useEffect, useRef, useState } from 'react'

import { AppClientUiReport } from '../../../../../shared/appClientUiReport'
import type { RemoteSettingsSnapshotDto } from '../../../../../shared/remoteSettingsSnapshot'
import { IpcSnapshotReader } from '../../../../ipc/ipcSnapshotReader'
import './remoteControlSettings.css'
import {
  RemoteControlSettingsEffects,
  type RemoteControlSettingsPorts,
} from './remoteControlSettingsEffects'
import {
  RemoteControlSettingsModel,
  type RemoteControlSettingsModelState,
  type RemoteControlSettingsOutcome,
} from './remoteControlSettingsModel'

/** What a screen's own body is handed, once there is a document to draw at all. */
export interface RemoteControlBodyProps {
  state: RemoteControlSettingsModelState
  snapshot: RemoteSettingsSnapshotDto
  ports: RemoteControlSettingsPorts
}

/**
 * What every Network screen stands on: one model, one command surface, one snapshot reader, and the
 * three states in which no body may be drawn at all.
 *
 * The three screens under Network are three of these, because what this holds is the wiring and
 * what a body holds is the markup. Each therefore owns its own model and its own reader: they share
 * one document and no state, so a Connect typed on one screen is not half-carried by another.
 */
export function RemoteControlSettingsScreen(props: {
  onDirtyChange: (dirty: boolean) => void
  Body: (body: RemoteControlBodyProps) => React.JSX.Element
}): React.JSX.Element {
  const [start] = useState(() => RemoteControlSettingsModel.initial())
  const [state, setState] = useState<RemoteControlSettingsModelState>(start.state)
  const stateRef = useRef(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  const mounted = useRef(true)
  dirtyChange.current = props.onDirtyChange
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [ports] = useState<RemoteControlSettingsPorts>(() => {
    const self: RemoteControlSettingsPorts = {
      dispatch: (input) => {
        if (!mounted.current) return
        const step = RemoteControlSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        const modified = RemoteControlSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void RemoteControlSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  /*
   * The push-and-read pair, and the reason these screens have no `load` effect: `remote:changed`
   * carries nothing, so every push costs a read of the whole document and the reader is what
   * coalesces them. A command's own answer says only whether it was taken; what it CHANGED arrives
   * here.
   */
  useEffect(() => {
    const reader = new IpcSnapshotReader<RemoteSettingsSnapshotDto>(
      {
        subject: 'The remote control settings',
        read: () => window.appClient.remoteSettings.get(),
        subscribe: (onChanged) => window.appClient.onRemoteChanged(onChanged),
        reportError: (message) => AppClientUiReport.error(message),
      },
      (snapshot) => ports.dispatch({ input: 'snapshot', value: snapshot }),
      (problem) => ports.dispatch({ input: 'read-problem', problem }),
    )
    return reader.start()
  }, [ports])

  const snapshot = state.snapshot
  const Body = props.Body
  return (
    <div className="jamat-configuration-remote">
      {state.readProblem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.readProblem}</p>
      )}
      {snapshot === null && (
        <p className="jamat-configuration-remote__note">Reading remote control settings…</p>
      )}
      {snapshot !== null && snapshot.sectionDamaged && (
        <p className="jamat-configuration__problem" role="alert">
          The remoteControl section of config.json holds something its owner cannot read. Nothing
          here can be written until that file is repaired by hand.
        </p>
      )}
      {snapshot !== null && <Body state={state} snapshot={snapshot} ports={ports} />}
    </div>
  )
}

export function RemoteOutcomeLine(props: {
  outcome: RemoteControlSettingsOutcome
}): React.JSX.Element {
  const { outcome } = props
  return outcome.failed
    ? <p className="jamat-configuration__problem" role="alert">{outcome.text}</p>
    : <p className="jamat-configuration-remote__note" role="status">{outcome.text}</p>
}
