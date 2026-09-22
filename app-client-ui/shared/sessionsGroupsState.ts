import type { SessionGroup } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalTargetCodec, type TerminalTarget } from './terminalTarget'

export type { SessionGroup }

export interface SessionGroupAssignment {
  key: string
  group: SessionGroup
}

/**
 * What is missing from the list below, expressed as a type. A group added to the library and
 * forgotten here would otherwise be a name a create can ask for and no section draws - the same
 * trick that keeps `SessionPalette` honest against the colour union.
 */
type MissingSessionGroup = Exclude<SessionGroup, (typeof SessionsGroupsState.choicesConst)[number]['key']>

export class SessionsGroupsState {
  /**
   * The groups as the menu offers them and as the tree stacks them, top to bottom. The ORDER is this
   * list's whole contribution: the library's own list decides what may be STORED and is asked
   * `includes`, where order means nothing. Automation sits directly under Sessions because what it
   * holds is work nobody is waiting on - above the two sections a person reads when something needs
   * them, and below the two they keep their own work in.
   */
  static readonly choicesConst = [
    { key: 'pinned', title: 'Pinned', label: 'Pinned' },
    { key: 'priority', title: 'Priority', label: 'Priority' },
    { key: 'none', title: 'Sessions', label: 'None' },
    { key: 'automation', title: 'Automation', label: 'Automation' },
    { key: 'waiting', title: 'Waiting', label: 'Waiting' },
    { key: 'blocked', title: 'Blocked', label: 'Blocked' },
  ] as const satisfies readonly { key: SessionGroup; title: string; label: string }[]

  /** Public for the reason `SessionGroups.completeConst` is: a type nobody reads checks nothing. */
  static readonly completeConst: [MissingSessionGroup] extends [never] ? true : never = true

  static isGroup(value: unknown): value is SessionGroup {
    return SessionsGroupsState.choicesConst.some((choice) => choice.key === value)
  }

  static isValid(value: unknown): value is readonly SessionGroupAssignment[] {
    if (!Array.isArray(value)) return false
    const keys = new Set<string>()
    for (const assignment of value) {
      if (assignment === null || typeof assignment !== 'object'
        || typeof assignment.key !== 'string' || assignment.key.length === 0 || assignment.key.length > 4096
        || !SessionsGroupsState.isGroup(assignment.group) || keys.has(assignment.key)) return false
      keys.add(assignment.key)
    }
    return true
  }

  static coerce(value: unknown, report: (message: string) => void): readonly SessionGroupAssignment[] {
    if (value === undefined) return []
    if (SessionsGroupsState.isValid(value)) return structuredClone(value)
    report('Stored session groups are invalid; using no assignments')
    return []
  }

  static groupOf(keys: readonly string[], assignments: ReadonlyMap<string, SessionGroup> | undefined): SessionGroup {
    for (const key of keys) {
      const group = assignments?.get(key)
      if (group !== undefined) return group
    }
    return 'none'
  }

  /**
   * The key one SESSION is assigned under. Here rather than at each place that spells it, because
   * the main process writes one at a fork and the tree reads one when it draws: the same rule in
   * two programs, and a prefix that drifted would silently assign nothing.
   */
  static sessionKeyOf(target: TerminalTarget): string {
    return `session:${TerminalTargetCodec.key(target)}`
  }

  /** What this key holds ON ITS OWN, as opposed to what it inherits. Null = nothing was said. */
  static ownGroupOf(
    assignments: readonly SessionGroupAssignment[],
    key: string,
  ): SessionGroup | null {
    return assignments.find((assignment) => assignment.key === key)?.group ?? null
  }

  /** One assignment written over the list, replacing whatever that key held. */
  static assigned(
    assignments: readonly SessionGroupAssignment[],
    key: string,
    group: SessionGroup,
  ): readonly SessionGroupAssignment[] {
    return [...assignments.filter((assignment) => assignment.key !== key), { key, group }]
  }
}
