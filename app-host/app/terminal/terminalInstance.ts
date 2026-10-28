import { execFile } from 'node:child_process'

import type * as pty from 'node-pty'
import { spawn } from 'node-pty'

import type {
  RuntimeLaunchSpec,
  RuntimeSessionInfo,
} from '../wire/hostWire.js'
import { ProcessStartIdentity } from '../shared/processStartIdentity.js'
import { TerminalDescendants, type TerminalDescendant } from './terminalDescendants.js'
import { TerminalProjection } from './terminalProjection.js'
import { TerminalLaunchError } from './terminalLaunchError.js'
import { TerminalStopRefusal } from './terminalStopRefusal.js'
import type { TerminalExit, TerminalInstanceEvent } from './terminal.types.js'

export class TerminalInstance {
  /**
   * The three budgets of the stop ladder. Each one is raced against the real exit, so a child that
   * dies on the interrupt pays none of them and the whole stop costs what it costs today.
   *
   * **`IPty.kill()` is not a kill on Windows.** It closes the pseudoconsole and leaves the actual
   * killing to a FORKED helper of node-pty's, whose own fallback timeout is 5 s
   * (`windowsPtyAgent.js`, `_getConsoleProcessList`). An agent running its own shutdown - Claude
   * prints its resume line there - therefore confirmed its death just PAST a single 5 s wait, and
   * `runtime.stop` answered conflict for a process that died a second later, with the tab left
   * open on a red refusal. A longer wait only moves that edge, which is why the last rung is a
   * kill of our own rather than more patience.
   */
  private static readonly gracefulStopMsConst = 250
  private static readonly killConfirmMsConst = 2_000
  private static readonly hardKillConfirmMsConst = 3_000
  /**
   * How long a spawn has to expose a start identity before it is killed and refused. A process that
   * exits inside it is not refused: see `ready`.
   *
   * It is long because the answer is a real query about a real process - on Windows a PowerShell
   * one - and short because whoever asked for the session is waiting on it: a `sessions.create`
   * that never answers is worse than one that says the spawn did not come up.
   */
  private static readonly readyDeadlineMsConst = 5_000
  /** Between two probes. Small enough not to be felt, large enough not to spin the loop. */
  private static readonly readyPollMsConst = 25
  private readonly process: pty.IPty
  private readonly subscriptions: Array<{ dispose(): void }> = []
  private readonly exited: Promise<void>
  private resolveExit: () => void = () => {}
  private aliveValue = true
  private stopping: Promise<void> | null = null
  private descendantFailure: string | null = null
  private readonly stopDescendants: boolean
  private descendants: TerminalDescendant[] = []
  private released = false
  private processStartedAtValue: number | null = null
  private exitValue: TerminalExit | null = null
  readonly projection: TerminalProjection

