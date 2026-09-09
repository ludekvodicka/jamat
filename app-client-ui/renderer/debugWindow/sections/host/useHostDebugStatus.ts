import { useEffect, useRef, useState } from 'react'

import type { HostDebugStatus } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { ErrorText } from '../../../../shared/errorText'
import { IpcSnapshotReader } from '../../../ipc/ipcSnapshotReader'
import { HostDebugEffects, type HostDebugPorts } from './hostDebugEffects'
import { HostDebugModel, type HostDebugInput, type HostDebugState } from './hostDebugModel'

export interface HostDebugHandle {
  state: HostDebugState
  dispatch(input: HostDebugInput): void
  /** The way back after the reader has given up, and the Refresh button on every host node. */
  refresh(): void
}

/**
 * The status every node of the host tree draws, and the machine behind it.
 *
 * One reader, because only the selected node is mounted: switching nodes tears this down and builds
 * it again, which costs one read of a channel that composes without I/O. Holding the status above
 * the tree instead would put a Host into the frame, which is the one thing the frame must not know.
 */
export function useHostDebugStatus(): HostDebugHandle {
  const [start] = useState(() => HostDebugModel.initial())
  const [state, setState] = useState<HostDebugState>(start)
  // Read through a ref rather than through the rendered state: a status arriving while a ping is in
  // flight has to see what the ping decided, not what React has drawn.
  const stateRef = useRef<HostDebugState>(start)
  const reader = useRef<IpcSnapshotReader<HostDebugStatus> | null>(null)

  const [ports] = useState<HostDebugPorts>(() => {
    const self: HostDebugPorts = {
      dispatch: (input) => {
        const step = HostDebugModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        for (const effect of step.effects)
          // Caught, not only voided: a rejecting invoke was an unhandled rejection rather than the
          // `failed` input this model has an arm for - and the arm is what releases the latch.
          void HostDebugEffects.run(effect, self)
            .catch((error: unknown) => self.dispatch({ input: 'failed', detail: ErrorText.of(error) }))
      },
    }
    return self
  })

  useEffect(() => {
    const engine = new IpcSnapshotReader<HostDebugStatus>(
      {
        subject: 'The Host debug status',
        read: () => window.appClient.debug.hostStatus(),
        // The same push the sessions tree reads: the status is composed out of what moved the
        // snapshot, so what wakes one wakes the other.
        subscribe: (onChanged) => window.appClient.onSessionsChanged(onChanged),
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

  // A ping the main process took on its own arrives through the same input as one asked for here.
  useEffect(
    () => window.appClient.onHostPingResult((result) =>
      ports.dispatch({ input: 'ping-answered', result })),
    [ports],
  )

  // Held steady across renders, because a node subscribes to its own mount effect through them.
  const [refresh] = useState(() => (): void => reader.current?.refresh())
  return { state, dispatch: ports.dispatch, refresh }
}
