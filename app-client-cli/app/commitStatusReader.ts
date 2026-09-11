import { setTimeout } from 'node:timers/promises'
import type { RemoteControlResponse, RemoteControlCommitStatusDto } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { JsonShape } from '../../lib-orchestrator/shared/jsonShape'
import { ErrorText } from '../../lib-orchestrator/shared/errorText'
import { AppClientCliError } from './appClientCliError'

export class CommitStatusReader {
  static readonly timeoutMillisecondsConst = 86_400_000

  constructor(private readonly deps: {
    read(): Promise<RemoteControlResponse>
    now(): number
    pause(milliseconds: number, signal?: AbortSignal): Promise<void>
  }) {}

  static pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return setTimeout(milliseconds, undefined, { signal })
  }

  static valid(value: unknown, id: string): value is RemoteControlCommitStatusDto {
    if (!JsonShape.isRecord(value) || value.kind !== 'commit-status' || value.commitSessionId !== id
      || typeof value.sessionId !== 'string' || typeof value.scopeRoot !== 'string'
      || (value.vcs !== 'svn' && value.vcs !== 'git') || typeof value.closed !== 'boolean') return false
    if (value.state === 'committed') return typeof value.revision === 'string' && value.revision.length > 0 && value.detail === null
    else if (value.state === 'failed') return value.revision === null && typeof value.detail === 'string'
    else if (value.state === 'cancelled') return value.closed && value.revision === null && value.detail === null
    else if (value.state === 'editing') return !value.closed && value.revision === null && value.detail === null
    else if (value.state === 'running') return value.revision === null && value.detail === null
    else if (value.state === 'external-closed') return value.revision === null && value.detail === null
    else return false
  }

  async read(id: string, wait: boolean, timeoutMs: number, signal?: AbortSignal): Promise<RemoteControlResponse> {
    const deadline = this.deps.now() + timeoutMs
    for (;;) {
      if (signal?.aborted) throw new AppClientCliError('operation-failed', `Stopped waiting for commit ${id}; its outcome is unknown`)
      const answer = await this.deps.read().catch((error: unknown) => {
        throw new AppClientCliError('operation-failed', `Cannot read commit ${id}; its outcome is unknown: ${ErrorText.of(error)}`)
      })
      if (!answer.ok) return { ...answer, error: { ...answer.error,
        detail: `Commit ${id}: ${answer.error.detail}. Its outcome is unknown`,
        data: { ...JsonShape.record(answer.error.data), commitSessionId: id } } }
      if (!CommitStatusReader.valid(answer.value, id))
        throw new AppClientCliError('operation-failed', `Invalid status for commit ${id}; its outcome is unknown`)
      const value = answer.value
      if (!wait || value.state === 'committed' || value.state === 'cancelled' || value.state === 'failed' || value.state === 'external-closed') return answer
      const remaining = deadline - this.deps.now()
      if (remaining <= 0) throw new AppClientCliError('timeout', `Still waiting for commit ${id}; query this UUID again. No other dialog was opened`)
      await this.deps.pause(Math.min(1_000, remaining), signal).catch((error: unknown) => {
        throw new AppClientCliError('operation-failed', `Stopped waiting for commit ${id}; its outcome is unknown: ${ErrorText.of(error)}`)
      })
    }
  }
}
