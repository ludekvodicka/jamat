import { SessionGroups } from '../../lib-orchestrator/sessionManager/sessionGroups'
import type { ProjectBinding } from '../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { SessionGroup } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PathText } from './pathText'
import { TerminalTargetCodec, type TerminalTarget } from './terminalTarget'

export type { SessionGroup }

export interface SessionGroupAssignment {
  key: string
  group: SessionGroup
}

/**
 * One section of the sessions tree: the id an assignment names, and the heading a person reads.
 *
 * Two fields rather than one because they are typed by different people. The id is written on a
 * command line and lives in two files, so it is lowercase and never changes once a group exists; the
 * title is what the section is called and can be rewritten whenever the person wants a better word.
 */
export interface SessionGroupDefinition {
  id: SessionGroup
  title: string
}

/** What a save answers, letter for letter the store's own codes, in this package's type. */
export type SessionGroupsSaveResult =
  | { ok: true }
  | { ok: false; code: 'config-latched' | 'invalid-section'; detail: string }

/**
 * The sections of the sessions tree, as a value: which ones exist, what they are called and the
 * order they are stacked in, plus the assignment of one key to one of them.
 *
 * The list was a literal here until 2026-09-22 and is now the `sessionGroups` section of
 * `config.json`. What stayed is the rule for reading one, because the main process validates a write
 * and the renderer offers the controls, and the two disagreeing is a group the tab can produce and
 * the file refuses. The list below is what a computer that has never been told otherwise gets.
 *
 * Order is the array's order, top to bottom, and it is the whole reason `none` and `pinned` are IN
 * the list rather than implied around it: where Sessions sits is what decides which sections are
 * read above a person's own work and which below.
 */
export class SessionsGroupsState {
  static readonly adHocRootConst = 'root:adhoc'
  static readonly noProjectRootConst = 'root:none'
  static readonly defaultsConst: readonly SessionGroupDefinition[] = [
    { id: 'pinned', title: 'Pinned' },
    { id: 'priority', title: 'Priority' },
    { id: 'none', title: 'Sessions' },
    { id: 'automation', title: 'Automation' },
    { id: 'waiting', title: 'Waiting' },
    { id: 'completed', title: 'Completed' },
    { id: 'blocked', title: 'Blocked' },
  ]
  static readonly maxGroupsConst = 24

  /**
   * What the Groups submenu calls a section. It is the title everywhere but `none`, where the
   * heading answers "which sessions are these" and the menu entry answers "which group is this in",
   * and the honest word for the second one is that there is none.
   */
  static labelOf(definition: SessionGroupDefinition): string {
    return definition.id === SessionGroups.noneConst ? 'None' : definition.title
  }

  static isDefinition(value: unknown): value is SessionGroupDefinition {
    if (value === null || typeof value !== 'object') return false
    const definition = value as { id?: unknown; title?: unknown }
    return SessionGroups.isId(definition.id) && SessionGroups.isTitle(definition.title)
  }

  /**
   * A list the tree can draw: every id well-formed and distinct, every title readable, both
   * structural ids present, and not so many sections that the panel is nothing but headings.
   */
  static isList(value: unknown): value is readonly SessionGroupDefinition[] {
    return SessionsGroupsState.problemOf(value) === null
  }

  /** The same question as `isList`, answered with the sentence a refusal needs. */
  static problemOf(value: unknown): string | null {
    if (!Array.isArray(value)) return 'session groups must be an array'
    if (value.length > SessionsGroupsState.maxGroupsConst)
      return `session groups must hold at most ${SessionsGroupsState.maxGroupsConst} groups`
    const ids = new Set<string>()
    for (const definition of value) {
      if (!SessionsGroupsState.isDefinition(definition))
        return `every session group needs an id (${SessionGroups.idRuleConst}) and a title of at most `
          + `${SessionGroups.titleMaxLengthConst} characters`
      if (ids.has(definition.id)) return `session group ${JSON.stringify(definition.id)} is listed twice`
      ids.add(definition.id)
    }
    for (const id of SessionGroups.structuralConst)
      if (!ids.has(id)) return `session groups must keep ${JSON.stringify(id)}`
    return null
  }

