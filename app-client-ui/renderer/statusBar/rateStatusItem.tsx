import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

import type {
  RateAgentId,
  RateMonitorSnapshot,
} from '../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import type { IpcResult } from '../../shared/appClientUiIpc'
import { ErrorText } from '../../shared/errorText'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { RateStatusModel } from './rateStatusModel'

export interface RateStatusPorts {
  reportError(message: string): void
  /**
   * The manual read. The library's floor under it is CLAUDE's - `flooredOut` returns false for
   * codex unconditionally - so on a Codex tab every click that lands after the last read settled is
   * a fresh app-server round trip. The gate below is what bounds that.
   */
  refresh(): Promise<IpcResult<RateMonitorSnapshot>>
}

/**
 * How much of ONE provider's limits is spent: the provider whose terminal is the tab in front. The
 * bar decides whether this widget exists at all, so the agent arrives as a prop rather than being
 * read here - by the time it is drawn there is a terminal, and the terminal is whose reading it is.
 *
 * The line is the refresh surface, as it has been since the monitor arrived, and the arrow beside it
 * is a target of its own: a click meant for claude.ai must not also cost a read.
 */
export function RateStatusItem(props: {
  agentId: RateAgentId
  ports: RateStatusPorts
  store: SnapshotStore<RateMonitorSnapshot>
}): React.JSX.Element {
  const { agentId, ports, store } = props
  const subscribe = useCallback((onChanged: () => void) => store.subscribe(onChanged), [store])
  const current = useCallback(() => store.current(), [store])
  const state = useSyncExternalStore(subscribe, current, current)
  const [refreshing, setRefreshing] = useState(false)
  // The click handler outlives the commit it was made in, so the flag it reads has to be the ref.
  const outstanding = useRef(false)

  // The answer is not read: a read that moved anything comes back as `rate:changed`, and one that
  // moved nothing is exactly what the monitor's revision gate exists to swallow.
  const refresh = (): void => {
    if (outstanding.current)
      return
    outstanding.current = true
    setRefreshing(true)
    void ports.refresh()
      .then((answer) => {
        if (!answer.ok)
          ports.reportError(`The rate limits could not be refreshed: ${answer.error}`)
      })
      .catch((thrown: unknown) =>
        ports.reportError(`The rate limits could not be refreshed: ${ErrorText.of(thrown)}`))
      .finally(() => {
        outstanding.current = false
        setRefreshing(false)
      })
  }

  if (state.error !== null)
    return (
      <span className="jamat-rate" title={state.error}>
        usage unavailable
        <button className="jamat-rate__retry" type="button" onClick={() => store.refresh()}>
          Retry
        </button>
      </span>
    )
  // Before the first snapshot arrives there is no window to letter, let alone a number.
  if (state.snapshot === null)
    return (
      <span className="jamat-rate">
        <span className="jamat-rate__absent">usage …</span>
      </span>
    )
  const reading = RateStatusModel.readingOf(state.snapshot, agentId, Date.now())
  // Held rather than read off `reading` inside the handler: a const is what keeps the narrowing.
  const usageUrl = reading.usageUrl
  return (
    <span className="jamat-rate" title={reading.tooltip}>
      <button
        className={reading.dim ? 'jamat-rate__line jamat-rate__line--dim' : 'jamat-rate__line'}
        type="button"
        aria-label={`${reading.name} usage, click to refresh`}
        disabled={refreshing}
        onClick={refresh}
      >
        {reading.text}
      </button>
      {usageUrl !== null && (
        <button
          className="jamat-rate__link"
          type="button"
          aria-label={`${reading.name} usage page`}
          title={`Open usage in a browser: ${usageUrl}`}
          onClick={() => void window.appClient.fileViewer.openExternal(usageUrl)}
        >
          ↗
        </button>
      )}
    </span>
  )
}
