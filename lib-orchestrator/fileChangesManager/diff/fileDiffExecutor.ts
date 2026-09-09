import type { FileDiffHunk } from '../fileChangesManagerApi.types'

export interface FileDiffComputeInput {
  before: string
  after: string
}

export type FileDiffExecutionResult =
  | { kind: 'computed'; hunks: readonly FileDiffHunk[] }
  | { kind: 'work-limit' }
  | { kind: 'refused'; detail: string }

export interface FileDiffExecutionContext {
  ownerId: string
  snapshotId: string
  jobKey: string
  signal?: AbortSignal
}

export interface FileDiffExecutor {
  execute(
    input: FileDiffComputeInput,
    context?: FileDiffExecutionContext,
  ): Promise<FileDiffExecutionResult>
}
