import { useEffect, useRef, useState } from 'react'
import type { AccountView } from '../../../../../../lib-orchestrator/agentAccounts/agentAccountsApi.types'
import { AppClientUiReport } from '../../../../../shared/appClientUiReport'
import { ErrorText } from '../../../../../shared/errorText'
import { AppControl } from '../../../../ipc/appControl'
import { IpcSnapshotReader } from '../../../../ipc/ipcSnapshotReader'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import { ConfigurationSection } from '../../configurationSection'
import { AccountsTabModel, type AccountAction } from './accountsTabModel'
import './accountsTab.css'

export function AccountsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [accounts, setAccounts] = useState<readonly AccountView[] | null>(null)
  const [label, setLabel] = useState('')
  const [rename, setRename] = useState<{ accountId: string; label: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [readProblem, setReadProblem] = useState<string | null>(null)
  const reader = useRef<IpcSnapshotReader<readonly AccountView[]> | null>(null)
  const mounted = useRef(false)
  const writing = useRef(false)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  useEffect(() => {
    mounted.current = true
    const snapshot = new IpcSnapshotReader({ subject: 'Accounts', read: () => AppControl.value('accounts.list', {}),
      subscribe: listener => window.appClient.onAgentSettingsChanged(listener), reportError: AppClientUiReport.error }, setAccounts, setReadProblem)
    reader.current = snapshot
    const stop = snapshot.start()
    return () => { mounted.current = false; reader.current = null; stop() }
  }, [])
  const dirty = label !== '' || rename !== null
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
      if (failure === null) { setLabel(''); setRename(null); setRemoving(null) }
    } catch (error) { if (mounted.current) setProblem(ErrorText.of(error)) }
    finally {
      writing.current = false
      if (mounted.current) { setBusy(false); reader.current?.refresh() }
    }
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
      <p>Complete sign-in in the terminal Jamat opens. Registration waits for the login command to finish successfully.</p>
    </ConfigurationSection>
    <p>Identity comes from local account metadata. It does not verify current token validity.</p>
    {accounts === null && <p>Reading accounts…</p>}
    {accounts?.map(account => <ConfigurationSection key={`${account.agentId}/${account.accountId}`} title={`${account.agentId}: ${account.label}`}>
      <p>{account.identity?.label ?? 'No identity recorded'} · {AccountsTabModel.stateLabel(account.state)}</p>
      {account.profileProblem && <p role="alert" className="jamat-configuration__problem">{account.profileProblem}</p>}
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
  </div>
}
