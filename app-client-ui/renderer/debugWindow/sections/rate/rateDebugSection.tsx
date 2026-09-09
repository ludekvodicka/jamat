import { useEffect, useRef, useState } from 'react'

import type {
  RateAgentId,
  RateMonitorDebugStatus,
  RateProviderDebug,
} from '../../../../../lib-orchestrator/rateMonitor/rateMonitorApi.types'
import { ErrorText } from '../../../../shared/errorText'
import { IpcSnapshotReader } from '../../../ipc/ipcSnapshotReader'
import { DebugTimeFormat } from '../debugTimeFormat'
import { RateDebugEffects, type RateDebugPorts } from './rateDebugEffects'
import { RateDebugModel, type RateDebugState } from './rateDebugModel'

export function RateDebugSection(): React.JSX.Element {
  return <RateDebugPage />
}

export function RateCodexSection(): React.JSX.Element {
  return <RateDebugPage agentId="codex" />
}

export function RateClaudeSection(): React.JSX.Element {
  return <RateDebugPage agentId="claude" />
}

/**
 * One implementation behind the rate root and both provider nodes. The root draws the shared poll
 * facts; a child draws the chosen provider's unreduced answer. Only the selected node is mounted, so
 * all three use the same reader without keeping three subscriptions alive.
 *
 * It reads on mount and whenever the monitor says something moved, and it has no timer of its own on
 * purpose. Rate data cannot move faster than the monitor's ten-minute cadence and the 180-second
 * floor on the Claude side, so a clock here would only redraw a value nobody had re-read.
 */
function RateDebugPage(props: { agentId?: RateAgentId }): React.JSX.Element {
  const [start] = useState(() => RateDebugModel.initial())
  const [state, setState] = useState<RateDebugState>(start)
  // Read through a ref rather than through the rendered state: a push arriving while a refresh is in
  // flight has to see what the refresh decided, not what React has drawn.
  const stateRef = useRef<RateDebugState>(start)
  const reader = useRef<IpcSnapshotReader<RateMonitorDebugStatus> | null>(null)

  const [ports] = useState<RateDebugPorts>(() => {
    const self: RateDebugPorts = {
      readAgain: () => reader.current?.refresh(),
      dispatch: (input) => {
        const step = RateDebugModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        for (const effect of step.effects)
          // Caught, not only voided: a rejecting invoke was an unhandled rejection rather than the
          // `failed` input this model already has an arm for.
          void RateDebugEffects.run(effect, self)
            .catch((error: unknown) => self.dispatch({ input: 'failed', detail: ErrorText.of(error) }))
      },
    }
    return self
  })

  /**
   * Through the reader every other push-plus-read pair in this window uses, rather than a
   * subscription of its own.
   *
   * A push carries nothing, so each one meant a full `rate:debug-status` read - both providers' raw
   * payloads - with no coalescing, no single-flight, no give-up and no unmount guard. The reader is
   * where those four rules live, and it is generic precisely so the second reader of a snapshot does
   * not copy them.
   */
  useEffect(() => {
    const engine = new IpcSnapshotReader<RateMonitorDebugStatus>(
      {
        subject: 'The rate limits debug status',
        read: () => window.appClient.rateMonitor.debugStatus(),
        subscribe: (onChanged) => window.appClient.onRateChanged(onChanged),
        reportError: (message) => console.error(message),
      },
      (status) => ports.dispatch({ input: 'status-arrived', status }),
      (problem) => {
        if (problem !== null)
          ports.dispatch({ input: 'failed', detail: problem })
      },
    )
    reader.current = engine
    return engine.start()
  }, [ports])

  const status = state.status
  return (
    <div className="jamat-debug-rate">
      <header className="jamat-debug-rate__head">
        <span className="jamat-debug-rate__headline">
          {status === null
            ? 'Reading the rate monitor…'
            : `Rate limits · composed ${DebugTimeFormat.at(status.capturedAt)}`}
        </span>
        <span className="jamat-debug-rate__actions">
          <button
            className="jamat-debug-rate__button"
            type="button"
            disabled={state.refreshing}
            onClick={() => ports.dispatch({ input: 'refresh-asked' })}
          >
            Refresh
          </button>
        </span>
      </header>

      {state.problem !== null && (
        <p className="jamat-debug-rate__problem" role="alert">{state.problem}</p>
      )}

      {status === null
        ? <p className="jamat-debug-rate__empty">Nothing has been read from the monitor yet.</p>
        : props.agentId === undefined
          ? (
              <section className="jamat-debug-rate__block">
                <h2 className="jamat-debug-rate__title">Poll</h2>
                <RateFacts facts={RateDebugModel.pollFactsOf(status)} />
              </section>
            )
          : (
              <RateProviderBlock
                agentId={props.agentId}
                provider={status.providers[props.agentId]}
                now={status.capturedAt}
              />
            )}
    </div>
  )
}

/**
 * One provider, in the order the questions get asked: what state is it in, when was it last asked and
 * when did it last answer, what did the answer contain, and what did the wire actually carry.
 */
function RateProviderBlock(
  props: { agentId: RateAgentId; provider: RateProviderDebug; now: number },
): React.JSX.Element {
  const { provider, now } = props
  const windows = RateDebugModel.windowsOf(provider.state)
  return (
    <section className="jamat-debug-rate__block">
      <h2 className="jamat-debug-rate__title">{RateDebugModel.titleOf(props.agentId)}</h2>
      <RateFacts facts={RateDebugModel.providerFactsOf(provider, now)} />

      <h3 className="jamat-debug-rate__subtitle">Windows</h3>
      {windows.length === 0
        ? <p className="jamat-debug-rate__empty">No window was returned.</p>
        : (
            <table className="jamat-debug-rate__table">
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Model</th>
                  <th>Used</th>
                  <th>Resets</th>
                </tr>
              </thead>
              <tbody>
                {windows.map((rateWindow) => {
                  const [length, model, used, resets] = RateDebugModel.windowRowOf(rateWindow)
                  return (
                    <tr key={`${rateWindow.durationMinutes}:${rateWindow.model ?? ''}`}>
                      <td>{length}</td>
                      <td>{model}</td>
                      <td>{used}</td>
                      <td>{resets}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

      <h3 className="jamat-debug-rate__subtitle">Extras</h3>
      {provider.extras.length === 0
        ? <p className="jamat-debug-rate__empty">The answer carried no fact without a window.</p>
        : <RateFacts facts={RateDebugModel.extraFactsOf(provider.extras)} />}

      <h3 className="jamat-debug-rate__subtitle">Raw payload</h3>
      <pre className="jamat-debug-rate__raw">{RateDebugModel.rawOf(provider.raw)}</pre>
    </section>
  )
}

/** One fact per line, the way the host screens read them: a label to look for and a value across. */
function RateFacts(props: { facts: readonly [string, string][] }): React.JSX.Element {
  return (
    <dl className="jamat-debug-rate__facts">
      {props.facts.map(([label, value], index) => (
        <div className="jamat-debug-rate__fact" key={`${index}:${label}`}>
          <dt className="jamat-debug-rate__label">{label}</dt>
          <dd className="jamat-debug-rate__value">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