  /**
   * Total, like every section coercion: a list this build cannot draw is reported and replaced by
   * the defaults rather than latching the file. Nothing declares the list `damaged`, so a save over
   * a hand-edit that broke it is allowed - the settings tab IS the repair, and holding it off its
   * own value would leave the person with a tree they cannot fix from inside the app.
   */
  static coerceList(
    value: unknown,
    report: (message: string) => void,
  ): readonly SessionGroupDefinition[] {
    if (value === undefined) return structuredClone(SessionsGroupsState.defaultsConst)
    const problem = SessionsGroupsState.problemOf(value)
    if (problem === null) return structuredClone(value as readonly SessionGroupDefinition[])
    report(`Stored session groups are invalid (${problem}); using the default groups`)
    return structuredClone(SessionsGroupsState.defaultsConst)
  }

  /**
   * Whether an id names a section that exists. The list has to be handed in: this file knows what a
   * group may look like and the config knows which ones there are, and a guard that answered from
   * the defaults would call a group the person added unknown.
   */
  static isGroup(
    value: unknown,
    definitions: readonly SessionGroupDefinition[],
  ): value is SessionGroup {
    return typeof value === 'string' && definitions.some((definition) => definition.id === value)
  }

  /**
   * Shape only, because this is what the STORE of the assignments checks, and that file is written
   * by windows that may be older than the group list beside it. An assignment naming a section that
   * no longer exists is not damage, it is a group somebody removed; `pruned` below is what drops it,
   * and `groupOf` reads it as no group in the meantime.
   */
  static isValid(value: unknown): value is readonly SessionGroupAssignment[] {
    if (!Array.isArray(value)) return false
    const keys = new Set<string>()
    for (const assignment of value) {
      if (assignment === null || typeof assignment !== 'object'
        || typeof assignment.key !== 'string' || assignment.key.length === 0 || assignment.key.length > 4096
        || !SessionGroups.isId(assignment.group) || keys.has(assignment.key)) return false
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

  /**
   * The assignments that still name a section, which is what a removed group leaves behind. Whoever
   * SAVES the list calls it, so the file stops carrying the name of a section nobody can see;
   * whoever READS it calls it, so a tree drawn from a file another window wrote cannot hide a
   * session in a section that is not drawn.
   */
  static pruned(
    assignments: readonly SessionGroupAssignment[],
    definitions: readonly SessionGroupDefinition[],
  ): readonly SessionGroupAssignment[] {
    return assignments.filter((assignment) =>
      SessionsGroupsState.isGroup(assignment.group, definitions))
  }

  static groupOf(keys: readonly string[], assignments: ReadonlyMap<string, SessionGroup> | undefined): SessionGroup {
    for (const key of keys) {
      const group = assignments?.get(key)
      if (group !== undefined) return group
    }
    return SessionGroups.noneConst
  }

  static projectGroupOf(binding: ProjectBinding): { rootId: string; path: string | null } {
    if (binding.kind === 'project') return { rootId: `category:${binding.categoryId}`, path: binding.projectPath }
    else if (binding.kind === 'adHoc') return { rootId: SessionsGroupsState.adHocRootConst, path: binding.path }
    else if (binding.kind === 'none') return { rootId: SessionsGroupsState.noProjectRootConst, path: null }
    else throw new Error(`Unknown project binding: ${JSON.stringify(binding)}`)
  }

  static projectKeyOf(rootId: string, path: string): string {
    return `project:${rootId}/${PathText.comparable(path)}`
  }

  static keysOf(target: TerminalTarget, binding: ProjectBinding, namespace = ''): readonly string[] {
    const group = SessionsGroupsState.projectGroupOf(binding)
    const parentKeys = [
      ...(group.path === null ? [] : [SessionsGroupsState.projectKeyOf(group.rootId, group.path)]),
      group.rootId,
    ]
    return [
      SessionsGroupsState.sessionKeyOf(target),
      ...parentKeys.map((key) => namespace.length === 0 ? key : `${namespace}/${key}`),
    ]
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
