import { execFile } from 'node:child_process'

import type * as pty from 'node-pty'
import { spawn } from 'node-pty'

import type {
  RuntimeLaunchSpec,
  RuntimeSessionInfo,
} from '../wire/hostWire.js'
import { ProcessStartIdentity } from '../shared/processStartIdentity.js'
import { TerminalProjection } from './terminalProjection.js'
import { TerminalLaunchError } from './terminalLaunchError.js'
import type { TerminalInstanceEvent } from './terminal.types.js'

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
   * How long a spawn has to expose a start identity before it is killed and refused.
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
  private stopping = false
  private processStartedAtValue: number | null = null
  readonly projection: TerminalProjection

  constructor(
    readonly runtimeSessionId: string,
    readonly generation: number,
    readonly outputEpoch: number,
    launch: RuntimeLaunchSpec,
    private readonly onEvent: (event: TerminalInstanceEvent) => void,
  ) {
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
    try { this.process.kill() } catch {}
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

  async stop(): Promise<void> {
    if (!this.aliveValue || this.stopping) return
    this.stopping = true
    try { this.process.write('\x03') } catch {}
    await TerminalInstance.sleep(50)
    try { this.process.write('\x03') } catch {}
    await this.awaitExit(TerminalInstance.gracefulStopMsConst)
    if (this.aliveValue) {
      try { this.process.kill() } catch {}
      await this.awaitExit(TerminalInstance.killConfirmMsConst)
    }
    if (this.aliveValue) {
      this.hardKill()
      await this.awaitExit(TerminalInstance.hardKillConfirmMsConst)
    }
    // a child that outlived the kill race must not latch the guard, or a retried stop would be a no-op
    if (this.aliveValue) this.stopping = false
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
    if (this.aliveValue)
      try { this.process.kill() } catch {}
    this.aliveValue = false
    this.resolveExit()
    for (const subscription of this.subscriptions.splice(0))
      try { subscription.dispose() } catch {}
    this.projection.dispose()
  }

  private awaitExit(budgetMs: number): Promise<void> {
    return Promise.race([this.exited, TerminalInstance.sleep(budgetMs)])
  }

  /**
   * The kill of last resort, and the only one that reaches the whole tree: the pty's pid is the
   * shell that was spawned and the agent runs as its child, so `/T` is what the escalation is for.
   * It costs a process of its own, which is why it sits behind a budget rather than in front of it.
   * Its failure is the outcome that was wanted - the process is already gone - so nothing but the
   * exit that follows decides anything.
   */
  private hardKill(): void {
    const pid = this.process.pid
    if (pid <= 0) return
    if (process.platform === 'win32')
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => undefined)
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
    this.resolveExit()
    this.onEvent({
      type: 'exit',
      runtimeSessionId: this.runtimeSessionId,
      generation: this.generation,
      exitCode,
    })
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
