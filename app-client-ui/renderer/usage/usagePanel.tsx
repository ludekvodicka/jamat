import { useEffect, useState } from 'react'
import type { DockviewPanelApi } from 'dockview'
import type { UsageSnapshot } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import { AppControl } from '../ipc/appControl'
import { CallersTab } from './callersTab'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { QuotaCard } from './quotaCard'
import { TokensSection } from './tokensSection'
import './usagePanel.css'

type UsageTab = 'quota' | 'consumption' | 'callers'

const usageTabsConst: readonly (readonly [UsageTab, string])[] = [['quota', 'Quota'], ['consumption', 'Consumption'], ['callers', 'Callers']]

/**
 * The Tools > Usage tab: Quota holds one quota card per agent that has an enabled account;
 * Consumption holds the token statistics of sessions and of reported third-party runs; Callers
 * lists who asked the account broker.
 *
 * Nothing reads while the tab is hidden behind another one: the readers stop, keep what they showed,
 * and read once when the tab is shown again. A hidden Usage tab used to re-read and redraw its charts
 * on every usage change.
 */
export function UsagePanel({ api }: { api?: Pick<DockviewPanelApi, 'isVisible' | 'onDidVisibilityChange'> }): React.JSX.Element {
  const [tab, setTab] = useState<UsageTab>('quota')
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(api?.isVisible ?? true)
  useEffect(() => {
    if (!api) return
    setVisible(api.isVisible)
    const subscription = api.onDidVisibilityChange(event => setVisible(event.isVisible))
    return () => subscription.dispose()
  }, [api])
  useEffect(() => visible ? new IpcSnapshotReader({ subject: 'Usage',
    read: () => AppControl.value('usage.get', {}),
    subscribe: changed => window.appClient.onUsageChanged(changed),
    reportError: message => console.error(message),
  }, setSnapshot, setError).start() : undefined, [visible])
  return <main className="jamat-usage">
    <div className="jamat-usage__tabs" role="tablist" aria-label="Usage">
      {usageTabsConst.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id}
          className={`jamat-usage__tab${tab === id ? ' jamat-usage__tab--selected' : ''}`}
          onClick={() => setTab(id)}>{label}</button>
      ))}
    </div>
    {usageBody(tab, snapshot, error, visible)}
  </main>
}

function usageBody(tab: UsageTab, snapshot: UsageSnapshot | null, error: string | null, visible: boolean): React.JSX.Element {
  switch (tab) {
    case 'quota': return <QuotaBody snapshot={snapshot} error={error} visible={visible} />
    case 'consumption': return <TokensSection visible={visible} />
    case 'callers': return <CallersTab />
    default: throw new Error(`Unknown usage tab: ${JSON.stringify(tab)}`)
  }
}

function QuotaBody({ snapshot, error, visible }: { snapshot: UsageSnapshot | null; error: string | null; visible: boolean }): React.JSX.Element {
  const pools = snapshot?.pools.filter(pool => pool.weeklyCapacity > 0) ?? []
  return <>
    {error && <p role="alert" className="jamat-usage__alert">{error}</p>}
    {!snapshot && !error && <p role="status" className="jamat-usage__empty">Reading usage…</p>}
    {snapshot && pools.length === 0 && <p className="jamat-usage__empty">No enabled agent accounts.</p>}
    {snapshot && pools.length > 0 && <div className="jamat-usage__quotas">
      {pools.map(pool => <QuotaCard key={pool.agentId} pool={pool} now={snapshot.capturedAt} visible={visible}
        accounts={snapshot.accounts.filter(account => account.key.agentId === pool.agentId)} />)}
    </div>}
  </>
}
