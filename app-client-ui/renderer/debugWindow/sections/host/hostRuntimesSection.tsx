import { HostHeader, HostRuntimesTable, HostWaiting } from './hostDebugParts'
import { useHostDebugStatus } from './useHostDebugStatus'

/**
 * What the Host is actually holding, joined to what this client has a record of. Dead runtimes stay
 * in the table and a runtime with no record is marked as an orphan, because the difference between
 * the two sides is the only reason to draw it.
 */
export function HostRuntimesSection(): React.JSX.Element {
  const host = useHostDebugStatus()
  const status = host.state.status
  return (
    <div className="jamat-debug-host">
      <HostHeader status={status} onRefresh={host.refresh} />
      {status === null
        ? <HostWaiting problem={host.state.problem} />
        : (
            <section className="jamat-debug-host__block">
              <h2 className="jamat-debug-host__title">
                {`${status.counts.live} live · ${status.counts.dead} dead · `
                  + `${status.counts.orphans} orphaned`}
              </h2>
              <HostRuntimesTable rows={status.runtimes} />
            </section>
          )}
    </div>
  )
}
