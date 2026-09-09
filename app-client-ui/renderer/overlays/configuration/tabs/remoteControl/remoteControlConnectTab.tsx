import { useId } from 'react'

import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { RemoteControlSettingsModel } from './remoteControlSettingsModel'
import {
  RemoteControlSettingsScreen,
  RemoteOutcomeLine,
  type RemoteControlBodyProps,
} from './remoteControlSettingsScreen'

/**
 * The one thing that adds a computer, and nothing else. Reaching a new machine is a step somebody
 * takes once and then never again, so it has a screen of its own rather than a field at the top of
 * the list it feeds - the list is read daily and this is not.
 */
export function RemoteControlConnectTab(props: ConfigurationTabProps): React.JSX.Element {
  return (
    <RemoteControlSettingsScreen
      onDirtyChange={props.onDirtyChange}
      Body={ConnectBody}
    />
  )
}

/**
 * The field takes either form and decides neither. What the text IS - a pasted bundle or a typed
 * address - is the main process's to work out, because the two differ in when that computer's key
 * is pinned, and a renderer that guessed would be a second answer to a security question.
 */
function ConnectBody(props: RemoteControlBodyProps): React.JSX.Element {
  const { state, ports } = props
  const connectId = useId()
  const outcome = state.outcome?.command.command === 'pairing-connect' ? state.outcome : null
  const locked = RemoteControlSettingsModel.locked(state)
  const busy = locked || state.running !== null
  return (
    <>
      <ConfigurationSection title="Address or pairing bundle">
        <label htmlFor={connectId}>The computer to reach</label>
        <textarea
          id={connectId}
          className="jamat-configuration-remote__bundle"
          rows={3}
          spellCheck={false}
          placeholder="Paste a pairing bundle, or type host:port"
          disabled={busy}
          value={state.pairing.text}
          onChange={(event) => ports.dispatch({
            input: 'pairing-text',
            value: event.currentTarget.value,
          })}
        />
        <p className="jamat-configuration-remote__note">
          A pasted bundle carries that computer’s key, so it is pinned before the first dial. A
          typed host:port pins whatever answers at that address, so read the fingerprint you are
          shown back to the person there before you confirm.
        </p>
        {outcome !== null && <RemoteOutcomeLine outcome={outcome} />}
        <div className="jamat-configuration__actions">
          <button
            className="jamat-configuration__button jamat-configuration__button--primary"
            type="button"
            disabled={busy}
            onClick={() => ports.dispatch({ input: 'pairing-connect' })}
          >Connect</button>
        </div>
      </ConfigurationSection>
      <ConfigurationSection title="After you connect">
        <p className="jamat-configuration-remote__note">
          That computer stays refused until somebody at it allows this one in. It appears under
          Remote connections the moment it is added, and a Retry now there takes their Allow into
          effect rather than waiting for the next dial.
        </p>
      </ConfigurationSection>
    </>
  )
}
