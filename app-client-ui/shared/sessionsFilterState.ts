import type { SessionAgentId, SessionColorName } from '../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { JsonShape } from './jsonShape'
import { SessionPalette } from './sessionPalette'

export type SessionFilterStatus = keyof typeof SessionsFilterState.stateLabelsConst

export interface SessionsFilterValue {
  colors: readonly (SessionColorName | null)[]
  states: readonly SessionFilterStatus[]
  agents: readonly (SessionAgentId | null)[]
}

export interface SavedSessionsFilter {
  id: string
  name: string
  filters: SessionsFilterValue
  filterText: string
}

export class SessionsFilterState {
  static readonly allConst: SessionsFilterValue = { colors: [], states: [], agents: [] }
  static readonly defaultConst: SessionsFilterValue = { ...SessionsFilterState.allConst, states: ['active'] }
  /** What the filter menu's shortcut applies: what closed inside the window, and nothing else. */
  static readonly closedRecentlyConst: SessionsFilterValue = {
    ...SessionsFilterState.allConst, states: ['closedRecently'],
  }
  static readonly nameLengthMaxConst = 60
  /**
   * How far back "closed" reaches. Hours rather than a duration, because the label is built from
   * this same number: the window and the word for it cannot drift apart.
   */
  static readonly closedWithinHoursConst = 6
  static readonly closedWithinMsConst = SessionsFilterState.closedWithinHoursConst * 60 * 60 * 1_000
  static readonly stateLabelsConst = {
    active: 'Active (unfinished)',
    attention: 'Attention',
    running: 'Running',
    question: 'Question',
    idle: 'Idle',
    starting: 'Starting',
    background: 'Background work',
    ended: 'Ended',
    lost: 'Interrupted',
    completed: 'Completed',
    unknown: 'Unknown',
    /**
     * The one state that asks a clock rather than a record: whatever ended inside the window,
     * whether the person has called it finished or not. It is a state and not a filter dimension
     * of its own because it answers the same question the others do - which rows belong on screen -
     * and so it is saved, restored and combined exactly like them.
     */
    closedRecently: `Last ${SessionsFilterState.closedWithinHoursConst}h closed`,
  } as const
  static readonly agentChoicesConst = ['claude', 'codex', null] as const satisfies readonly (SessionAgentId | null)[]

  static isAll(value: SessionsFilterValue, text: string): boolean {
    return value.colors.length === 0 && value.states.length === 0
      && value.agents.length === 0 && text.trim() === ''
  }

  static equal(left: SessionsFilterValue, right: SessionsFilterValue): boolean {
    return SessionsFilterState.same(left.colors, right.colors)
      && SessionsFilterState.same(left.states, right.states)
      && SessionsFilterState.same(left.agents, right.agents)
  }

  static toggle<T>(values: readonly T[], value: T): readonly T[] {
    return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
  }

  static toggleState(values: readonly SessionFilterStatus[], value: SessionFilterStatus): readonly SessionFilterStatus[] {
    if (value === 'active') return values.includes(value) ? [] : ['active']
    return SessionsFilterState.toggle(values.filter((state) => state !== 'active'), value)
  }

  static isValid(value: unknown): value is SessionsFilterValue {
    if (!JsonShape.isRecord(value)) return false
    return SessionsFilterState.isSelection(value.colors, [...SessionPalette.namesConst, null])
      && SessionsFilterState.isSelection(value.states, Object.keys(SessionsFilterState.stateLabelsConst))
      && SessionsFilterState.isSelection(value.agents, SessionsFilterState.agentChoicesConst)
  }

  static isSavedList(value: unknown): value is readonly SavedSessionsFilter[] {
    return Array.isArray(value) && value.every(SessionsFilterState.isSaved)
      && new Set(value.map((item: SavedSessionsFilter) => item.id)).size === value.length
      && new Set(value.map((item: SavedSessionsFilter) => item.name.toLowerCase())).size === value.length
  }

  static coerceSaved(value: unknown, report: (message: string) => void): readonly SavedSessionsFilter[] {
    if (value === undefined) return []
    if (SessionsFilterState.isSavedList(value)) return value
    report('Stored session filters are invalid; using no saved filters')
    return []
  }

  static nameError(name: string, saved: readonly SavedSessionsFilter[]): string | null {
    if (name.length === 0) return 'Enter a filter name.'
    if (name.length > SessionsFilterState.nameLengthMaxConst) return 'The filter name is too long.'
    if (name.toLowerCase() === 'all') return 'All is reserved for showing every session.'
    if (saved.some((item) => item.name.toLowerCase() === name.toLowerCase()))
      return 'A filter with this name already exists.'
    return null
  }

  private static isSaved(value: unknown): value is SavedSessionsFilter {
    return JsonShape.isRecord(value)
      && typeof value.id === 'string' && value.id.length > 0
      && typeof value.name === 'string' && value.name === value.name.trim()
      && SessionsFilterState.nameError(value.name, []) === null
      && typeof value.filterText === 'string'
      && SessionsFilterState.isValid(value.filters)
  }

  private static isSelection(value: unknown, choices: readonly unknown[]): boolean {
    return Array.isArray(value) && new Set(value).size === value.length
      && value.every((item) => choices.includes(item))
  }

  private static same<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((item) => right.includes(item))
  }
}
