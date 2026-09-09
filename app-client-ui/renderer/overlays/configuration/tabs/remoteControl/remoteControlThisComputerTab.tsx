import { useId } from 'react'

import { RemoteControlSettings } from '../../../../../shared/remoteControlSettings'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { RemoteControlSettingsModel } from './remoteControlSettingsModel'
import {
  RemoteControlSettingsScreen,
  RemoteOutcomeLine,
  type RemoteControlBodyProps,
} from './remoteControlSettingsScreen'

/**
 * What this computer offers the network: the listener it is asked to run, who it says it is, and
 * the bundle another computer is handed to reach it.
 *
 * The listener and the bundle are one screen because the bundle names the ADVERTISED endpoint of
 * the listener above it, so one copied while nothing is bound sends the other computer at a port
 * that answers nobody. Nothing about ANOTHER computer is here, in either direction: this screen
 * answers only "what is this machine, and what do I hand to the person over there".
 */
export function RemoteControlThisComputerTab(props: ConfigurationTabProps): React.JSX.Element {
  return (
    <RemoteControlSettingsScreen
      onDirtyChange={props.onDirtyChange}
      Body={ThisComputerBody}
    />
  )
}

function ThisComputerBody(props: RemoteControlBodyProps): React.JSX.Element {
  const { state, snapshot, ports } = props
  const enabledId = useId()
  const bindHostId = useId()
  const portId = useId()
  const advertisedHostId = useId()
  const copyOutcome = state.outcome?.command.command === 'copy-bundle' ? state.outcome : null
  const locked = RemoteControlSettingsModel.locked(state)
  const saving = state.listener.saving !== null
  const buffer = state.listener.buffer
  const disabled = locked || buffer === null || saving
  const listening = snapshot.listener.runtime.status === 'listening'
  // Locked as well, though a copy writes nothing: no command runs while the section is damaged, and
  // a button that runs nothing has to look like one.
  const copyDisabled = locked || snapshot.bundleText === null || state.running !== null
  return (
    <>
      <ConfigurationSection title="Listener">
        {state.listener.problem !== null && (
          <p className="jamat-configuration__problem" role="alert">{state.listener.problem}</p>
        )}
        <div className="jamat-configuration-remote__row">
          <input
            id={enabledId}
            type="checkbox"
            disabled={disabled}
            checked={buffer?.enabled ?? false}
            onChange={(event) => ports.dispatch({
              input: 'listener-enabled',
              value: event.currentTarget.checked,
            })}
          />
          <label htmlFor={enabledId}>
            Let paired computers reach this one
            <span>Nothing listens on the network until this is on and the bind below succeeds.</span>
          </label>
        </div>
        <div className="jamat-configuration-remote__fields">
          <label htmlFor={bindHostId}>Bind address</label>
          <input
            id={bindHostId}
            type="text"
            spellCheck={false}
            disabled={disabled}
            value={buffer?.bindHost ?? ''}
            onChange={(event) => ports.dispatch({
              input: 'listener-bind-host',
              value: event.currentTarget.value,
            })}
          />
          <label htmlFor={portId}>Port</label>
          <input
            id={portId}
            type="number"
            min={RemoteControlSettings.portMinConst}
            max={RemoteControlSettings.portMaxConst}
            step={1}
            disabled={disabled}
            value={buffer?.port ?? RemoteControlSettings.defaultValue().listener.port}
            onChange={(event) => ports.dispatch({
              input: 'listener-port',
              value: Number(event.currentTarget.value),
            })}
          />
          <label htmlFor={advertisedHostId}>Advertised address</label>
          <input
            id={advertisedHostId}
            type="text"
            spellCheck={false}
            disabled={disabled}
            value={buffer?.advertisedHost ?? ''}
            onChange={(event) => ports.dispatch({
              input: 'listener-advertised-host',
              value: event.currentTarget.value,
            })}
          />
        </div>
        <p className="jamat-configuration-remote__note">
          The advertised address is what the pairing bundle tells the other computer to dial, so it
          is the one this machine is reachable at rather than the one it binds.
        </p>
        <p className="jamat-configuration-remote__runtime">
          {`Listener: ${RemoteControlSettingsModel.runtimeTextOf(snapshot.listener.runtime)}`}
        </p>
        <div className="jamat-configuration__actions">
          <button
            className="jamat-configuration__button"
            type="button"
            disabled={disabled}
            onClick={() => ports.dispatch({ input: 'reset' })}
          >Reset to default</button>
          <button
            className="jamat-configuration__button jamat-configuration__button--primary"
            type="button"
            disabled={locked || saving || !RemoteControlSettingsModel.isModified(state)}
            onClick={() => ports.dispatch({ input: 'save' })}
          >{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </ConfigurationSection>
      <ConfigurationSection title="Identity">
        <dl className="jamat-configuration-remote__facts">
          <dt>Name</dt>
          <dd>{snapshot.identity.displayName}</dd>
          <dt>Fingerprint</dt>
          <dd><code>{snapshot.identity.fingerprint}</code></dd>
        </dl>
        <p className="jamat-configuration-remote__note">
          The fingerprint is what the person at the other computer reads back before they trust
          this one. The name proves nothing and is only there to tell two machines apart.
        </p>
      </ConfigurationSection>
      <ConfigurationSection title="Pairing bundle">
        {!listening && (
          <p className="jamat-configuration-remote__warning">
            Nothing is listening here, so a bundle copied now points the other computer at an
            address that will refuse it. Turn the listener on above first.
          </p>
        )}
        {snapshot.bundleText === null && (
          <p className="jamat-configuration-remote__warning">
            No pairing bundle has been published, so there is nothing to copy. It is written at
            start and again after every successful bind.
          </p>
        )}
        <p className="jamat-configuration-remote__note">
          The bundle is what somebody at the other computer pastes into its Connect computer
          screen. It carries this computer’s public key and its advertised address, and no secret
          of any kind.
        </p>
        {copyOutcome !== null && <RemoteOutcomeLine outcome={copyOutcome} />}
        <div className="jamat-configuration__actions">
          <button
            className="jamat-configuration__button"
            type="button"
            disabled={copyDisabled}
            onClick={() => ports.dispatch({ input: 'copy-bundle' })}
          >Copy pairing bundle</button>
        </div>
      </ConfigurationSection>
    </>
  )
}
