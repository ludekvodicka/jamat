import { useEffect, useMemo, useState } from 'react'
import type { PoolSeries, UsageAccount, UsagePool } from '../../../lib-orchestrator/rateMonitor/usageApi.types'
import { AppControl } from '../ipc/appControl'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { poolGraphSpec } from './poolGraphSpec'
import { UsageChart, usageChartTheme } from './usageChart'
import { type PoolRangePreset, UsageModel } from './usageModel'
import { Meter, Segmented, Tile } from './usageParts'

type BurnHours = 1 | 3 | 6
const burnOptionsConst: readonly { value: BurnHours; label: string }[] = [{ value: 1, label: '1h' }, { value: 3, label: '3h' }, { value: 6, label: '6h' }]

/**
 * One agent's quota: the pool figures, the accounts behind them when there is more than one, and
 * the recorded and projected weekly pool. A figure that has no reading is left out rather than
 * printed as `Unknown`.
 */
export function QuotaCard({ pool, accounts, now }: { pool: UsagePool; accounts: readonly UsageAccount[]; now: number }): React.JSX.Element {
  const agentId = pool.agentId
  const [burnHours, setBurnHours] = useState<BurnHours>(3)
  const [preset, setPreset] = useState<PoolRangePreset>('forecast')
  const [custom, setCustom] = useState(() => ({ from: UsageModel.localInput(Date.now() - 86_400_000), to: UsageModel.localInput(Date.now() + 7 * 86_400_000) }))
  const range = useMemo(() => preset === 'custom'
    ? { from: new Date(custom.from).getTime(), to: new Date(custom.to).getTime() }
    : UsageModel.poolRange(preset, Date.now()), [preset, custom])
  const [series, setSeries] = useState<PoolSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setSeries(null)
    setError(null)
    if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) { setError('Choose an end after the start.'); return }
    return new IpcSnapshotReader({ subject: 'Pool history',
      read: () => AppControl.value('usage.history', { agentId, from: range.from, to: range.to, burnHours }),
      subscribe: changed => window.appClient.onUsageChanged(changed), reportError: message => console.error(message),
    }, setSeries, setError).start()
  }, [agentId, range, burnHours])
  const spec = useMemo(() => series ? poolGraphSpec(series, usageChartTheme()) : null, [series])
  const historical = series !== null && (series.displayRange?.to ?? series.until) < series.now
  const label = (id: string): string => accounts.find(account => account.key.accountId === id)?.label ?? id
  const several = accounts.length > 1
  const single = several ? null : accounts[0] ?? null
  const notes = single ? [UsageModel.accountNote(single), UsageModel.readingNote(single)].filter((note): note is string => note !== null) : []
  const weekly = UsageModel.remainingShare(pool.weeklyRemaining, pool.weeklyKnown)
  const session = UsageModel.remainingShare(pool.sessionRemaining, pool.sessionKnown)
  const accountCount = pool.weeklyCapacity / 100
  const runsOutFirst = series?.poolEmptyAt != null && series.nextReset !== null && series.poolEmptyAt < series.nextReset.at

  return <section className="jamat-usage__card" aria-label={`${UsageModel.agentLabels[agentId]} quota`}>
    <header className="jamat-usage__card-head">
      <h2>{UsageModel.agentLabels[agentId]}</h2>
      <span className="jamat-usage__muted">{accountCount === 1 ? '1 account' : `${accountCount} accounts`}</span>
      {notes.map(note => <span key={note} className="jamat-usage__chip">{note}</span>)}
    </header>

    <div className="jamat-usage__tiles">
      {weekly !== null && <Tile label="Weekly left" value={`${weekly.toFixed(0)}%`} tone={UsageModel.level(weekly)}
        detail={pool.weeklyKnown < accountCount ? `${pool.weeklyKnown} of ${accountCount} accounts read` : several ? `${pool.weeklyRemaining.toFixed(0)} of ${pool.weeklyCapacity}%` : undefined} />}
      {session !== null && <Tile label="5-hour left" value={`${session.toFixed(0)}%`} tone={UsageModel.level(session)}
        detail={pool.sessionKnown < accountCount ? `${pool.sessionKnown} of ${accountCount} accounts read` : undefined} />}
      {series && !historical && <>
        <Tile label="Burn rate" value={`${series.burnPerHour.toFixed(1)}%/h`} detail={`last ${burnHours}h`} />
        {series.knownAccounts === series.totalAccounts && (series.poolEmptyAt === null
          ? <Tile label="Runs out" value="Not soon" detail={`not before ${UsageModel.when(series.until, now)}`} />
          : <Tile label="Runs out" value={UsageModel.when(series.poolEmptyAt, now)} detail={UsageModel.relative(series.poolEmptyAt, now)}
            tone={runsOutFirst ? 'danger' : undefined} title={runsOutFirst ? 'Runs out before the next reset' : undefined} />)}
        {several && series.firstEmpty && <Tile label="First account empty" value={UsageModel.when(series.firstEmpty.at, now)}
          detail={`${label(series.firstEmpty.accountId)} · ${UsageModel.relative(series.firstEmpty.at, now)}`} />}
        {series.nextReset && <Tile label="Next reset" value={UsageModel.when(series.nextReset.at, now)}
          detail={`${several ? `${label(series.nextReset.accountId)} · ` : ''}${UsageModel.relative(series.nextReset.at, now)} · +${series.nextReset.gain.toFixed(0)}%`} />}
      </>}
    </div>

    {several && <AccountRows accounts={accounts} now={now} />}

    <div className="jamat-usage__toolbar">
      <h3>Weekly pool</h3>
      <Segmented label="Range" options={UsageModel.poolRangesConst} value={preset} onChange={setPreset} />
      {preset === 'custom' && <>
        <input type="datetime-local" aria-label="From" value={custom.from} onChange={event => setCustom({ ...custom, from: event.target.value })} />
        <input type="datetime-local" aria-label="To" value={custom.to} onChange={event => setCustom({ ...custom, to: event.target.value })} />
      </>}
      <span className="jamat-usage__spacer" />
      <span className="jamat-usage__group"><span className="jamat-usage__muted">Burn from last</span>
        <Segmented label="Burn range" options={burnOptionsConst} value={burnHours} onChange={setBurnHours} /></span>
    </div>
    {error && <p role="alert" className="jamat-usage__alert">{error}</p>}
    {spec ? <UsageChart spec={spec} label={`${UsageModel.agentLabels[agentId]} ${historical ? 'recorded weekly pool' : 'recorded and projected weekly pool; projection begins at Now'}`} />
      : !error && <p role="status" className="jamat-usage__empty">{series ? 'No recorded quota in this range' : 'Reading pool history…'}</p>}
  </section>
}

