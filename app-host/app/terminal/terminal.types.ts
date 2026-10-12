import type {
  RuntimeLaunchSpec,
  RuntimeSessionInfo,
  TerminalProjectionSnapshot,
} from '../wire/hostWire.js'
import type { TerminalProjectionDelta, TerminalSnapshotOptions } from './terminalProjection.js'

export type TerminalInstanceEvent =
  | {
      type: 'data'
      runtimeSessionId: string
      generation: number
      outputEpoch: number
      delta: string
      outputSeq: number
      lastOutputAt: number
    }
  | {
      type: 'resize'
      runtimeSessionId: string
      generation: number
      cols: number
      rows: number
    }
  | {
      type: 'exit'
      runtimeSessionId: string
      generation: number
      exitCode: number
    }

export interface TerminalProjectionDriver {
  readonly cols: number
  readonly rows: number
  readonly outputSeq: number
  readonly lastOutputAt: number | null
  resize(cols: number, rows: number): void
  deltaSince(outputEpoch: number, sinceSeq: number): TerminalProjectionDelta
  snapshot(
    alive: boolean,
    options: TerminalSnapshotOptions,
  ): Promise<TerminalProjectionSnapshot>
  dispose(): void
}

/** How the child process ended, as node-pty reported it. */
export interface TerminalExit {
  exitCode: number
  exitedAt: number
}

export interface TerminalInstanceDriver {
  readonly runtimeSessionId: string
  readonly generation: number
  readonly outputEpoch: number
  readonly pid: number
  readonly alive: boolean
  readonly processStartedAt: number | null
  /** Null while the process runs, and after a `dispose` that no exit preceded. */
  readonly exit: TerminalExit | null
  readonly projection: TerminalProjectionDriver
  /**
   * Resolves once the process has a start identity or has already exited (`exit` then says how);
   * rejects only for a process that is still running and cannot prove which process it is.
   */
  ready(): Promise<void>
  write(data: string): void
  resize(cols: number, rows: number): void
  stop(): Promise<void>
  info(startedAt: number): RuntimeSessionInfo
  dispose(): void
}

export type TerminalInstanceFactory = (
  runtimeSessionId: string,
  generation: number,
  outputEpoch: number,
  launch: RuntimeLaunchSpec,
  onEvent: (event: TerminalInstanceEvent) => void,
) => TerminalInstanceDriver
