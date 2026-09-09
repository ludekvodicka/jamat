import type {
  RemoteControlSessionSelector,
  RemoteControlStepResult,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { SessionsSnapshotValidation } from '../../lib-orchestrator/sessionManager/sessionsSnapshotValidation'
import { SessionWorkingDirectory } from '../../lib-orchestrator/sessionManager/sessionWorkingDirectory'
import { PathCompare } from '../../lib-orchestrator/shared/pathCompare'

export interface SessionSelectorResolverDeps {
  list(): Promise<RemoteControlStepResult<unknown>>
}

export class SessionSelectorResolver {
  constructor(private readonly deps: SessionSelectorResolverDeps) {}

  async canonical(
    selector: RemoteControlSessionSelector,
    workingDirectory?: string,
  ): Promise<RemoteControlStepResult<{ kind: 'sessionId'; sessionId: string }>> {
    if (selector.kind === 'sessionId') {
      if (workingDirectory !== undefined)
        return SessionSelectorResolver.error(
          'invalid-request',
          '--working-directory cannot be combined with --session-id',
        )
      return { ok: true, value: selector }
    } else if (selector.kind === 'number') {
      const listed = await this.deps.list()
      if (!listed.ok) return { ok: false, error: listed.error }
      const snapshot = SessionsSnapshotValidation.parse(listed.value)
      if (snapshot === null)
        return SessionSelectorResolver.error(
          'operation-failed',
          'AppClientUI returned an invalid sessions snapshot',
        )
      let matches = snapshot.sessions.filter((session) =>
        session.titleParts.number === selector.number)
      if (workingDirectory !== undefined) {
        const expected = PathCompare.comparable(workingDirectory)
        matches = matches.filter((session) => {
          const candidate = SessionWorkingDirectory.of(session)
          return candidate !== null && PathCompare.comparable(candidate) === expected
        })
      }
      if (matches.length === 1)
        return { ok: true, value: { kind: 'sessionId', sessionId: matches[0]!.sessionId } }
      if (matches.length === 0)
        return SessionSelectorResolver.error(
          'not-found',
          `No session matches number ${selector.number}`,
        )
      return {
        ok: false,
        error: {
          code: 'conflict',
          detail: `Several sessions match number ${selector.number}`,
          data: {
            candidates: matches.map((session) => ({
              sessionId: session.sessionId,
              number: session.titleParts.number,
              title: session.title,
              workingDirectory: SessionWorkingDirectory.of(session),
            })),
          },
        },
      }
    } else
      throw new Error(`Unknown session selector: ${JSON.stringify(selector)}`)
  }

  private static error(
    code: 'invalid-request' | 'not-found' | 'operation-failed',
    detail: string,
  ): RemoteControlStepResult<{ kind: 'sessionId'; sessionId: string }> {
    return { ok: false, error: { code, detail } }
  }
}
