import type { RateDebugEffect, RateDebugInput } from './rateDebugModel'

export interface RateDebugPorts {
  dispatch(input: RateDebugInput): void
  /**
   * Ask the section's reader to read again.
   *
   * Not a direct `debugStatus()` call: the reader is where the coalescing, the single-flight and the
   * give-up live, and a second path into the channel would have none of them.
   */
  readAgain(): void
}

/**
 * The section's whole conversation with the main process, and the only file of it that performs I/O.
 *
 * Both channels answer with a value and not with a result object of their own, so there is one unwrap
 * here where the host section has two: the monitor's own refusals - a token that expired, a Codex
 * that is not installed - are not failures of a read, they are the state the status carries. Only
 * `IpcResult` can say the channel itself did not answer, and that is said in the transport's words so
 * it cannot be mistaken for something the monitor decided.
 */
export class RateDebugEffects {
  static async run(effect: RateDebugEffect, ports: RateDebugPorts): Promise<void> {
    if (effect.effect === 'load')
      return RateDebugEffects.load(ports)
    else if (effect.effect === 'refresh')
      return RateDebugEffects.refresh(ports)
    else
      throw new Error(`Unknown rate debug effect: ${JSON.stringify(effect)}`)
  }

  private static load(ports: RateDebugPorts): Promise<void> {
    ports.readAgain()
    return Promise.resolve()
  }

  /**
   * The one action this section takes. The 180-second floor on the Claude side lives in the main
   * process, so a refresh inside it answers with what is already there rather than being refused -
   * which is why nothing is reported on the way back beyond the read that follows it.
   */
  private static async refresh(ports: RateDebugPorts): Promise<void> {
    const answer = await window.appClient.rateMonitor.refresh()
    if (!answer.ok)
      return ports.dispatch({ input: 'failed', detail: RateDebugEffects.silent(answer.error) })
    ports.dispatch({ input: 'refresh-answered' })
  }

  /** Said in the words of the transport, so it cannot be mistaken for something the monitor refused. */
  private static silent(error: string): string {
    return `The main process did not answer: ${error}`
  }
}
