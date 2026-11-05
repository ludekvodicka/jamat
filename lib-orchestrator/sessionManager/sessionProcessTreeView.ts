import type { RuntimeSessionInfo } from '../../app-host/app/wire/hostWire'
import type { SessionInfo } from './sessionManagerApi.types'
import { SessionTitle } from './records/sessionTitle'

export interface SessionProcessRoot {
  pid: number
  startedAt: number
  sessionId: string
  session: string
  sessionKind: 'agent' | 'script' | 'shell'
  idle: boolean
}
export interface ProcessTreeRow { pid: number; parent: number; startedAt: number }

export class SessionProcessTreeView {
  static roots(runtimes: readonly RuntimeSessionInfo[], sessions: readonly Pick<SessionInfo, 'sessionId' | 'titleParts' | 'script' | 'kind' | 'activity'>[]): SessionProcessRoot[] {
    const byId = new Map(sessions.map(session => [session.sessionId, session]))
    const roots: SessionProcessRoot[] = []
    for (const runtime of runtimes) {
      const session = byId.get(runtime.runtimeSessionId)
      const number = session?.titleParts.number
      if (!runtime.alive || runtime.pid === undefined || runtime.processStartedAt === undefined
        || !session || !number || number.length > SessionTitle.numberCharactersConst || !SessionTitle.isSelectorNumber(number)) continue
      roots.push({ pid: runtime.pid, startedAt: runtime.processStartedAt, sessionId: session.sessionId,
        session: number, sessionKind: session.script ? 'script' : session.kind, idle: session.activity === 'idle' })
    }
    return roots
  }

  static owner(row: ProcessTreeRow, rows: ReadonlyMap<number, ProcessTreeRow>, roots: readonly SessionProcessRoot[]): SessionProcessRoot | null {
    const visited = new Set<number>()
    let current: ProcessTreeRow | undefined = row
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid)
      const { pid, startedAt } = current
      const root = roots.find(candidate => candidate.pid === pid && Math.abs(candidate.startedAt - startedAt) <= 1)
      if (root) return root
      const parent = rows.get(current.parent)
      if (!parent || parent.startedAt > current.startedAt) return null
      current = parent
    }
    return null
  }
}
