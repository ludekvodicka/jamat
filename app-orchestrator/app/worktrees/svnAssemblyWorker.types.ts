import type { SvnAssembly } from '../../../lib-orchestrator/svn/svnAssembly'

export interface SvnAssemblyWorkerRequest {
  kind: 'read'
  requestId: number
  root: string
  freshness: boolean
}

export type SvnAssemblyWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'progress'; requestId: number; mount: string; files: number }
  | { kind: 'result'; requestId: number; assembly: SvnAssembly }
  | { kind: 'failed'; requestId: number; detail: string }

export interface SvnAssemblyWorkerThread {
  performance: import('node:worker_threads').Worker['performance']
  postMessage(message: SvnAssemblyWorkerRequest): void
  on(event: 'message', listener: (message: SvnAssemblyWorkerResponse) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export type SvnAssemblyWorkerFactory = (path: string) => SvnAssemblyWorkerThread
