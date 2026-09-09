import { useEffect, useId } from 'react'

import { RemoteControlSettings } from '../../../../../shared/remoteControlSettings'
import type {
  RemoteSettingsInboundPeerDto,
  RemoteSettingsProfileDto,
} from '../../../../../shared/remoteSettingsSnapshot'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import type { RemoteControlSettingsPorts } from './remoteControlSettingsEffects'
import {
  RemoteControlSettingsModel,
  type RemoteControlSettingsModelState,
} from './remoteControlSettingsModel'
import {
  RemoteControlSettingsScreen,
  RemoteOutcomeLine,
  type RemoteControlBodyProps,
} from './remoteControlSettingsScreen'

/**
 * Every remote computer this one has a relationship with, in both directions and in one place: the
 * ones it dials, above the ones it lets in.
 *
 * The two directions are independent - a computer this one dials has no say in what it may do here,
 * and a computer allowed in is not dialled back - so they are two lists rather than one. They are
 * on one screen anyway because they answer the same question, "which computers are there and what
 * is each one doing right now", and that is the question somebody opens this screen with.
 */
export function RemoteControlConnectionsTab(props: ConfigurationTabProps): React.JSX.Element {
  /*
   * Nothing is dialled until something asks, so this screen asks for as long as it is open. Every
   * status, error and version on it comes from a live connection; without the hold the list would
   * read `idle` for every computer, which is true and useless.
   */
  useEffect(() => {
    void window.appClient.remote.hold('network-settings')
    return () => { void window.appClient.remote.release('network-settings') }
  }, [])
  return (
    <RemoteControlSettingsScreen
      onDirtyChange={props.onDirtyChange}
      Body={ConnectionsBody}
    />
  )
}

function ConnectionsBody(props: RemoteControlBodyProps): React.JSX.Element {
  const { state, snapshot, ports } = props
  return (
    <>
      <ConfigurationSection title="Computers this one reaches">
        {snapshot.profiles.length === 0 && (
          <p className="jamat-configuration-remote__note">
            No computer is paired with this one yet. Connect computer is where one is added.
          </p>
        )}
        {snapshot.profiles.map((profile) => (
          <PairedRow key={profile.profileId} profile={profile} state={state} ports={ports} />
        ))}
      </ConfigurationSection>
      <ConfigurationSection title="Computers allowed in">
        {snapshot.inbound.length === 0 && (
          <p className="jamat-configuration-remote__note">
            No computer may reach this one. One is added when somebody here answers Allow on the
            dialog an unknown computer’s first connection raises.
          </p>
        )}
        {snapshot.inbound.map((peer) => (
          <AllowedInRow
            key={`${peer.remoteComputerId} ${peer.remoteEndpointId}`}
            peer={peer}
            state={state}
            ports={ports}
          />
        ))}
      </ConfigurationSection>
    </>
  )
}

/**
 * One paired computer, and everything the sessions tree cannot say about it: why it is not there.
 * The sessions tree draws connected computers and nothing else by decision, so the last success,
 * the next retry, the version over there and a manual Retry are read here or nowhere.
 *
 * The only right on the row is this computer's own dialling; what that computer may do HERE is
 * granted and revoked in the list below, and never from a row about dialling out.
 */
