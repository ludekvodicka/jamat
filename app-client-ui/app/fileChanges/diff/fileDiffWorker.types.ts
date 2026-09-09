import type {
  FileDiffComputeInput,
  FileDiffExecutionResult,
} from '../../../../lib-orchestrator/fileChangesManager/diff/fileDiffExecutor'

export interface FileDiffWorkerRequest extends FileDiffComputeInput {
  kind: 'compute'
  requestId: number
}

export type FileDiffWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'result'; requestId: number; result: FileDiffExecutionResult }

export interface FileDiffWorkerThread {
  postMessage(message: FileDiffWorkerRequest): void
  on(event: 'message', listener: (message: FileDiffWorkerResponse) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export type FileDiffWorkerFactory = (path: string) => FileDiffWorkerThread
