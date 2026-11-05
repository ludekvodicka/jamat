import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlSessionGroupsPort } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { SessionGroup, SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionGroups } from '../../../lib-orchestrator/sessionManager/sessionGroups'
import { SessionsGroupsState, type SessionGroupDefinition } from '../../../lib-orchestrator/clientApi/sessionsGroupsState'
import type { ShellGroupAssignment, ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'

/**
 * Where a control-protocol caller's group lands: the same store and the same key the tree's own menu
 * writes, so a session filed by a skill sits where a person would have dragged it.
 *
 * It is also the ONLY place that can answer whether the group exists. The protocol validator proves
 * the SHAPE of an id and stops there, because the sections are edited on the computer that answers
 * and a validator listing them would be listing somebody else's *(2026-09-22)*. So an id nothing here
 * has is refused by name, with the ids this computer does have, which is what a caller needs to know.
 *
 * A class of its own rather than a literal in `OrchestratorHub`, for that refusal: it is a rule with three
 * outcomes over two files, and a rule nothing can call on its own is a rule nothing can check.
 */
export class RemoteSessionGroups implements RemoteControlSessionGroupsPort {
  private readonly sections: () => readonly SessionGroupDefinition[]
  private readonly store: ShellSessionGroups
  private pushGeneration: number
  private assignments: readonly ShellGroupAssignment[]
  private readonly unsubscribe: () => void
  private readonly onChanged: () => void

  constructor(
    sections: () => readonly SessionGroupDefinition[],
    store: ShellSessionGroups,
    onChanged: () => void,
  ) {
    this.sections = sections
    this.store = store
    this.onChanged = onChanged
    this.pushGeneration = 0
    this.assignments = store.assignments()
    this.unsubscribe = store.onChanged(assignments => { this.pushGeneration += 1; this.assignments = assignments })
  }

  read(sessions: readonly SessionInfo[]): ReadonlyMap<string, SessionGroup | null> {
    const assignments = new Map(SessionsGroupsState.pruned(this.assignments, this.sections())
      .map(({ key, group }) => [key, group]))
    return new Map(sessions.map((session) => {
      const group = SessionsGroupsState.groupOf(SessionsGroupsState.keysOf(
        { kind: 'local', sessionId: session.sessionId }, session.project,
      ), assignments)
      return [session.sessionId, group === SessionGroups.noneConst ? null : group]
    }))
  }

  definitions(): readonly SessionGroupDefinition[] {
    return this.sections().map(({ id, title }) => ({ id, title }))
  }

  async assign(sessionId: string, group: SessionGroup): Promise<RemoteControlStepResult<{ group: SessionGroup }>> {
    const sections = this.sections()
    if (!SessionsGroupsState.isGroup(group, sections))
      return {
        ok: false,
        error: {
          code: 'invalid-request',
          detail: `This computer has no session group ${JSON.stringify(group)}; it has `
            + sections.map((section) => section.id).join(', '),
        },
      }
    const generation = this.pushGeneration
    const written = await this.store.assign({ kind: 'assign',
      key: SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId }), group })
    if (!written.ok)
      return {
        ok: false,
        error: { code: 'unavailable', detail: 'Client state is not accepting writes' },
      }
    // What tells a tree that is already open. A refused write sends nothing: every window would
    // read the file back and find exactly what it already holds.
    // A pushed native write can be newer than the reply to this request.
    if (generation === this.pushGeneration) this.assignments = written.assignments
    this.onChanged()
    return { ok: true, value: { group } }
  }

  /**
   * A fork keeps the section its parent was put in by hand. In the main process rather than in the
   * window that asked: the tree is drawn in the main window alone, and a holder window forks too.
   */
  async inherit(parentSessionId: string, sessionId: string): Promise<void> {
    const generation = this.pushGeneration
    const written = await this.store.assign({ kind: 'inherit',
      parentKey: SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId: parentSessionId }),
      key: SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId }),
    })
    if (written.ok) {
      if (generation === this.pushGeneration) this.assignments = written.assignments
      this.onChanged()
    }
  }

  dispose(): void { this.unsubscribe() }
}
