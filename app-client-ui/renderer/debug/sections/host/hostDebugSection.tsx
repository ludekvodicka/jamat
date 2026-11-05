import { useEffect } from 'react'

import { HostDebugFacts } from './hostDebugFacts'
import { HostDebugModel } from './hostDebugModel'
import { HostFacts, HostHeader } from './hostDebugParts'
import { useHostDebugStatus } from './useHostDebugStatus'

/**
 * The root of the host tree: whether the Host is there, whether it is the one this tree would run,
 * and whether it still answers. What it is holding and how it was reached hang under it as their own
 * nodes.
 *
 * This is the one node that draws a ping, which is why it is the one that asks for one - on mount,
 * and on the button. The main process's own loop pings only while this node is the one on screen.
 */
export function HostDebugSection(): React.JSX.Element {
  const host = useHostDebugStatus()
  const { dispatch } = host

  useEffect(() => {
    dispatch({ input: 'ping-started' })
  }, [dispatch])

  const status = host.state.status
  return (
    <div className="jamat-debug-host">
      <HostHeader status={status} onRefresh={host.refresh}>
        <button
          className="jamat-debug-host__button"
          type="button"
          disabled={host.state.pinging}
          onClick={() => dispatch({ input: 'ping-started' })}
        >
          Ping
        </button>
        {status && HostDebugModel.headline(status).startable && (
          <button
            className="jamat-debug-host__button"
            type="button"
            onClick={() => dispatch({ input: 'start-host' })}
          >
            Start Host
          </button>
        )}
      </HostHeader>

      {host.state.problem !== null && (
        <p className="jamat-debug-host__problem" role="alert">{host.state.problem}</p>
      )}

      <HostFacts title="Ping" facts={HostDebugFacts.ping(host.state)} />

      {status && (
        <HostFacts
          title="Counts"
          facts={[
            ['Live runtimes', String(status.counts.live)],
            ['Dead runtimes', String(status.counts.dead)],
            ['Orphaned', String(status.counts.orphans)],
          ]}
        />
      )}
    </div>
  )
}
