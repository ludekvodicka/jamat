import { useEffect, useState } from 'react'

import { HostDebugFacts } from './hostDebugFacts'
import { HostFacts, HostHeader, HostWaiting } from './hostDebugParts'
import { useHostDebugStatus } from './useHostDebugStatus'

/**
 * Which Host is running and what would start one: the descriptor it published, the command this
 * client would spawn, and what the last attempt said. The launch environment is not here and never
 * will be - it carries the whole of `process.env`, so the main process drops it before composing.
 */
export function HostLaunchSection(): React.JSX.Element {
  const host = useHostDebugStatus()
  const status = host.state.status

  // The descriptor carries an uptime, so this screen keeps a second hand of its own.
  const [now, setNow] = useState(() => Date.now())
  const counting = status?.descriptor != null
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
              <HostFacts title="Descriptor" facts={HostDebugFacts.descriptor(status, now)} />
              <HostFacts title="Launch" facts={HostDebugFacts.launch(status)} />
            </>
          )}
    </div>
  )
}
