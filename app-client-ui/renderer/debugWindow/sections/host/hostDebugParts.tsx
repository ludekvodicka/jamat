import type {
  HostDebugRuntimeRow,
  HostDebugStatus,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { DebugTimeFormat } from '../debugTimeFormat'
import { HostDebugFormat } from './hostDebugFacts'
import { HostDebugModel } from './hostDebugModel'

/**
 * What every node of the host tree draws the same way. The header is on all of them on purpose:
 * switching to the runtimes of a Host must not take away whether that Host is even up.
 */
export function HostHeader(props: {
  status: HostDebugStatus | null
  onRefresh: () => void
  /** Whatever else this node offers, which is the ping and the start on the overview alone. */
  children?: React.ReactNode
}): React.JSX.Element {
  const { status } = props
  return (
    <header className="jamat-debug-host__head">
      <span className="jamat-debug-host__headline">
        {status ? HostDebugModel.headline(status).text : 'Reading the Host…'}
      </span>
      {status && (
        <>
          <HostVerdict label="version" value={HostDebugModel.versionVerdict(status)} good="current" />
          <HostVerdict label="protocol" value={HostDebugModel.protocolVerdict(status)} good="match" />
        </>
      )}
      <span className="jamat-debug-host__actions">
        <button className="jamat-debug-host__button" type="button" onClick={props.onRefresh}>
          Refresh
        </button>
        {props.children}
      </span>
    </header>
  )
}

/** A verdict reads as a word, and the one word that is not the good one is marked as such. */
export function HostVerdict(
  props: { label: string; value: string; good: string },
): React.JSX.Element {
  return (
    <span
      className={props.value === props.good
        ? 'jamat-debug-host__verdict'
        : 'jamat-debug-host__verdict jamat-debug-host__verdict--off'}
    >
      {`${props.label}: ${props.value}`}
    </span>
  )
}

export function HostFacts(
  props: { title: string; facts: readonly [string, string][] },
): React.JSX.Element {
  return (
    <section className="jamat-debug-host__block">
      <h2 className="jamat-debug-host__title">{props.title}</h2>
      <dl className="jamat-debug-host__facts">
        {props.facts.map(([label, value]) => (
          <div className="jamat-debug-host__fact" key={label}>
            <dt className="jamat-debug-host__label">{label}</dt>
            <dd className="jamat-debug-host__value">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * Dead runtimes are in the table on purpose: the difference between what this client believes and
 * what the Host is actually holding is the whole reason to draw it.
 */
export function HostRuntimesTable(
  props: { rows: readonly HostDebugRuntimeRow[] },
): React.JSX.Element {
  if (props.rows.length === 0)
    return <p className="jamat-debug-host__empty">The Host is holding no runtime.</p>
  return (
    <table className="jamat-debug-host__table">
      <thead>
        <tr>
          <th>Runtime</th>
          <th>Session</th>
          <th>State</th>
          <th>Pid</th>
          <th>Gen</th>
          <th>Started</th>
          <th>Ended</th>
          <th>Output</th>
          <th>Work</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => (
          <tr key={`${row.runtimeSessionId}:${row.generation}`}>
            <td>{row.runtimeSessionId}</td>
            <td>{row.orphan ? 'orphan' : row.sessionTitle ?? '—'}</td>
            <td>{HostDebugFormat.life(row)}</td>
            <td>{HostDebugFormat.number(row.pid)}</td>
            <td>{row.generation}</td>
            <td>{DebugTimeFormat.at(row.startedAt)}</td>
            <td>{DebugTimeFormat.at(row.exitedAt)}</td>
            <td>{`#${row.outputSeq} · ${DebugTimeFormat.at(row.lastOutputAt)}`}</td>
            <td>{HostDebugFormat.work(row)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** What a node draws before the first read answers, so no screen is blank without saying why. */
export function HostWaiting(props: { problem: string | null }): React.JSX.Element {
  if (props.problem !== null)
    return <p className="jamat-debug-host__problem" role="alert">{props.problem}</p>
  return <p className="jamat-debug-host__empty">Reading the Host…</p>
}
