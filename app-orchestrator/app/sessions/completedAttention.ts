import { SessionsAttentionModel } from '../../../lib-orchestrator/clientApi/sessionsAttentionModel'
import type { ProjectBinding } from '../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { SessionActivity, SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

export interface CompletedAttentionNotice {
  sessionId: string
  title: string
  body: string
  attribution: string | null
  silent: boolean
}

export interface CompletedAttentionPorts {
  /** The `ui` section, read at each completion, so a saved change applies to the next one. */
  settings(): { enabled: boolean; sound: boolean }
  /** True while no workspace window has the focus. */
  background(): boolean
  show(notice: CompletedAttentionNotice): void
}

/**
 * Tells the person, through a Windows notice, that an agent turn of a local session settled while
 * Jamat was in the background. The settle is the tree mark's own rule (`SessionsAttentionModel.settled`),
 * but it is read for every session, also the one in front: with another application focused, the
 * session in Jamat's active tab is not being looked at either. The first sighting of a session tells
 * nothing, because a settle needs a previous `working`.
 */
export class CompletedAttention {
  static readonly bodyConst = 'Session completed'

  private readonly previous = new Map<string, SessionActivity | null>()
  private readonly ports: CompletedAttentionPorts

  constructor(ports: CompletedAttentionPorts) {
    this.ports = ports
  }

  /** Called on every sessions change with the local snapshot. */
  seen(snapshot: Pick<SessionsSnapshot, 'reconciled' | 'sessions'>): void {
    if (!snapshot.reconciled) return
    const present = new Set<string>()
    for (const session of snapshot.sessions) {
      if (session.script !== undefined) continue
      present.add(session.sessionId)
      const before = this.previous.get(session.sessionId)
      this.previous.set(session.sessionId, session.activity)
      if (!SessionsAttentionModel.settled(before, session.activity) || !this.ports.background()) continue
      const settings = this.ports.settings()
      if (settings.enabled)
        this.ports.show({ sessionId: session.sessionId, ...CompletedAttention.textOf(session), silent: !settings.sound })
    }
    for (const sessionId of [...this.previous.keys()]) if (!present.has(sessionId)) this.previous.delete(sessionId)
  }

  /**
   * The bold title names what finished, the project folder and the session. The folders above the
   * project go to the small attribution line, so a long path neither wraps the title nor pushes it out.
   */
  static textOf(session: Pick<SessionInfo, 'project' | 'title'>): Pick<CompletedAttentionNotice, 'title' | 'body' | 'attribution'> {
    const place = CompletedAttention.placeOf(session.project)
    if (place === null) return { title: session.title, body: CompletedAttention.bodyConst, attribution: null }
    const slash = place.lastIndexOf('/')
    return { title: `${place.slice(slash + 1)} · ${session.title}`, body: CompletedAttention.bodyConst, attribution: slash < 0 ? null : place.slice(0, slash) }
  }

  private static placeOf(project: ProjectBinding): string | null {
    let path: string
    if (project.kind === 'project') path = project.projectPath
    else if (project.kind === 'adHoc') path = project.path
    else if (project.kind === 'none') return null
    else throw new Error(`Unknown project binding: ${JSON.stringify(project satisfies never)}`)
    const place = path.replace(/^[A-Za-z]:[\\/]+/, '').replaceAll('\\', '/').replace(/\/+$/, '')
    return place === '' ? null : place
  }
}