function AccountRows({ accounts, now }: { accounts: readonly UsageAccount[]; now: number }): React.JSX.Element {
  const withSession = accounts.some(account => UsageModel.window(account, UsageModel.sessionMinutesConst) !== null)
  return <div className="jamat-usage__accounts" role="table" aria-label="Accounts"
    style={{ gridTemplateColumns: `minmax(80px, 1fr) repeat(${withSession ? 2 : 1}, max-content)` }}>
    {accounts.map(account => {
      const notes = [UsageModel.accountNote(account), UsageModel.readingNote(account)].filter((note): note is string => note !== null)
      const weekly = UsageModel.window(account, UsageModel.weeklyMinutesConst)
      const session = UsageModel.window(account, UsageModel.sessionMinutesConst)
      return <div key={account.key.accountId} role="row" className={`jamat-usage__account${account.enabled ? '' : ' jamat-usage__account--off'}`}>
        <span role="cell" className="jamat-usage__account-name">{account.label}{notes.map(note => <span key={note} className="jamat-usage__chip">{note}</span>)}</span>
        {withSession && <WindowCell label={`${account.label} 5-hour used`} name="5h" window={session} now={now} />}
        <WindowCell label={`${account.label} weekly used`} name="Week" window={weekly} now={now} />
      </div>
    })}
  </div>
}

function WindowCell({ label, name, window, now }: { label: string; name: string; window: ReturnType<typeof UsageModel.window>; now: number }): React.JSX.Element {
  if (!window)
    return <span role="cell" className="jamat-usage__window jamat-usage__muted" title="No reading">{name}</span>
  const reset = window.resetsAt === null ? null : new Date(window.resetsAt).getTime()
  const title = `${window.usedPercent.toFixed(0)}% used${reset === null ? '' : `, resets ${new Date(reset).toLocaleString()}`}`
  return <span role="cell" className="jamat-usage__window" title={title}>
    <span className="jamat-usage__window-name">{name}</span>
    <Meter usedPercent={window.usedPercent} label={label} />
    <span className="jamat-usage__window-value">{window.usedPercent.toFixed(0)}%</span>
    {reset !== null && <span className="jamat-usage__muted">{UsageModel.when(reset, now)}</span>}
  </span>
}
