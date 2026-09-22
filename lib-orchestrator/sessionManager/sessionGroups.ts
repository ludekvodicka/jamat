import type { SessionGroup } from './sessionManagerApi.types'

/**
 * The closed set of group names, and the one guard over it.
 *
 * At the subsystem root beside `sessionColors.ts` and for its reason: a group may be named at
 * CREATE, so the control-protocol validator and the CLI parser prove the same name against one list
 * rather than each carrying six strings. The store that WRITES the assignment is the client's, and
 * so is the order the sections are drawn in; what is settled here is only which names exist.
 */
export class SessionGroups {
  static readonly namesConst = [
    'pinned', 'priority', 'none', 'automation', 'waiting', 'blocked',
  ] as const satisfies readonly SessionGroup[]

  /**
   * Public only so it counts as read: its whole job is to be a type that stops compiling when a name
   * is added to the union and forgotten here. Without it this list is merely ANNOTATED, and the list
   * is what decides whether a group can be ASKED FOR at all.
   */
  static readonly completeConst:
    [Exclude<SessionGroup, (typeof SessionGroups.namesConst)[number]>] extends [never]
      ? true
      : never = true

  static isName(value: unknown): value is SessionGroup {
    return typeof value === 'string'
      && SessionGroups.namesConst.includes(value as SessionGroup)
  }
}
