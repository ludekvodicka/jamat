import { useEffect, useRef, useState } from 'react'
import type { AccountView } from '../../../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import type { AntigravityLoginsView } from '../../../../../../lib-orchestrator/agentAccounts/antigravityLoginsApi.types'
import { AppClientUiReport } from '../../../../../shared/appClientUiReport'
import { ErrorText } from '../../../../../shared/errorText'
import { AppControl } from '../../../../ipc/appControl'
import { IpcSnapshotReader } from '../../../../ipc/ipcSnapshotReader'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { ConfigurationSection } from '../../configurationSection'
import { AccountsTabModel, type AccountAction } from './accountsTabModel'
import type { UsageAccount, UsageSnapshot } from '../../../../../../lib-orchestrator/rateMonitor/usageApi.types'
import { UsageModel } from '../../../../usage/usageModel'
import { QuotaWindow } from '../../../../usage/usageParts'
import './accountsTab.css'

/** The used share of the 5-hour and weekly windows, as the Usage tab draws them, with a note when the reading is not fresh. */
function AccountQuota({ label, quota, now }: { label: string; quota: UsageAccount | undefined; now: number }): React.JSX.Element {
  if (quota === undefined) return <p className="jamat-usage__muted">No quota reading</p>
  const note = UsageModel.readingNote(quota)
  return <div className="jamat-accounts__quota" role="group" aria-label={`${label} quota`}>
    <QuotaWindow label={`${label} 5-hour used`} name="5h" window={UsageModel.window(quota, UsageModel.sessionMinutesConst)} now={now} />
    <QuotaWindow label={`${label} weekly used`} name="Week" window={UsageModel.window(quota, UsageModel.weeklyMinutesConst)} now={now} />
    {note !== null && <span className="jamat-usage__chip">{note}</span>}
  </div>
}

function antigravityStatusText(view: AntigravityLoginsView): string {
  if (!view.currentPresent) return view.loginInProgress ? 'Current login: waiting for sign-in in Login: Antigravity…' : 'Current login: none (cleared)'
  const active = view.logins.find(slot => slot.id === view.activeSlotId)
  const detail = view.currentEmail ? ` (${view.currentEmail}${view.currentPlanTier ? ` · ${view.currentPlanTier}` : ''})` : ''
  return active ? `Current login: stored as ${active.label}${detail}` : `Current login: signed in, not stored${detail}`
}

