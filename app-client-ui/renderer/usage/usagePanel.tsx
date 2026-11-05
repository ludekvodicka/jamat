import { useEffect, useState } from 'react'
import type { UsageSnapshot } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { QuotaCard } from './quotaCard'
import { TokensSection } from './tokensSection'
import './usagePanel.css'

/** The Tools > Usage tab: one quota card per agent that has an enabled account, then token statistics. */
export function UsagePanel(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => new IpcSnapshotReader({ subject: 'Usage',
    read: () => AppControl.value('usage.get', {}),
    subscribe: changed => window.appClient.onUsageChanged(changed),
    reportError: message => console.error(message),
  }, setSnapshot, setError).start(), [])
  const pools = snapshot?.pools.filter(pool => pool.weeklyCapacity > 0) ?? []
  return <main className="jamat-usage">
    {error && <p role="alert" className="jamat-usage__alert">{error}</p>}
    {!snapshot && !error && <p role="status" className="jamat-usage__empty">Reading usage…</p>}
    {snapshot && pools.length === 0 && <p className="jamat-usage__empty">No enabled agent accounts.</p>}
    {snapshot && pools.length > 0 && <div className="jamat-usage__quotas">
      {pools.map(pool => <QuotaCard key={pool.agentId} pool={pool} now={snapshot.capturedAt}
        accounts={snapshot.accounts.filter(account => account.key.agentId === pool.agentId)} />)}
    </div>}
    <TokensSection />
  </main>
}
