import type {
  RuntimeLaunchSpec,
  RuntimeSessionInfo,
} from '../../wire/hostWire.js'
import type {
  TerminalInstanceDriver,
  TerminalInstanceEvent,
  TerminalInstanceFactory,
  TerminalProjectionDriver,
} from '../../terminal/terminal.types.js'

export interface FakeTerminalInstanceRecord {
  readonly instance: TerminalInstanceDriver
  readonly writes: string[]
  readonly resizes: Array<{ cols: number; rows: number }>
  readonly disposed: () => boolean
  emitData(data: string): void
  emitExit(exitCode?: number): void
}

export interface FakeTerminalInstanceOptions {
  stopLeavesAlive?: boolean
  readyError?: Error
  readyBarrier?: Promise<void>
  /** A projection that cannot answer, which is what an attach past its own ack has to survive. */
  snapshotError?: Error
}

/** Lets the lifecycle tests drive exit, data and resize without spawning a real process. */
export class FakeTerminalInstances {
  readonly records: FakeTerminalInstanceRecord[] = []
  readonly factory: TerminalInstanceFactory

  constructor(private readonly options: FakeTerminalInstanceOptions = {}) {
    this.factory = (
      runtimeSessionId,
      generation,
      outputEpoch,
      launch,
      onEvent,
    ) => this.create(
      runtimeSessionId,
      generation,
      outputEpoch,
      launch,
      onEvent,
    )
  }

  latest(): FakeTerminalInstanceRecord {
    const record = this.records.at(-1)
    if (!record)
      throw new Error('No fake terminal exists')
    return record
  }

  private create(
    runtimeSessionId: string,
    generation: number,
    outputEpoch: number,
    launch: RuntimeLaunchSpec,
    onEvent: (event: TerminalInstanceEvent) => void,
  ): TerminalInstanceDriver {
    const state = {
      alive: true,
      disposed: false,
      cols: launch.cols,
      rows: launch.rows,
      outputSeq: 0,
      lastOutputAt: null as number | null,
    }
    const writes: string[] = []
    const resizes: Array<{ cols: number; rows: number }> = []
    const projection = {
      get cols() { return state.cols },
      get rows() { return state.rows },
      get outputSeq() { return state.outputSeq },
      get lastOutputAt() { return state.lastOutputAt },
      resize: (cols: number, rows: number) => {
        state.cols = cols
        state.rows = rows
      },
      deltaSince: () => ({
        data: '',
        outputSeq: state.outputSeq,
        outputEpoch,
        truncated: false,
      }),
      snapshot: async (alive: boolean) => {
        if (this.options.snapshotError) throw this.options.snapshotError
        return {
          runtimeSessionId,
          generation,
          outputEpoch,
          outputSeq: state.outputSeq,
          raw: writes.join(''),
          screen: writes.join(''),
          cols: state.cols,
          rows: state.rows,
          alive,
          lastOutputAt: state.lastOutputAt,
        }
      },
      dispose: () => undefined,
    } satisfies TerminalProjectionDriver
    const emitExit = (exitCode = 0): void => {
      if (!state.alive)
        return
      state.alive = false
      onEvent({
        type: 'exit',
        runtimeSessionId,
        generation,
        exitCode,
      })
    }
    const instance = {
      runtimeSessionId,
      generation,
      outputEpoch,
      get pid() { return 4_242 + generation },
      get alive() { return state.alive },
      get processStartedAt() { return state.alive ? 1 : null },
      projection,
      ready: async () => {
        if (this.options.readyBarrier)
          await this.options.readyBarrier
        if (this.options.readyError)
          throw this.options.readyError
      },
      write: (data: string) => {
        if (state.alive)
          writes.push(data)
      },
      resize: (cols: number, rows: number) => {
        if (!state.alive)
          return
        state.cols = cols
        state.rows = rows
        resizes.push({ cols, rows })
        onEvent({ type: 'resize', runtimeSessionId, generation, cols, rows })
      },
      stop: async () => {
        if (!this.options.stopLeavesAlive)
          emitExit()
      },
      info: (startedAt: number): RuntimeSessionInfo => ({
        runtimeSessionId,
        generation,
        alive: state.alive,
        ...(state.alive
          ? { pid: 4_242 + generation, processStartedAt: 1 }
          : {}),
        cols: state.cols,
        rows: state.rows,
        outputSeq: state.outputSeq,
        outputEpoch,
        lastOutputAt: state.lastOutputAt,
        startedAt,
      }),
      dispose: () => {
        state.disposed = true
        state.alive = false
      },
    } satisfies TerminalInstanceDriver
    const record = {
      instance,
      writes,
      resizes,
      disposed: () => state.disposed,
      emitData: (data: string) => {
        if (!state.alive)
          return
        state.outputSeq += data.length
        state.lastOutputAt = Date.now()
        onEvent({
          type: 'data',
          runtimeSessionId,
          generation,
          outputEpoch,
          delta: data,
          outputSeq: state.outputSeq,
          lastOutputAt: state.lastOutputAt,
        })
      },
      emitExit,
    } satisfies FakeTerminalInstanceRecord
    this.records.push(record)
    return instance
  }
}
