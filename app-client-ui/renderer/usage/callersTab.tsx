import { useEffect, useRef, useState } from 'react'
import type { AccountCallersView } from '../../../lib-orchestrator/agentAccounts/accountBrokerApi.types'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { UsageModel } from './usageModel'

/** Tools > Usage > Callers: who asked the account broker in the last days, as the library summarized it. */
export function CallersTab(): React.JSX.Element {
  const [view, setView] = useState<AccountCallersView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => new IpcSnapshotReader({ subject: 'Callers',
    read: () => AppControl.value('usage.callers', {}),
    subscribe: changed => window.appClient.onUsageCallersChanged(changed),
    reportError: message => console.error(message),
  }, setView, setError).start(), [])
  return <section aria-label="Callers" className="jamat-usage__card jamat-usage__callers">
    <h2>Callers</h2>
    <p className="jamat-usage__muted">
      Calls that did not reach this Jamat are not listed: a caller that ran on Main because Jamat was closed or did not answer leaves no row here.
    </p>
    {error && <p role="alert" className="jamat-usage__alert">{error}</p>}
    {!view && !error && <p role="status" className="jamat-usage__empty">Reading callers…</p>}
    {view && <BrokerCommand command={view.command} />}
    {view && view.callers.length === 0 && <p className="jamat-usage__empty">
      No caller asked the account broker in the last {view.windowDays} days. A caller appears here after it
      runs <code>accounts pick</code> against this Jamat.
    </p>}
    {view && view.callers.length > 0 && <>
      <table className="jamat-usage__table" aria-label="Callers by last call">
        <thead><tr><th>Caller</th><th>Last call</th><th className="jamat-usage__number">Calls</th>
          <th className="jamat-usage__number">Fallbacks</th><th>Purposes</th><th>Accounts</th></tr></thead>
        <tbody>{view.callers.map(caller => <tr key={caller.caller}>
          <td className="jamat-usage__strong">{caller.caller}</td>
          <td title={UsageModel.when(caller.lastAt, view.capturedAt)}>{UsageModel.relative(caller.lastAt, view.capturedAt)}</td>
          <td className="jamat-usage__number">{caller.calls}</td>
          <td className="jamat-usage__number">{caller.fallbacks}</td>
          <td>{`interactive ${caller.purposes.interactive} · background ${caller.purposes.background}`}</td>
          <td>{caller.accounts.map(account => `${account.label} ${account.calls}`).join(' · ')}</td>
        </tr>)}</tbody>
      </table>
      <h3>Recent calls</h3>
      <table className="jamat-usage__table" aria-label="Recent calls">
        <thead><tr><th>Time</th><th>Caller</th><th>Purpose</th><th>Account</th><th>Answer</th>
          <th className="jamat-usage__number">Took</th></tr></thead>
        <tbody>{view.recent.map((entry, index) => <tr key={`${entry.at}-${entry.caller}-${index}`}>
          <td>{UsageModel.when(entry.at, view.capturedAt)}</td>
          <td>{entry.caller}</td>
          <td>{entry.purpose}</td>
          <td>{entry.accountLabel}</td>
          <td>{entry.fallback ? `Fallback: ${entry.reason}` : 'Chosen'}</td>
          <td className="jamat-usage__number">{`${entry.durationMs} ms`}</td>
        </tr>)}</tbody>
      </table>
    </>}
  </section>
}

/** The broker command of this instance as the orchestrator built it, to paste into a client's setting. */
function BrokerCommand({ command }: { command: string | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  if (command === null)
    return <p className="jamat-usage__empty">The Jamat CLI skill link is missing, so this Jamat has no broker command to copy.</p>
  async function copy(text: string): Promise<void> {
    setCopied(false)
    setProblem(null)
    const written = await window.appClient.clipboard.writeText(text)
    if (!mounted.current) return
    if (written.ok) setCopied(true)
    else setProblem(`Copying the broker command failed: ${written.error}`)
  }
  return <div className="jamat-usage__toolbar">
    <span className="jamat-usage__muted">Broker command</span>
    <code className="jamat-usage__command">{command}</code>
    <button type="button" onClick={() => void copy(command)}>Copy</button>
    {copied && <span role="status">Copied</span>}
    {problem && <span role="alert" className="jamat-usage__alert">{problem}</span>}
  </div>
}
