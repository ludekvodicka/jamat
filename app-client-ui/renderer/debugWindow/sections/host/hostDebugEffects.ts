import type { HostDebugEffect, HostDebugInput } from './hostDebugModel'

export interface HostDebugPorts {
  dispatch(input: HostDebugInput): void
}

/**
 * The section's whole conversation with the main process, and the only file of it that performs I/O.
 *
 * Two unwraps, always in this order: `IpcResult` says whether the channel answered at all, and only
 * then does the library's own result say what it decided. Folded into one check, a Host that refused
 * to start would read like a broken pipe, and the user would retry the one thing that cannot work.
 */
export class HostDebugEffects {
  static async run(effect: HostDebugEffect, ports: HostDebugPorts): Promise<void> {
    if (effect.effect === 'ping') return HostDebugEffects.ping(ports)
    else if (effect.effect === 'start-host') return HostDebugEffects.startHost(ports)
    else
      throw new Error(`Unknown host debug effect: ${JSON.stringify(effect)}`)
  }

  /**
   * A ping that never reached the main process is still a ping that did not answer, so it lands as
   * one - carrying the words of the transport, so it cannot be mistaken for the Host being gone.
   */
  private static async ping(ports: HostDebugPorts): Promise<void> {
    const answer = await window.appClient.debug.pingHost()
    if (!answer.ok)
      return ports.dispatch({
        input: 'ping-answered',
        mine: true,
        result: { at: Date.now(), ok: false, detail: HostDebugEffects.silent(answer.error) },
      })
    // `mine`: this is the answer to the ping this section asked for, and the only one that may
    // clear its own flag. The loop's results arrive through the same input without it.
    ports.dispatch({ input: 'ping-answered', mine: true, result: answer.value })
  }

  /**
   * The one action this section takes that changes anything, and it goes through the channel the
   * status bar already uses. There is deliberately no stop: `host.stop` kills every PTY the Host
   * owns. A Host that did start shows up through the status channel, so success says nothing here.
   */
  private static async startHost(ports: HostDebugPorts): Promise<void> {
    const answer = await window.appClient.sessions.startHost()
    if (!answer.ok)
      return ports.dispatch({ input: 'failed', detail: HostDebugEffects.silent(answer.error) })
    if (!answer.value.ok)
      return ports.dispatch({
        input: 'failed',
        detail: `${answer.value.code}: ${answer.value.detail}`,
      })
  }

  /** Said in the words of the transport, so it cannot be mistaken for something the library refused. */
  private static silent(error: string): string {
    return `The main process did not answer: ${error}`
  }
}
