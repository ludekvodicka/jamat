import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteControlSessionGroupsPort } from '../../../lib-orchestrator/remoteControl/remoteControl'
import type { SessionGroup, SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionGroups } from '../../../lib-orchestrator/sessionManager/sessionGroups'
import { SessionsGroupsState, type SessionGroupDefinition } from '../../shared/sessionsGroupsState'
import type { ClientStateStore } from '../clientState/clientStateStore'

/**
 * Where a control-protocol caller's group lands: the same store and the same key the tree's own menu
 * writes, so a session filed by a skill sits where a person would have dragged it.
 *
 * It is also the ONLY place that can answer whether the group exists. The protocol validator proves
 * the SHAPE of an id and stops there, because the sections are edited on the computer that answers
 * and a validator listing them would be listing somebody else's *(2026-09-22)*. So an id nothing here
 * has is refused by name, with the ids this computer does have, which is what a caller needs to know.
 *
 * A class of its own rather than a literal in `AppHub`, for that refusal: it is a rule with three
 * outcomes over two files, and a rule nothing can call on its own is a rule nothing can check.
 */
export class RemoteSessionGroups implements RemoteControlSessionGroupsPort {
  private readonly sections: () => readonly SessionGroupDefinition[]
  private readonly store: Pick<ClientStateStore, 'assignSessionGroup' | 'loadSessionGroups'>
  private readonly onChanged: () => void

  constructor(
    sections: () => readonly SessionGroupDefinition[],
    store: Pick<ClientStateStore, 'assignSessionGroup' | 'loadSessionGroups'>,
    onChanged: () => void,
  ) {
    this.sections = sections
    this.store = store
    this.onChanged = onChanged
  }

  read(sessions: readonly SessionInfo[]): ReadonlyMap<string, SessionGroup | null> {
    const assignments = new Map(SessionsGroupsState.pruned(this.store.loadSessionGroups(), this.sections())
      .map(({ key, group }) => [key, group]))
    return new Map(sessions.map((session) => {
      const group = SessionsGroupsState.groupOf(SessionsGroupsState.keysOf(
        { kind: 'local', sessionId: session.sessionId }, session.project,
      ), assignments)
      return [session.sessionId, group === SessionGroups.noneConst ? null : group]
    }))
  }

  assign(sessionId: string, group: SessionGroup): RemoteControlStepResult<{ group: SessionGroup }> {
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
    if (!this.store.assignSessionGroup(
      SessionsGroupsState.sessionKeyOf({ kind: 'local', sessionId }),
      group,
    ))
      return {
        ok: false,
        error: { code: 'unavailable', detail: 'Client state is not accepting writes' },
      }
    // What tells a tree that is already open. A refused write sends nothing: every window would
    // read the file back and find exactly what it already holds.
    this.onChanged()
    return { ok: true, value: { group } }
  }
}
