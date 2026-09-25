import type { SessionGroup } from './sessionManagerApi.types'

/**
 * What a group id may look like, and the two ids nothing may take away.
 *
 * This was the closed list of six names until 2026-09-22, when the sections of the sessions tree
 * became something a person edits. A closed list cannot survive that: the names live in the client's
 * config now, the person adds and removes them, and a validator carrying its own copy of six strings
 * would refuse a section the tree beside it is drawing.
 *
 * So the question this answers changed, and that is the whole point of the file. It used to be "is
 * this one of the groups", which only the client holding the list can answer now. It is "could this
 * be a group at all", which is a property of the id, is the same on every computer, and is what lets
 * the control protocol and the CLI refuse nonsense before a round trip. A well-formed id that the
 * target does not have is refused by the target, by name, which is the only place that knows.
 */
export class SessionGroups {
  /** No group: a session put back into Sessions on purpose, which outranks what its project says. */
  static readonly noneConst: SessionGroup = 'none'
  /** What the pin-only surfaces write, and the reason this one cannot be removed either. */
  static readonly pinnedConst: SessionGroup = 'pinned'
  /**
   * The two a person may MOVE but not remove or rename. Moving them is the point: where Sessions and
   * Pinned sit is what decides which sections are read above the person's own work and which below.
   */
  static readonly structuralConst: readonly SessionGroup[] = ['none', 'pinned']
  static readonly idMaxLengthConst = 64
  static readonly titleMaxLengthConst = 40
  /**
   * Lowercase with single hyphens, because an id is typed on a command line: `--group Waiting`
   * failing on the shift key is not a refusal worth having. The capitals a person wants to read are
   * the title's, which is a separate field for exactly that reason.
   */
  static readonly idPatternConst = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  /** The sentence a refusal says. Three callers were otherwise about to word it three ways. */
  static readonly idRuleConst =
    'a group id is lowercase letters, digits and single hyphens, at most 64 characters'

  static isId(value: unknown): value is SessionGroup {
    return typeof value === 'string'
      && value.length <= SessionGroups.idMaxLengthConst
      && SessionGroups.idPatternConst.test(value)
  }

  static isStructural(id: SessionGroup): boolean {
    return SessionGroups.structuralConst.includes(id)
  }

  static isTitle(value: unknown): value is string {
    return typeof value === 'string'
      && value.trim().length > 0
      && value.length <= SessionGroups.titleMaxLengthConst
  }
}
