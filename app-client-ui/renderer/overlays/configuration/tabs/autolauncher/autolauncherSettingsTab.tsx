import type { AutolauncherSnapshot } from '../../../../../shared/autolauncher'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { useAutolauncherSettings } from './useAutolauncherSettings'
import './autolauncherSettings.css'

export function AutolauncherSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const { state, setInvitation, enable, retrySavedConnection, disable, refresh } = useAutolauncherSettings(props.onDirtyChange)
  const { snapshot } = state
  const busy = state.pending !== null || (snapshot !== null && snapshot.operation !== 'idle')
  const locked = snapshot === null || !snapshot.supported || busy
  const otherProfile = snapshot !== null && snapshot.installed && !snapshot.installedForThisProfile
  const canRetrySavedConnection = state.failedCommand === 'enable' && snapshot?.connectionReady === true

  return (
    <div className="jamat-configuration-autolauncher">
      <ConfigurationSection title="Remote startup">
        <p className="jamat-configuration-autolauncher__note">
          Start this Jamat from the MiniWol web page, even when Jamat is closed. Autolauncher
          starts when you sign in to Windows and keeps running independently of Jamat.
        </p>
        <p className="jamat-configuration-autolauncher__note">
          You must remain signed in to Windows. Enabling, updating or disabling Autolauncher
          may show a Windows administrator permission prompt (UAC).
        </p>
        {snapshot === null && <p role="status">Reading Autolauncher status…</p>}
        {snapshot !== null && !snapshot.supported && (
          <p className="jamat-configuration-autolauncher__note">Autolauncher is available on Windows only.</p>
        )}
        {snapshot !== null && (
          <dl className="jamat-configuration-autolauncher__details">
            <dt>Installation</dt><dd>{installationText(snapshot)}</dd>
            <dt>Launcher</dt><dd>{snapshot.running ? 'Running' : 'Stopped'}</dd>
            <dt>MiniWol connection</dt><dd>{snapshot.connectionReady ? 'Configured' : 'Invitation required'}</dd>
            {snapshot.launcherUrl !== null && <><dt>Launcher address</dt><dd>{snapshot.launcherUrl}</dd></>}
          </dl>
        )}
      </ConfigurationSection>
      {snapshot !== null && (
        <ConfigurationSection title="This Jamat">
          <p className="jamat-configuration-autolauncher__note">
            Autolauncher uses the profile and startup path of this Jamat. These values are captured automatically.
          </p>
          <dl className="jamat-configuration-autolauncher__details">
            <dt>Profile directory</dt><dd>{snapshot.target.configDir}</dd>
            <dt>Profile identity</dt><dd>{snapshot.target.configIdentity}</dd>
            <dt>Runtime channel</dt><dd>{channelText(snapshot.target.runtimeChannel)}</dd>
            <dt>{pathLabel(snapshot.target.mode)}</dt><dd>{snapshot.target.path}</dd>
          </dl>
        </ConfigurationSection>
      )}
      <ConfigurationSection title="Setup">
        <label className="jamat-configuration-autolauncher__invitation">
          <span>MiniWol invitation</span>
          <input type="password" autoComplete="off" spellCheck={false}
            aria-describedby="autolauncher-invitation-hint"
            placeholder="Paste the one-time invitation from MiniWol"
            value={state.invitation} disabled={locked}
            onChange={(event) => setInvitation(event.target.value)} />
        </label>
        <p id="autolauncher-invitation-hint" className="jamat-configuration-autolauncher__note">
          Copy a one-time invitation for this PC from the MiniWol web page, paste it here, then enable
          Autolauncher. {snapshot?.connectionReady && 'Leave this empty to keep the existing connection.'}
        </p>
        {otherProfile && (
          <p className="jamat-configuration-autolauncher__warning" role="note">
            Autolauncher currently starts another profile: <strong>{snapshot.installedConfigDir ?? 'Unknown profile directory'}</strong>.
            {' '}Replacing it will make remote startup open this Jamat instead.
            {' '}To disable it, open Settings &gt; Autolauncher in the Jamat profile that owns this installation.
          </p>
        )}
        {state.readProblem !== null && <p className="jamat-configuration__problem" role="alert">{state.readProblem}</p>}
        {state.problem !== null && <p className="jamat-configuration__problem" role="alert">{state.problem}</p>}
        {snapshot?.problem && snapshot.problem !== state.problem && (
          <p className="jamat-configuration__problem" role="alert">{snapshot.problem}</p>
        )}
        {canRetrySavedConnection && (
          <p className="jamat-configuration-autolauncher__note">
            A MiniWol connection is saved. Retry installation with that connection, or paste a new invitation to replace it.
          </p>
        )}
        {state.outcome !== null && <p className="jamat-configuration-autolauncher__note" role="status">{state.outcome}</p>}
        {busy && <p role="status">{pendingText(state.pending, snapshot?.operation ?? 'idle')}</p>}
        <div className="jamat-configuration__actions">
          <button className="jamat-configuration__button jamat-configuration__button--primary" type="button"
            disabled={locked || (!snapshot?.connectionReady && state.invitation.trim().length === 0)}
            onClick={canRetrySavedConnection ? retrySavedConnection : enable}>
            {canRetrySavedConnection ? 'Retry with saved connection'
              : otherProfile ? 'Replace other profile with this Jamat'
              : snapshot?.installed ? 'Update for this Jamat' : 'Enable for this Jamat'}
          </button>
          <button className="jamat-configuration__button jamat-configuration__button--danger" type="button"
            disabled={locked || !snapshot?.installed || !snapshot.installedForThisProfile} onClick={disable}>
            Disable
          </button>
          <button className="jamat-configuration__button" type="button" disabled={busy} onClick={refresh}>
            Refresh status
          </button>
        </div>
      </ConfigurationSection>
    </div>
  )
}

function installationText(snapshot: AutolauncherSnapshot): string {
  if (!snapshot.installed) return 'Not installed'
  return snapshot.installedForThisProfile ? 'Installed for this Jamat' : 'Installed for another profile'
}

function channelText(channel: AutolauncherSnapshot['target']['runtimeChannel']): string {
  if (channel === 'development') return 'Development'
  else if (channel === 'production') return 'Production'
  else throw new Error('Unknown Autolauncher runtime channel')
}

function pathLabel(mode: AutolauncherSnapshot['target']['mode']): string {
  if (mode === 'executable') return 'Executable path'
  else if (mode === 'source') return 'Source checkout'
  else throw new Error('Unknown Autolauncher startup mode')
}

function pendingText(pending: 'enable' | 'disable' | null, operation: AutolauncherSnapshot['operation']): string {
  if (pending === 'enable') return 'Installing Autolauncher. Complete the Windows permission prompt if shown…'
  else if (pending === 'disable') return 'Disabling Autolauncher. Complete the Windows permission prompt if shown…'
  else if (pending !== null) throw new Error('Unknown Autolauncher command')
  if (operation === 'installing') return 'Installing Autolauncher…'
  else if (operation === 'removing') return 'Disabling Autolauncher…'
  else if (operation === 'idle') return ''
  else throw new Error('Unknown Autolauncher operation')
}