export function AccountsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [accounts, setAccounts] = useState<readonly AccountView[] | null>(null)
  const [antigravityLogins, setAntigravityLogins] = useState<AntigravityLoginsView | null>(null)
  const [antigravityReadProblem, setAntigravityReadProblem] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [antigravityLabel, setAntigravityLabel] = useState('')
  const [confirmClearAntigravity, setConfirmClearAntigravity] = useState(false)
  const [removingAntigravity, setRemovingAntigravity] = useState<string | null>(null)
  const [rename, setRename] = useState<{ accountId: string; label: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [usageProblem, setUsageProblem] = useState<string | null>(null)
  const [readProblem, setReadProblem] = useState<string | null>(null)
  const reader = useRef<IpcSnapshotReader<readonly AccountView[]> | null>(null)
  const antigravityReader = useRef<IpcSnapshotReader<AntigravityLoginsView> | null>(null)
  const mounted = useRef(false)
  const writing = useRef(false)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  useEffect(() => {
    mounted.current = true
    const listeners = new Set<() => void>()
    const stopChannel = window.appClient.onAgentSettingsChanged(() => {
      for (const listener of listeners) listener()
    })
    const subscribe = (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    const snapshot = new IpcSnapshotReader({ subject: 'Accounts', read: () => AppControl.value('accounts.list', {}),
      subscribe, reportError: AppClientUiReport.error }, setAccounts, setReadProblem)
    const antigravitySnapshot = new IpcSnapshotReader({ subject: 'Antigravity logins',
      read: () => AppControl.value('accounts.antigravity.list', {}),
      subscribe, reportError: AppClientUiReport.error },
      setAntigravityLogins, setAntigravityReadProblem)
    reader.current = snapshot
    antigravityReader.current = antigravitySnapshot
    const stop = snapshot.start()
    const stopAntigravity = antigravitySnapshot.start()
    return () => {
      mounted.current = false
      reader.current = null
      antigravityReader.current = null
      stop()
      stopAntigravity()
      stopChannel()
    }
  }, [])
  useEffect(() => new IpcSnapshotReader({ subject: 'Account quota', read: () => AppControl.value('usage.get', {}),
    subscribe: listener => window.appClient.onUsageChanged(listener), reportError: AppClientUiReport.error }, setUsage, setUsageProblem).start(), [])
  const dirty = label !== '' || antigravityLabel !== '' || rename !== null
  useEffect(() => {
    if (dirty === reportedDirty.current) return
    reportedDirty.current = dirty
    dirtyChange.current(dirty)
  }, [dirty])
  async function run(action: AccountAction): Promise<void> {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setProblem(null)
    try {
      const failure = await AccountsTabModel.run(action)
      if (!mounted.current) return
      setProblem(failure)
      if (failure === null) {
        setLabel('')
        setAntigravityLabel('')
        setConfirmClearAntigravity(false)
        setRemovingAntigravity(null)
        setRename(null)
        setRemoving(null)
      }
    } catch (error) { if (mounted.current) setProblem(ErrorText.of(error)) }
    finally {
      writing.current = false
      if (mounted.current) { setBusy(false); reader.current?.refresh(); antigravityReader.current?.refresh() }
    }
  }
  async function copyLink(accountId: string, link: string): Promise<void> {
    setCopied(null)
    const written = await window.appClient.clipboard.writeText(link)
    if (!mounted.current) return
    if (written.ok) setCopied(accountId)
    else setProblem(`Copying the sign-in link failed: ${written.error}`)
  }
  return <div className="jamat-accounts">
    {(problem ?? readProblem) && <p className="jamat-configuration__problem" role="alert">{problem ?? readProblem}</p>}
    <ConfigurationSection title="Add account">
      <form onSubmit={event => { event.preventDefault(); void run({ kind: 'add', agentId: 'claude', label }) }}>
        <label>Account label<input value={label} maxLength={100} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
        <button type="submit" className="jamat-configuration__button" disabled={busy || !label.trim()}>Add Claude account</button>
        <button type="button" className="jamat-configuration__button" disabled={busy || !label.trim()}
          onClick={() => void run({ kind: 'add', agentId: 'codex', label })}>Add Codex account</button>
      </form>
      <p>Complete sign-in in the terminal Jamat opens. Registration waits for the login command to finish successfully.
        A Claude login opens no browser: copy its sign-in link below and open it in the browser profile of that account.
        Antigravity CLI uses one active sign-in in the OS credential manager; save and switch Antigravity logins below.</p>
    </ConfigurationSection>
    <p>Identity comes from local account metadata. It does not verify current token validity.</p>
    {accounts === null && <p>Reading accounts…</p>}
    {usageProblem && <p className="jamat-usage__muted">Quota is not available: {usageProblem}</p>}
    {accounts?.map(account => <ConfigurationSection key={`${account.agentId}/${account.accountId}`} title={`${account.agentId}: ${account.label}`}>
      <p>{account.identity?.label ?? 'No identity recorded'} · {AccountsTabModel.stateLabel(account.state)}</p>
      {usage !== null && <AccountQuota label={account.label} now={usage.capturedAt} quota={usage.accounts.find(item =>
        item.key.agentId === account.agentId && item.key.accountId === account.accountId)} />}
      {account.profileProblem && <p role="alert" className="jamat-configuration__problem">{account.profileProblem}</p>}
      {account.loginLink !== undefined && <div className="jamat-accounts__actions">
        <button type="button" className="jamat-configuration__button" onClick={() => void copyLink(account.accountId, account.loginLink!)}>
          Copy sign-in link</button>
        {copied === account.accountId && <span role="status">Copied. Open it in the browser profile of this account.</span>}
      </div>}
      {!account.isMain && <div className="jamat-accounts__actions">
        {AccountsTabModel.canLogin(account.state) && <button type="button" disabled={busy}
          className="jamat-configuration__button" onClick={() => void run({ kind: 'login', accountId: account.accountId })}>Log in again</button>}
        <button type="button" disabled={busy} className="jamat-configuration__button"
          onClick={() => setRename({ accountId: account.accountId, label: account.label })}>Rename</button>
        <button type="button" disabled={busy} className="jamat-configuration__button"
          onClick={() => void run({ kind: 'enable', accountId: account.accountId, enabled: account.state === 'disabled' })}>
          {account.state === 'disabled' ? 'Enable' : 'Disable'}</button>
        <button type="button" disabled={busy} className="jamat-configuration__button" onClick={() => setRemoving(account.accountId)}>Remove</button>
      </div>}
      {rename?.accountId === account.accountId && <form onSubmit={event => { event.preventDefault(); void run({ kind: 'rename', ...rename }) }}>
        <label>New label<input value={rename.label} maxLength={100} disabled={busy} onChange={event => setRename({ ...rename, label: event.target.value })} /></label>
        <button type="submit" disabled={busy || !rename.label.trim()} className="jamat-configuration__button">Save label</button>
        <button type="button" disabled={busy} className="jamat-configuration__button" onClick={() => setRename(null)}>Cancel rename</button>
      </form>}
      {removing === account.accountId && <div role="group" aria-label="Confirm account removal">
        <p>Remove {account.label} and its private profile? The main profile stays untouched.</p>
        <button type="button" disabled={busy} className="jamat-configuration__button" onClick={() => void run({ kind: 'remove', accountId: account.accountId })}>Confirm remove</button>
        <button type="button" disabled={busy} className="jamat-configuration__button" onClick={() => setRemoving(null)}>Cancel removal</button>
      </div>}
    </ConfigurationSection>)}
    <ConfigurationSection title="Antigravity logins">
      {antigravityReadProblem && <p className="jamat-configuration__problem" role="alert">{antigravityReadProblem}</p>}
      {antigravityLogins === null && !antigravityReadProblem && <p>Reading Antigravity logins…</p>}
      {antigravityLogins !== null && !antigravityLogins.available && <p className="jamat-usage__muted">
        {antigravityLogins.unavailableReason ?? 'Antigravity login switching is not available.'}</p>}
      {antigravityLogins !== null && antigravityLogins.available && <>
        <p>{antigravityStatusText(antigravityLogins)}</p>
        {antigravityLogins.runningSessionCount > 0 && <p className="jamat-usage__muted">
          {antigravityLogins.runningSessionCount} Antigravity {antigravityLogins.runningSessionCount === 1 ? 'session is' : 'sessions are'} running.
          Restart or open a new session after switching to use the new login.</p>}
        <form onSubmit={event => { event.preventDefault(); void run({ kind: 'antigravity-store', label: antigravityLabel }) }}>
          <label>Store current login as<input value={antigravityLabel} maxLength={80}
            disabled={busy || !antigravityLogins.currentPresent} onChange={event => setAntigravityLabel(event.target.value)} /></label>
          <button type="submit" className="jamat-configuration__button"
            disabled={busy || !antigravityLogins.currentPresent || !antigravityLabel.trim()}>Store current login</button>
        </form>
        <div className="jamat-accounts__actions">
          <button type="button" className="jamat-configuration__button" disabled={busy || !antigravityLogins.currentPresent}
            onClick={() => setConfirmClearAntigravity(true)}>Clear current login</button>
          <button type="button" className="jamat-configuration__button" disabled={busy || antigravityLogins.currentPresent}
            onClick={() => void run({ kind: 'antigravity-login' })}>New login</button>
          <button type="button" className="jamat-configuration__button" disabled={busy}
            onClick={() => { antigravityReader.current?.refresh(); reader.current?.refresh() }}>Refresh status</button>
        </div>
        {confirmClearAntigravity && <div role="group" aria-label="Confirm clearing Antigravity login">
          <p>Clear the active Antigravity login from Windows Credential Manager without running /logout? Store it first if you want to switch back later.</p>
          <button type="button" disabled={busy} className="jamat-configuration__button"
            onClick={() => void run({ kind: 'antigravity-clear' })}>Confirm clear</button>
          <button type="button" disabled={busy} className="jamat-configuration__button"
            onClick={() => setConfirmClearAntigravity(false)}>Cancel clear</button>
        </div>}
        <p className="jamat-usage__muted">To add another account: store the current login, clear it (without /logout), click New login to sign in with agy, then store the new login once status updates automatically.</p>
        {antigravityLogins.logins.length === 0
          ? <p className="jamat-usage__muted">No saved Antigravity logins yet.</p>
          : <ul className="jamat-accounts__saved-list">
            {antigravityLogins.logins.map(slot => <li key={slot.id} className="jamat-accounts__saved-item">
              <div className="jamat-accounts__saved-meta">
                <strong>{slot.label}</strong>
                {slot.email && <span>{slot.email}{slot.planTier ? ` · ${slot.planTier}` : ''}</span>}
                {slot.active && <span className="jamat-usage__chip">Active</span>}
              </div>
              {slot.quota !== null && <div className="jamat-accounts__quota" role="group" aria-label={`${slot.label} saved quota`}>
                <QuotaWindow label={`${slot.label} 5-hour used`} name="5h" window={slot.quota.session} now={antigravityLogins.capturedAt} />
                <QuotaWindow label={`${slot.label} weekly used`} name="Week" window={slot.quota.weekly} now={antigravityLogins.capturedAt} />
                <span className="jamat-usage__chip">seen {UsageModel.relative(slot.quota.capturedAt, antigravityLogins.capturedAt)}</span>
              </div>}
              <div className="jamat-accounts__actions">
                <button type="button" disabled={busy || slot.active} className="jamat-configuration__button"
                  onClick={() => void run({ kind: 'antigravity-switch', slotId: slot.id })}>Switch login</button>
                {antigravityLogins.reopenableSessionCount > 0 && <button type="button" disabled={busy || slot.active}
                  className="jamat-configuration__button"
                  onClick={() => void run({ kind: 'antigravity-switch', slotId: slot.id, reopenRunning: true })}>
                  {antigravityLogins.reopenableSessionCount === 1
                    ? 'Switch & reopen'
                    : `Switch & reopen (${antigravityLogins.reopenableSessionCount})`}</button>}
                <button type="button" disabled={busy || !antigravityLogins.currentPresent} className="jamat-configuration__button"
                  onClick={() => void run({ kind: 'antigravity-update', slotId: slot.id })}>Update</button>
                <button type="button" disabled={busy} className="jamat-configuration__button"
                  onClick={() => setRemovingAntigravity(slot.id)}>Remove</button>
              </div>
              {removingAntigravity === slot.id && <div role="group" aria-label={`Confirm removing ${slot.label}`}>
                <p>Remove saved Antigravity login {slot.label}? The active login stays untouched.</p>
                <button type="button" disabled={busy} className="jamat-configuration__button"
                  onClick={() => void run({ kind: 'antigravity-remove', slotId: slot.id })}>Confirm remove</button>
                <button type="button" disabled={busy} className="jamat-configuration__button"
                  onClick={() => setRemovingAntigravity(null)}>Cancel remove</button>
              </div>}
            </li>)}
          </ul>}
      </>}
    </ConfigurationSection>
  </div>
}
