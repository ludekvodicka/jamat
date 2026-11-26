import type { FileChangesShellRun } from '../../../lib-orchestrator/fileChangesManager/sessionMutationsView'
import type { SessionUncommittedCandidate } from '../../../lib-orchestrator/sessionManager/sessionUncommittedView'
import type { SessionUncommittedEntry } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'

/** What the thread is started with; it reads nothing else of the orchestrator's state. */
export interface SessionUncommittedWorkerStart {
  /** `session-claims.json` (D8). */
  cacheFile: string
}

export type SessionUncommittedScanReason = 'tick' | 'stamp' | 'idle' | 'commit' | 'status' | 'visible'

export interface SessionUncommittedStatusEntry {
  absolutePath: string
  nodeKind: 'file' | 'directory'
}

export type SessionUncommittedClaims = { touched: readonly string[]; shellRuns: readonly FileChangesShellRun[] }

export type SessionUncommittedWorkerRequest =
  | {
    kind: 'scan'
    requestId: number
    sessions: readonly SessionUncommittedCandidate[]
    reason: SessionUncommittedScanReason
    /** Working-copy roots whose sessions are evaluated; absent for all of them. */
    roots?: readonly string[]
  }
  | { kind: 'observeStatus'; requestId: number; root: string; entries: readonly SessionUncommittedStatusEntry[] }
  | { kind: 'claims'; requestId: number; sessionId: string }
  | { kind: 'stop'; requestId: number }

export type SessionUncommittedWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'result'; requestId: number; sessions: Record<string, SessionUncommittedEntry> }
  | { kind: 'claims'; requestId: number; touched: readonly string[]; shellRuns: readonly FileChangesShellRun[] }
  | { kind: 'claims'; requestId: number; touched: null }
  /** An `observeStatus` was applied, or a `stop` flushed the cache. */
  | { kind: 'done'; requestId: number }
  | { kind: 'failed'; requestId: number; detail: string }

export interface SessionUncommittedWorkerThread {
  performance: import('node:worker_threads').Worker['performance']
  postMessage(message: SessionUncommittedWorkerRequest): void
  on(event: 'message', listener: (message: SessionUncommittedWorkerResponse) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export type SessionUncommittedWorkerFactory = (path: string, start: SessionUncommittedWorkerStart) => SessionUncommittedWorkerThread
