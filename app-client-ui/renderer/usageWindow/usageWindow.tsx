import { useEffect, useState } from 'react'
import type { UsageSnapshot } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { TokensSection } from './tokensSection'
import { PoolGraph } from './poolGraph'
import { UsageWindowModel } from './usageWindowModel'

export function UsageWindow(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => new IpcSnapshotReader({ subject: 'Usage',
    read: () => AppControl.value('usage.get', {}),
    subscribe: changed => window.appClient.onUsageChanged(changed),
    reportError: message => console.error(message),
  }, setSnapshot, setError).start(), [])
  return <main className="jamat-usage">
    <h1>Usage</h1>
    {error && <p role="alert">{error}</p>}
    {!snapshot && <p role="status">Reading usage…</p>}
    {snapshot?.pools.map(pool => <section key={pool.agentId} aria-label={`${pool.agentId} quota`}>
      <h2>{UsageWindowModel.agentLabels[pool.agentId]} · {pool.weeklyCapacity / 100} accounts</h2>
      {(pool.weeklyKnown < pool.weeklyCapacity / 100 || pool.sessionKnown < pool.sessionCapacity / 100) &&
        <p role="status">Partial quota: weekly readings for {pool.weeklyKnown} accounts, 5-hour readings for {pool.sessionKnown}. Missing readings are unknown.</p>}
      <p>Known weekly pool: <strong>{pool.weeklyRemaining.toFixed(0)}% of {pool.weeklyCapacity}%</strong>
        {' · '}5-hour pool: {pool.sessionRemaining.toFixed(0)}% of {pool.sessionCapacity}%</p>
      <PoolGraph agentId={pool.agentId} labels={Object.fromEntries(snapshot.accounts.filter(account => account.key.agentId === pool.agentId).map(account => [account.key.accountId, account.label]))} />
      <div className="jamat-usage__cards">
        {snapshot.accounts.filter(account => account.key.agentId === pool.agentId).map(account => {
          const windows = account.estimated?.windows ?? ('windows' in account.state ? account.state.windows : [])
          return <article key={account.key.accountId} className="jamat-usage__card">
            <h3>{account.label}</h3>
            <p>{account.accountState} · {UsageWindowModel.measurement(account)}</p>
            {[300, 10080].map(duration => {
              const window = windows.find(item => item.durationMinutes === duration && !item.model)
              return <div key={duration}><strong>{duration === 300 ? '5-hour' : 'Weekly'}</strong>
                <p>{window ? `${window.usedPercent.toFixed(0)}% used` : 'No reading'}</p>
                {window && <progress max={100} value={window.usedPercent} aria-label={`${account.label} ${duration === 300 ? '5-hour' : 'weekly'} used`} />}
                <p>Reset: {UsageWindowModel.reset(window?.resetsAt ?? null)}</p>
              </div>
            })}
          </article>
        })}
      </div>
    </section>)}
    <TokensSection />
  </main>
}
