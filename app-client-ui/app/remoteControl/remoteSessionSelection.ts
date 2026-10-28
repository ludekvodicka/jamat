import type { SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

type SessionLink = Pick<SessionInfo, 'sessionId' | 'parent' | 'script'>

export class RemoteSessionSelection {
  static reachable(roots: ReadonlySet<string>, sessions: readonly SessionLink[]): Set<string> {
    const children = new Map<string, string[]>()
    for (const session of sessions)
      for (const parent of RemoteSessionSelection.parents(session)) {
        const entries = children.get(parent) ?? []
        entries.push(session.sessionId)
        children.set(parent, entries)
      }
    const reached = new Set(roots)
    for (const id of reached)
      for (const child of children.get(id) ?? []) reached.add(child)
    return reached
  }

  static ancestors(sessionId: string, sessions: readonly SessionLink[]): Set<string> {
    const byId = new Map(sessions.map((session) => [session.sessionId, session]))
    const reached = new Set([sessionId])
    for (const id of reached) {
      const session = byId.get(id)
      if (session)
        for (const parent of RemoteSessionSelection.parents(session)) reached.add(parent)
    }
    return reached
  }

  private static parents(session: SessionLink): string[] {
    return [session.parent?.sessionId, session.script?.parentId]
      .filter((id): id is string => id !== undefined)
  }
}
