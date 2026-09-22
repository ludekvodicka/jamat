import type { PerfSample } from '../../shared/perfSample'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import type { EchoLatency } from './echoLatency'
import type { LoopDelaySampler } from './loopDelaySampler'
import type { MainWorkLedger } from './mainWorkLedger'

/**
 * What the main process knows about how fast it is answering, on one channel a window polls once a
 * second. Nothing is collected unless somebody asks, so a client nobody is watching measures itself
 * not at all.
 *
 * The round trip of this very call is the reading the renderer cannot get any other way, and it
 * takes no field here: the caller times its own `invoke`.
 *
 * **Every number is a maximum over a window, and the window is shared.** Each reading below is
 * read-and-reset at its source, so two workspace windows polling a second apart would each be
 * handed the half of the second the other one had not taken, and both would draw a client half as
 * slow as it is. So the window is closed on a clock rather than on a call, and a second reader
 * inside it is answered with the same numbers as the first.
 */
export class ServicePerfIpc extends ServiceIpcBase<typeof ServicePerfIpc.channelsConst> {
  static readonly channelsConst = {
    'perf:sample': true,
  } as const

  /** Long enough that a second window's poll lands inside it, short enough to stay a reading. */
  private static readonly windowMsConst = 750

  private held: { sample: PerfSample; at: number } | null = null

  constructor(
    private readonly loopDelay: LoopDelaySampler,
    private readonly echo: EchoLatency,
    private readonly work: MainWorkLedger,
    private readonly hostCallMs: () => number | null,
    private readonly now: () => number = () => Date.now(),
  ) {
    super()
  }

  initialize(): void {
    this.register('perf:sample', () => this.sample())
    this.assertComplete(ServicePerfIpc.channelsConst)
  }

  private sample(): PerfSample {
    const at = this.now()
    const held = this.held
    if (held !== null && at - held.at < ServicePerfIpc.windowMsConst) return held.sample
    const loop = this.loopDelay.sample()
    const sample: PerfSample = {
      mainLoopDelayP95Ms: loop.p95,
      mainLoopDelayMaxMs: loop.max,
      hostCallMaxMs: this.hostCallMs(),
      echoMaxMs: this.echo.sample(),
      mainWorst: this.work.sample(),
    }
    this.held = { sample, at }
    return sample
  }
}
