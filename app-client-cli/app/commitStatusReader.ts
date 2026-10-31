import { setTimeout } from 'node:timers/promises'
import type { RemoteControlResponse, RemoteControlCommitStatusDto } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { JsonShape } from '../../lib-orchestrator/shared/jsonShape'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'
import { AppClientCliError } from './appClientCliError'

export class CommitStatusReader {
  static readonly timeoutMillisecondsConst = 86_400_000
  static readonly unavailableGraceMillisecondsConst = 30_000

  private readonly deps: {
    read(signal?: AbortSignal): Promise<RemoteControlResponse>
    now(): number
    pause(milliseconds: number, signal?: AbortSignal): Promise<void>
  }

  constructor(deps: CommitStatusReader['deps']) {
    this.deps = deps
  }

  static pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return setTimeout(milliseconds, undefined, { signal })
  }

  /**
   * The shape the client can answer, not the shape a waiter ends on. A review whose pane closed
   * without a decision stays `editing` and `closed`, and so does every pending review restored after a
   * client restart until its pane takes it again; a cancellation is `cancelled` and still open until
   * its panes let go; a selected path SVN did not report puts its notice in `detail` beside any state.
   */
  static valid(value: unknown, id: string): value is RemoteControlCommitStatusDto {
    if (!JsonShape.isRecord(value) || value.kind !== 'commit-status' || value.commitSessionId !== id
      || typeof value.sessionId !== 'string' || typeof value.scopeRoot !== 'string'
      || (value.vcs !== 'svn' && value.vcs !== 'git') || typeof value.closed !== 'boolean'
      || (value.detail !== null && typeof value.detail !== 'string')) return false
    if (value.state === 'committed') return typeof value.revision === 'string' && value.revision.length > 0
    else if (value.state === 'failed') return value.revision === null && typeof value.detail === 'string'
    else if (value.state === 'cancelled' || value.state === 'editing' || value.state === 'running'
      || value.state === 'external-closed') return value.revision === null
    else return false
  }

  /**
   * A failed attempt leaves the review open and editable under the same UUID: the person fixes what
   * it reported and commits the same selection again, so `failed` while the pane is open is a step
   * of the review, not its outcome. Waiting ends on a review that closed, never on the first
   * non-pending value. Tortoise is the exception, because its own window already took the review
   * away and its exit proves neither a commit nor a cancellation.
   */
  private static finished(value: RemoteControlCommitStatusDto): boolean {
    if (value.state === 'committed' || value.state === 'external-closed') return true
    else if (value.state === 'failed' || value.state === 'cancelled') return value.closed
    else if (value.state === 'editing' || value.state === 'running') return false
    else throw new Error(`Unknown commit state: ${JSON.stringify(value.state)}`)
  }

  async read(id: string, wait: boolean, timeoutMs: number, signal?: AbortSignal): Promise<RemoteControlResponse> {
    const deadline = this.deps.now() + timeoutMs
    let unavailableSince: number | null = null
    for (;;) {
      if (signal?.aborted) throw new AppClientCliError('operation-failed', `Stopped waiting for commit ${id}; its outcome is unknown`)
      const answer = await this.deps.read(signal).catch((error: unknown) => {
        throw new AppClientCliError('operation-failed', `Cannot read commit ${id}; its outcome is unknown: ${ErrorText.of(error)}`)
      })
      if (signal?.aborted) throw new AppClientCliError('operation-failed', `Stopped waiting for commit ${id}; its outcome is unknown`)
      if (answer.ok) {
        if (!CommitStatusReader.valid(answer.value, id))
          throw new AppClientCliError('operation-failed', `Invalid status for commit ${id}; its outcome is unknown`)
        if (!wait || CommitStatusReader.finished(answer.value)) return answer
        unavailableSince = null
      } else if (!wait) return CommitStatusReader.unknown(answer, id)
      else if (answer.error.code === 'timeout') unavailableSince = null
      else if (answer.error.code === 'unavailable') {
        // This reader keeps the endpoint it was given and a restarted client listens on another one,
        // so only a short refusal is retried here; the caller discovers the client again after it.
        unavailableSince ??= this.deps.now()
        if (this.deps.now() - unavailableSince >= CommitStatusReader.unavailableGraceMillisecondsConst)
          return CommitStatusReader.unknown(answer, id)
      } else return CommitStatusReader.unknown(answer, id)
      // A failed status read cannot settle the human's review. Retry only that read under the original deadline.
      const remaining = deadline - this.deps.now()
      if (remaining <= 0)
        throw new AppClientCliError('timeout', `Timed out waiting for commit ${id}; its outcome is unknown. Query this UUID again. No other dialog was opened`)
      await this.deps.pause(Math.min(1_000, remaining), signal).catch((error: unknown) => {
        throw new AppClientCliError('operation-failed', `Stopped waiting for commit ${id}; its outcome is unknown: ${ErrorText.of(error)}`)
      })
    }
  }

  private static unknown(answer: Extract<RemoteControlResponse, { ok: false }>, id: string): RemoteControlResponse {
    return { ...answer, error: { ...answer.error,
      detail: `Commit ${id}: ${answer.error.detail}. Its outcome is unknown; check it with commit status --commit-session-id ${id}`,
      data: { ...JsonShape.record(answer.error.data), commitSessionId: id } } }
  }
}
