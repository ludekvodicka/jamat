import { useEffect, useState } from 'react'
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
 */
export function UsagePanel(): React.JSX.Element {
  const [tab, setTab] = useState<UsageTab>('quota')
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => new IpcSnapshotReader({ subject: 'Usage',
    read: () => AppControl.value('usage.get', {}),
    subscribe: changed => window.appClient.onUsageChanged(changed),
    reportError: message => console.error(message),
  }, setSnapshot, setError).start(), [])
  return <main className="jamat-usage">
    <div className="jamat-usage__tabs" role="tablist" aria-label="Usage">
      {usageTabsConst.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id}
          className={`jamat-usage__tab${tab === id ? ' jamat-usage__tab--selected' : ''}`}
          onClick={() => setTab(id)}>{label}</button>
      ))}
    </div>
    {usageBody(tab, snapshot, error)}
  </main>
}

function usageBody(tab: UsageTab, snapshot: UsageSnapshot | null, error: string | null): React.JSX.Element {
  switch (tab) {
    case 'quota': return <QuotaBody snapshot={snapshot} error={error} />
    case 'consumption': return <TokensSection />
    case 'callers': return <CallersTab />
    default: throw new Error(`Unknown usage tab: ${JSON.stringify(tab)}`)
  }
}

function QuotaBody({ snapshot, error }: { snapshot: UsageSnapshot | null; error: string | null }): React.JSX.Element {
  const pools = snapshot?.pools.filter(pool => pool.weeklyCapacity > 0) ?? []
  return <>
    {error && <p role="alert" className="jamat-usage__alert">{error}</p>}
    {!snapshot && !error && <p role="status" className="jamat-usage__empty">Reading usage…</p>}
    {snapshot && pools.length === 0 && <p className="jamat-usage__empty">No enabled agent accounts.</p>}
    {snapshot && pools.length > 0 && <div className="jamat-usage__quotas">
      {pools.map(pool => <QuotaCard key={pool.agentId} pool={pool} now={snapshot.capturedAt}
        accounts={snapshot.accounts.filter(account => account.key.agentId === pool.agentId)} />)}
    </div>}
  </>
}
