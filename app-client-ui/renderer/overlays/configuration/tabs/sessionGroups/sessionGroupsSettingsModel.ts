import { Slug } from '../../../../../../lib-orchestrator/shared/slug'
import { SessionGroups } from '../../../../../../lib-orchestrator/sessionManager/sessionGroups'
import {
  SessionsGroupsState,
  type SessionGroup,
  type SessionGroupDefinition,
} from '../../../../../shared/sessionsGroupsState'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
  type SettingsCardStep,
} from '../../settingsCard'

export type SessionGroupsList = readonly SessionGroupDefinition[]

export type SessionGroupsSettingsModelState = SettingsCardState<SessionGroupsList>

export type SessionGroupsSettingsInput =
  | SettingsCardInput<SessionGroupsList>
  /** A new section, named by the person. Its id is derived here and never typed. */
  | { input: 'add'; title: string }
  | { input: 'rename'; id: SessionGroup; title: string }
  | { input: 'move'; id: SessionGroup; delta: -1 | 1 }
  | { input: 'remove'; id: SessionGroup }

export type SessionGroupsSettingsEffect = SettingsCardEffect<SessionGroupsList>

export type SessionGroupsSettingsStep =
  SettingsCardStep<SessionGroupsList, SessionGroupsSettingsEffect>

/**
 * The session groups tab as data: the sections of the sessions tree, their order and their names.
 *
 * Four controls are this file's own - add, rename, move, remove - and the load, the save and the
 * "a save in flight is not unsaved work" rule are `SettingsCard`'s.
 *
 * An id is DERIVED from the first title and then fixed for the group's life. It is what an
 * assignment names, what `sessions group --group` takes and what lives in a second file, so letting
 * a rename change it would silently empty the section the person just renamed. What a rename changes
 * is the word on the heading, which is the thing they were actually asking to change.
 */
export class SessionGroupsSettingsModel {
  static initial(): SessionGroupsSettingsStep {
    return SettingsCard.initial()
  }

  static isModified(state: SessionGroupsSettingsModelState): boolean {
    return SettingsCard.isModified(state, (loaded, buffer) =>
      loaded.length === buffer.length
      && loaded.every((definition, index) =>
        definition.id === buffer[index]?.id && definition.title === buffer[index]?.title))
  }

  /**
   * Why the file would refuse what is on screen, or null. A title emptied mid-edit is the ordinary
   * case and it is not an error worth colouring the card red; it is a Save that would come back as
   * `invalid-section`, so the button says no and the reason stands beside it.
   */
  static problemOf(state: SessionGroupsSettingsModelState): string | null {
    return state.buffer === null ? null : SessionsGroupsState.problemOf(state.buffer)
  }

  /** Whether this row is one of the two that may be moved but never removed or renamed. */
  static isFixed(definition: SessionGroupDefinition): boolean {
    return SessionGroups.isStructural(definition.id)
  }

  static transition(
    state: SessionGroupsSettingsModelState,
    input: SessionGroupsSettingsInput,
  ): SessionGroupsSettingsStep {
    const shared = SettingsCard.transition<SessionGroupsList, SessionGroupsSettingsEffect>(
      state,
      input,
      () => SessionsGroupsState.defaultsConst,
    )
    if (shared !== null) return shared
    if (state.buffer === null) return SettingsCard.step(state)
    const buffer = state.buffer
    if (input.input === 'add')
      return SettingsCard.step({ ...state, buffer: SessionGroupsSettingsModel.added(buffer, input.title) })
    else if (input.input === 'rename')
      return SettingsCard.step({
        ...state,
        buffer: buffer.map((definition) => definition.id === input.id
          ? { ...definition, title: input.title }
          : definition),
      })
    else if (input.input === 'move')
      return SettingsCard.step({ ...state, buffer: SessionGroupsSettingsModel.moved(buffer, input.id, input.delta) })
    else if (input.input === 'remove')
      return SettingsCard.step({
        ...state,
        buffer: buffer.filter((definition) =>
          definition.id !== input.id || SessionGroups.isStructural(definition.id)),
      })
    else
      throw new Error(`Unknown session groups settings input: ${JSON.stringify(input)}`)
  }

  /**
   * A title the person typed as a section. The id is the title slugged, and a slug already taken
   * gets a number: two sections may be called the same thing by accident, and refusing the second
   * one would be a rule about wording rather than about what the file can hold.
   *
   * A title that slugs to nothing - punctuation, or a script the slug drops - adds no group. The tab
   * disables the button for an empty field, so the only way here is a name that LOOKS like one and
   * cannot become an id, and inventing `root` for it would file sessions under a word nobody typed.
   */
  private static added(buffer: SessionGroupsList, title: string): SessionGroupsList {
    const trimmed = title.trim()
    const base = Slug.of(trimmed).slice(0, SessionGroups.idMaxLengthConst)
    if (base.length === 0 || !SessionGroups.isTitle(trimmed)) return buffer
    const taken = new Set(buffer.map((definition) => definition.id))
    let id = base
    for (let suffix = 2; taken.has(id); suffix += 1) id = `${base}-${suffix}`
    return [...buffer, { id, title: trimmed }]
  }

  /** One step up or down. A row already at the end stays where it is rather than wrapping around. */
  private static moved(
    buffer: SessionGroupsList,
    id: SessionGroup,
    delta: -1 | 1,
  ): SessionGroupsList {
    const index = buffer.findIndex((definition) => definition.id === id)
    const target = index + delta
    if (index < 0 || target < 0 || target >= buffer.length) return buffer
    const next = [...buffer]
    next.splice(target, 0, ...next.splice(index, 1))
    return next
  }
}