  constructor(
    readonly runtimeSessionId: string,
    readonly generation: number,
    readonly outputEpoch: number,
    launch: RuntimeLaunchSpec,
    private readonly onEvent: (event: TerminalInstanceEvent) => void,
  ) {
    this.stopDescendants = launch.stopDescendants === true
    this.exited = new Promise((resolveExit) => {
      this.resolveExit = resolveExit
    })
    this.projection = new TerminalProjection(
      runtimeSessionId,
      generation,
      outputEpoch,
      launch.cols,
      launch.rows,
    )
    // launch.env is the complete final child environment; nothing of this process leaks into it.
    try {
      this.process = spawn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: launch.cols,
        rows: launch.rows,
        cwd: launch.cwd,
        env: launch.env,
      })
    } catch (error) {
      this.projection.dispose()
      throw new TerminalLaunchError(
        `could not spawn ${launch.command}: ${TerminalLaunchError.describe(error)}`,
        error,
      )
    }
    this.subscriptions.push(this.process.onData((data) => this.onData(data)))
    this.subscriptions.push(this.process.onExit(({ exitCode }) => this.onExit(exitCode)))
  }

  get pid(): number {
    return this.process.pid
  }

  get alive(): boolean {
    return this.aliveValue
  }

  get processStartedAt(): number | null {
    return this.processStartedAtValue
  }

  get exit(): TerminalExit | null {
    return this.exitValue
  }

  /**
   * A process that exits before the probe sees it alive - on Windows the probe is a PowerShell
   * process of about half a second, and a fast child can be gone before node-pty even exposes its
   * pid - is a run that happened, not a launch that failed: `git status`
   * or `exit 0` ends inside that window, and refusing it made its caller read a clean exit as a
   * failure. It resolves with `exit` set, and its caller answers a runtime that is already dead.
   * Only a process still running without a provable identity is killed and refused.
   */
  async ready(): Promise<void> {
    const deadline = Date.now() + TerminalInstance.readyDeadlineMsConst
    let reason = 'PTY process ID is not assigned'
    while (this.aliveValue && Date.now() < deadline) {
      if (this.process.pid > 0) {
        // probeAsync, not probe: on Windows the query is a PowerShell process, and the synchronous
        // form blocks the loop for 200-400 ms per attempt while sessions.create waits on this.
        const identity = await ProcessStartIdentity.probeAsync(this.process.pid)
        if (identity.state === 'alive') {
          this.processStartedAtValue = identity.processStartedAt
          return
        } else if (identity.state === 'unknown')
          reason = identity.reason
        else if (identity.state !== 'dead')
          throw new Error(`Unknown process identity probe: ${JSON.stringify(identity)}`)
      }
      await TerminalInstance.sleep(TerminalInstance.readyPollMsConst)
    }
    if (!this.aliveValue) return
    this.release()
    throw new TerminalLaunchError(`PTY process did not expose a stable start identity: ${reason}`)
  }

  write(data: string): void {
    if (!this.aliveValue) return
    this.process.write(data)
  }

  resize(cols: number, rows: number): void {
    if (!this.aliveValue) return
    this.projection.resize(cols, rows)
    const snapshot = this.info(Date.now())
    try { this.process.resize(snapshot.cols, snapshot.rows) }
    catch { return }
    this.onEvent({
      type: 'resize',
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      cols: snapshot.cols,
      rows: snapshot.rows,
    })
  }

  stop(confirmExternalStop = false): Promise<void> {
    this.stopping ??= this.stopCurrent(confirmExternalStop).finally(() => { this.stopping = null })
    return this.stopping
  }

  private async stopCurrent(confirmExternalStop: boolean): Promise<void> {
    if (!this.aliveValue) {
      await TerminalInstance.stopDescendants(this.descendants)
      if (confirmExternalStop) this.descendantFailure = null
      if (this.descendantFailure !== null) throw new TerminalStopRefusal(this.descendantFailure)
      this.descendants = []
      return
    }
    // A shell can exit on the first Ctrl+C and orphan children before CIM sees their parent.
    const captured = await (this.stopDescendants ? TerminalDescendants.capture(this.pid, this.processStartedAtValue)
      .then((children) => ({ children, error: null }), (error: unknown) => ({ children: [] as TerminalDescendant[], error }))
      : Promise.resolve({ children: [] as TerminalDescendant[], error: null }))
    this.descendants = [...new Map([...this.descendants, ...captured.children].map((child) => [`${child.pid}:${child.startedAt}`, child])).values()]
    if (captured.error !== null) {
      // Kept only when the root ended during the inspection: a live root keeps its tree readable, and is not interrupted here.
      this.descendantFailure = this.aliveValue ? null
        : `Terminal root PID ${this.pid} ended during its descendant inspection, so its child processes cannot be proven stopped: `
          + `${String(captured.error)}; stop them, then confirm the stop manually`
      throw new TerminalStopRefusal(this.descendantFailure
        ?? `Terminal descendant inspection failed for root PID ${this.pid}; retry Stop: ${String(captured.error)}`)
    }
    this.descendantFailure = null
    try { this.process.write('\x03') } catch {}
    await TerminalInstance.sleep(50)
    try { this.process.write('\x03') } catch {}
    await this.awaitExit(TerminalInstance.gracefulStopMsConst)
    if (this.aliveValue) {
      this.release()
      await this.awaitExit(TerminalInstance.killConfirmMsConst)
    }
    if (this.aliveValue) {
      this.hardKill()
      await this.awaitExit(TerminalInstance.hardKillConfirmMsConst)
    }
    if (this.descendants.length > 0) await TerminalInstance.stopDescendants(this.descendants)
    if (this.descendantFailure !== null) throw new TerminalStopRefusal(this.descendantFailure)
    this.descendants = []
  }

  private static async stopDescendants(children: readonly TerminalDescendant[]): Promise<void> {
    try { await TerminalDescendants.stop(children) }
    catch (error) { throw new TerminalStopRefusal(`Owned child processes did not stop; retry Stop: ${error instanceof Error ? error.message : String(error)}`) }
  }

  info(startedAt: number): RuntimeSessionInfo {
    const snapshot = this.projectionSnapshot()
    return {
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      alive: this.aliveValue,
      ...(this.aliveValue && this.pid > 0 && this.processStartedAtValue !== null
        ? {
            pid: this.pid,
            processStartedAt: this.processStartedAtValue,
          }
        : {}),
      cols: snapshot.cols,
      rows: snapshot.rows,
      outputSeq: snapshot.outputSeq,
      outputEpoch: this.outputEpoch,
      lastOutputAt: snapshot.lastOutputAt,
      startedAt,
    }
  }

  dispose(): void {
    this.release()
    this.aliveValue = false
    this.resolveExit()
    for (const subscription of this.subscriptions.splice(0))
      try { subscription.dispose() } catch {}
    this.projection.dispose()
  }

  /**
   * `IPty.kill()`, at most once per instance, and also after a process that ended by itself. On
   * Windows node-pty starts one worker thread per PTY and ends it, with the pseudoconsole, only in
   * `kill()`; a natural exit keeps both. Each ended run then held a worker isolate until the Host
   * could start no new one (`ERR_WORKER_OUT_OF_MEMORY`) and every create died at once. A second
   * kill of a closed pseudoconsole is never sent.
   */
  private release(): void {
    if (this.released) return
    this.released = true
    try { this.process.kill() } catch {}
  }

  private awaitExit(budgetMs: number): Promise<void> {
    return Promise.race([this.exited, TerminalInstance.sleep(budgetMs)])
  }

  // Descendants of managed runs are killed separately against captured process identities.
  private hardKill(): void {
    const pid = this.process.pid
    if (pid <= 0) return
    if (process.platform === 'win32')
      execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => undefined)
    else
      try { process.kill(pid, 'SIGKILL') } catch {}
  }

  private onData(delta: string): void {
    if (!this.aliveValue) return
    const lastOutputAt = Date.now()
    const outputSeq = this.projection.append(delta, lastOutputAt)
    this.onEvent({
      type: 'data',
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      outputEpoch: this.outputEpoch,
      delta,
      outputSeq,
      lastOutputAt,
    })
  }

  private onExit(exitCode: number): void {
    if (!this.aliveValue) return
    this.aliveValue = false
    this.exitValue = { exitCode, exitedAt: Date.now() }
    this.resolveExit()
    this.onEvent({
      type: 'exit',
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      exitCode,
    })
    this.release()
  }

  private projectionSnapshot(): {
    cols: number
    rows: number
    outputSeq: number
    lastOutputAt: number | null
  } {
    return {
      cols: this.projection.cols,
      rows: this.projection.rows,
      outputSeq: this.projection.outputSeq,
      lastOutputAt: this.projection.lastOutputAt,
    }
  }

  private static sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }
}
