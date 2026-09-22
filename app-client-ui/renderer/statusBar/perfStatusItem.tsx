import { useCallback, useSyncExternalStore } from 'react'

import { type PerfReading, PerfSampleConst } from '../../shared/perfSample'
import type { PerfStore } from '../perf/perfStore'

/**
 * The reading, read where the bar's slots are decided rather than inside the widget: an item that
 * renders nothing still leaves its slot and its separator behind, and until the first sample lands
 * there is nothing to say. The model widget one place along is drawn on the same rule.
 */
export function usePerfReading(store: PerfStore): PerfReading | null {
  const subscribe = useCallback((onChanged: () => void) => store.subscribe(onChanged), [store])
  const current = useCallback(() => store.current(), [store])
  return useSyncExternalStore(subscribe, current, current)
}

/**
 * How fast the client is answering, in four numbers: the renderer's own loop, the main process, the
 * Host, and a keystroke's way back from the agent.
 *
 * Four rather than one, because they fail apart and the cure differs: R high with M low is this
 * window parsing or rendering, M high is the process that relays every keystroke, H high is the Host
 * or the loopback, and echo high while the other three are quiet is the agent not reading its stdin,
 * which is not a Jamat problem at all. One combined number would have said "slow" and pointed
 * nowhere.
 *
 * Each is the WORST value of the last second, never an average: what people report is a stall every
 * so often, and an average hides exactly that.
 */
export function PerfStatusItem(props: { reading: PerfReading }): React.JSX.Element {
  const { reading } = props
  return (
    <span
      className="jamat-status__perf"
      aria-label="Responsiveness"
      title={PerfStatusModel.titleOf(reading)}
    >
      {PerfStatusModel.partsOf(reading).map((part) => (
        <span
          key={part.label}
          className="jamat-status__perf-part"
          data-tone={part.tone}
        >
          {`${part.label} ${part.value}`}
        </span>
      ))}
      <span className="jamat-status__perf-unit">ms</span>
    </span>
  )
}

export class PerfStatusModel {
  /**
   * The main process contributes two numbers and they answer different questions: the round trip is
   * what a keystroke actually waits, the loop delay is why. The worse of the two is drawn, because
   * the bar has room for one and a slow round trip over a quiet loop is still a slow keystroke.
   */
  static partsOf(reading: PerfReading): readonly {
    label: string
    value: string
    tone: 'good' | 'slow' | 'bad'
  }[] {
    const main = Math.max(reading.mainRoundTripMs, reading.mainLoopDelayMaxMs)
    return [
      { label: 'R', value: String(reading.rendererLagMs), tone: PerfSampleConst.toneOf(reading.rendererLagMs) },
      { label: 'M', value: String(main), tone: PerfSampleConst.toneOf(main) },
      ...PerfStatusModel.optional('H', reading.hostCallMaxMs),
      ...PerfStatusModel.optional('echo', reading.echoMaxMs),
      // Only while the main process is the one being waited on: the rest of the time the name of
      // its busiest handler is noise, and the tooltip carries it anyway.
      ...(PerfSampleConst.toneOf(main) === 'good' || reading.mainWorst === null
        ? []
        : [{
            label: '<',
            value: reading.mainWorst.label,
            tone: PerfSampleConst.toneOf(main),
          }]),
    ]
  }

  /** A window in which nobody typed and nothing called the Host draws a dash, never a zero. */
  private static optional(label: string, value: number | null): readonly {
    label: string
    value: string
    tone: 'good' | 'slow' | 'bad'
  }[] {
    if (value === null) return [{ label, value: '-', tone: 'good' }]
    return [{ label, value: String(value), tone: PerfSampleConst.toneOf(value) }]
  }

  static titleOf(reading: PerfReading): string {
    return [
      `R ${reading.rendererLagMs} ms - this window's own event loop`,
      `M ${reading.mainRoundTripMs} ms round trip, ${reading.mainLoopDelayP95Ms} ms p95 / `
        + `${reading.mainLoopDelayMaxMs} ms max loop delay - the process that relays every keystroke`,
      `H ${reading.hostCallMaxMs ?? '-'} ms - the slowest Host call`,
      `echo ${reading.echoMaxMs ?? '-'} ms - a keystroke to the first byte back, the agent included`,
      PerfStatusModel.worstLine(reading),
      'Each number is the worst of the last second.',
    ].join('\n')
  }

  /**
   * What held the main process, by name. It is the line that turns a red `M` into somewhere to look:
   * a channel name says which request, `terminal:frame` says the output path, `sessions:changed`
   * says the poll, and nothing at all says the block was somewhere no door of ours covers.
   */
  static worstLine(reading: PerfReading): string {
    if (reading.mainWorst === null)
      return 'main: nothing over 5 ms passed through an IPC handler, a frame or the poll'
    return `main: the longest was ${reading.mainWorst.label}, ${reading.mainWorst.milliseconds} ms`
  }
}
