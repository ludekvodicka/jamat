import { useEffect, useState } from 'react'

import { HostDebugFacts } from './hostDebugFacts'
import { HostFacts, HostHeader, HostWaiting } from './hostDebugParts'
import { useHostDebugStatus } from './useHostDebugStatus'

/**
 * How this client is talking to the Host: the file it watches for one, the socket it listens on, the
 * authority it holds, and the single poll behind everything the workspace draws.
 */
export function HostConnectionSection(): React.JSX.Element {
  const host = useHostDebugStatus()
  const status = host.state.status

  // The lease counts down, so this screen keeps a second hand. It runs only while there is a lease
  // to count and stops with the node, so nothing ticks for a screen nobody is looking at.
  const [now, setNow] = useState(() => Date.now())
  const counting = status?.lease.expiresAt != null
  useEffect(() => {
    if (!counting)
      return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [counting])

  return (
    <div className="jamat-debug-host">
      <HostHeader status={status} onRefresh={host.refresh} />
      {status === null
        ? <HostWaiting problem={host.state.problem} />
        : (
            <>
              <HostFacts title="Descriptor watch" facts={HostDebugFacts.watcher(status)} />
              <HostFacts title="Events socket" facts={HostDebugFacts.eventsSocket(status)} />
              <HostFacts title="Controller lease" facts={HostDebugFacts.lease(status, now)} />
              <HostFacts title="Reconcile" facts={HostDebugFacts.reconcile(status)} />
              <HostFacts title="Poll" facts={HostDebugFacts.poll(status)} />
            </>
          )}
    </div>
  )
}