function PairedRow(props: {
  profile: RemoteSettingsProfileDto
  state: RemoteControlSettingsModelState
  ports: RemoteControlSettingsPorts
}): React.JSX.Element {
  const { profile, state, ports } = props
  const hostId = useId()
  const portId = useId()
  const last = state.outcome
  const outcome = last !== null
    && 'profileId' in last.command
    && last.command.profileId === profile.profileId
    ? last
    : null
  const edit = state.endpointEdit?.profileId === profile.profileId ? state.endpointEdit : null
  const armed = state.forgetAsk === profile.profileId
  const locked = RemoteControlSettingsModel.locked(state)
  const busy = locked || state.running !== null
  return (
    <div className="jamat-configuration-remote__computer" data-profile={profile.profileId}>
      <div className="jamat-configuration-remote__computer-head">
        <strong>{profile.displayName}</strong>
        <span>{`${profile.endpoint.host}:${profile.endpoint.port}`}</span>
        <span className="jamat-configuration-remote__status">
          {RemoteControlSettingsModel.statusTextOf(profile.status)}
        </span>
      </div>
      <dl className="jamat-configuration-remote__facts">
        <dt>Fingerprint</dt>
        <dd><code>{profile.fingerprint}</code></dd>
        <dt>Last connected</dt>
        <dd>{RemoteMoment.orAbsent(profile.lastConnectedAt, 'never')}</dd>
        <dt>Next retry</dt>
        <dd>{RemoteMoment.orAbsent(profile.nextRetryAt, 'none waiting')}</dd>
        <dt>Version over there</dt>
        <dd>{profile.applicationVersion ?? 'not answered yet'}</dd>
        <dt>Last error</dt>
        <dd>{profile.error ?? 'none'}</dd>
      </dl>
      {edit !== null && (
        <div className="jamat-configuration-remote__fields">
          <label htmlFor={hostId}>Host</label>
          <input
            id={hostId}
            type="text"
            spellCheck={false}
            disabled={busy}
            value={edit.host}
            onChange={(event) => ports.dispatch({
              input: 'endpoint-host',
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
            disabled={busy}
            value={edit.port}
            onChange={(event) => ports.dispatch({
              input: 'endpoint-port',
              value: event.currentTarget.value,
            })}
          />
        </div>
      )}
      {outcome !== null && <RemoteOutcomeLine outcome={outcome} />}
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          type="button"
          disabled={busy}
          onClick={() => ports.dispatch({ input: 'profile-retry', profileId: profile.profileId })}
        >Retry now</button>
        {edit === null && (
          <button
            className="jamat-configuration__button"
            type="button"
            disabled={busy}
            onClick={() => ports.dispatch({
              input: 'endpoint-open',
              profileId: profile.profileId,
              endpoint: profile.endpoint,
            })}
          >Edit endpoint</button>
        )}
        {edit !== null && (
          <>
            <button
              className="jamat-configuration__button jamat-configuration__button--primary"
              type="button"
              disabled={busy}
              onClick={() => ports.dispatch({ input: 'endpoint-save' })}
            >Save endpoint</button>
            <button
              className="jamat-configuration__button"
              type="button"
              onClick={() => ports.dispatch({ input: 'endpoint-cancel' })}
            >Cancel</button>
          </>
        )}
        <button
          className="jamat-configuration__button jamat-configuration__button--danger"
          type="button"
          disabled={busy}
          onClick={() => ports.dispatch(armed
            ? { input: 'forget-confirm' }
            : { input: 'forget-ask', profileId: profile.profileId })}
        >{armed ? 'Confirm forget' : 'Forget'}</button>
        {armed && (
          <button
            className="jamat-configuration__button"
            type="button"
            onClick={() => ports.dispatch({ input: 'forget-cancel' })}
          >Keep</button>
        )}
      </div>
    </div>
  )
}

/**
 * One computer that was let in, and the only way to take that back. There is no armed confirm here
 * the way Forget has one: Revoke costs that computer a reconnection and a second Allow, where a
 * Forget throws away an endpoint somebody typed.
 */
function AllowedInRow(props: {
  peer: RemoteSettingsInboundPeerDto
  state: RemoteControlSettingsModelState
  ports: RemoteControlSettingsPorts
}): React.JSX.Element {
  const { peer, state, ports } = props
  const last = state.outcome
  const outcome = last !== null
    && last.command.command === 'inbound-revoke'
    && last.command.remoteEndpointId === peer.remoteEndpointId
    ? last
    : null
  const busy = RemoteControlSettingsModel.locked(state) || state.running !== null
  return (
    <div className="jamat-configuration-remote__computer" data-inbound={peer.remoteEndpointId}>
      <div className="jamat-configuration-remote__computer-head">
        <strong>{peer.displayName}</strong>
        <span
          className={peer.connected
            ? 'jamat-configuration-remote__live jamat-configuration-remote__live--now'
            : 'jamat-configuration-remote__live'}
        >{peer.connected ? 'connected now' : 'not connected'}</span>
      </div>
      <dl className="jamat-configuration-remote__facts">
        <dt>Fingerprint</dt>
        <dd><code>{peer.fingerprint}</code></dd>
        <dt>Allowed</dt>
        <dd>{RemoteMoment.of(peer.addedAt)}</dd>
      </dl>
      {outcome !== null && <RemoteOutcomeLine outcome={outcome} />}
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button jamat-configuration__button--danger"
          type="button"
          disabled={busy}
          onClick={() => ports.dispatch({
            input: 'inbound-revoke',
            remoteComputerId: peer.remoteComputerId,
            remoteEndpointId: peer.remoteEndpointId,
          })}
        >Revoke</button>
      </div>
    </div>
  )
}

/** A moment as this screen reads it, and the sentence for one that has never happened. */
class RemoteMoment {
  static of(timestamp: number): string {
    return new Date(timestamp).toLocaleString()
  }

  static orAbsent(timestamp: number | null, absent: string): string {
    if (timestamp === null) return absent
    return RemoteMoment.of(timestamp)
  }
}
