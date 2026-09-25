import { describe, expect, it } from 'vitest'

import { SessionsGroupsState } from '../../../../../shared/sessionsGroupsState'
import {
  SessionGroupsSettingsModel,
  type SessionGroupsList,
  type SessionGroupsSettingsInput,
  type SessionGroupsSettingsModelState,
} from './sessionGroupsSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/sessionGroups/sessionGroupsSettingsModel', () => {
  /** The card as it stands after a read, which is where every control below starts. */
  function loaded(groups: SessionGroupsList): SessionGroupsSettingsModelState {
    return SessionGroupsSettingsModel
      .transition(SessionGroupsSettingsModel.initial().state, { input: 'loaded', value: groups })
      .state
  }

  function after(
    groups: SessionGroupsList,
    ...inputs: readonly SessionGroupsSettingsInput[]
  ): SessionGroupsSettingsModelState {
    let state = loaded(groups)
    for (const input of inputs) state = SessionGroupsSettingsModel.transition(state, input).state
    return state
  }

  const seeded = SessionsGroupsState.defaultsConst

  it('asks for the list as it opens and reads it as the yardstick for modified', () => {
    const start = SessionGroupsSettingsModel.initial()

    expect(start.effects).toEqual([{ effect: 'load' }])
    expect(SessionGroupsSettingsModel.isModified(start.state)).toBe(false)
    expect(SessionGroupsSettingsModel.isModified(loaded(seeded))).toBe(false)
  })

  /*
   * The id is DERIVED and then fixed for the group's life. It is what an assignment names and what
   * `--group` takes, both in other files, so a rename that moved it would quietly empty the section
   * the person had just renamed.
   */
  it('names a new section after its title and keeps that id through every rename', () => {
    const added = after(seeded, { input: 'add', title: '  Needs Review  ' })
    const group = added.buffer!.at(-1)!

    expect(group).toEqual({ id: 'needs-review', title: 'Needs Review' })
    expect(SessionGroupsSettingsModel.isModified(added)).toBe(true)
    const renamed = SessionGroupsSettingsModel
      .transition(added, { input: 'rename', id: 'needs-review', title: 'Review' }).state
    expect(renamed.buffer!.at(-1)).toEqual({ id: 'needs-review', title: 'Review' })
  })

  it('numbers a second section whose name slugs onto an id already taken', () => {
    const twice = after(seeded, { input: 'add', title: 'Waiting' }, { input: 'add', title: 'Waiting' })

    expect(twice.buffer!.slice(-2)).toEqual([
      { id: 'waiting-2', title: 'Waiting' },
      { id: 'waiting-3', title: 'Waiting' },
    ])
  })

  /*
   * The tab disables Add on an empty field, so the only way here is a name that LOOKS like one and
   * slugs to nothing. Inventing a fallback id would file sessions under a word nobody typed.
   */
  it('adds nothing for a name that cannot become an id', () => {
    const state = after(seeded, { input: 'add', title: '...' })

    expect(state.buffer).toEqual(seeded)
    expect(SessionGroupsSettingsModel.isModified(state)).toBe(false)
  })

  it('moves a section one step and leaves the ends alone', () => {
    const up = after(seeded, { input: 'move', id: 'completed', delta: -1 })
    const stuck = after(seeded, { input: 'move', id: 'pinned', delta: -1 })

    expect(up.buffer!.map((definition) => definition.id))
      .toEqual(['pinned', 'priority', 'none', 'automation', 'completed', 'waiting', 'blocked'])
    expect(stuck.buffer).toEqual(seeded)
  })

  /*
   * Sessions and Pinned are in the list so they can be MOVED - that is what decides which sections a
   * person reads above their own work and which below - and they are the two a remove must not take.
   */
  it('moves the two fixed sections and refuses to remove either', () => {
    const moved = after(seeded, { input: 'move', id: 'none', delta: -1 })

    expect(moved.buffer!.map((definition) => definition.id).slice(0, 3))
      .toEqual(['pinned', 'none', 'priority'])
    for (const id of ['none', 'pinned']) {
      expect(SessionGroupsSettingsModel.isFixed({ id, title: 'x' })).toBe(true)
      expect(after(seeded, { input: 'remove', id }).buffer!.map((one) => one.id)).toContain(id)
    }
    expect(SessionGroupsSettingsModel.isFixed({ id: 'completed', title: 'Completed' })).toBe(false)
    expect(after(seeded, { input: 'remove', id: 'completed' }).buffer!.map((one) => one.id))
      .not.toContain('completed')
  })

  /*
   * A title emptied halfway through being retyped is the ordinary case, not a failure. It is a Save
   * the file would refuse, so the button says no and the reason stands beside it.
   */
  it('says why a save is refused without calling the card broken', () => {
    const emptied = after(seeded, { input: 'rename', id: 'waiting', title: '  ' })

    expect(emptied.problem).toBeNull()
    expect(SessionGroupsSettingsModel.problemOf(emptied)).toMatch(/every session group needs an id/)
    expect(SessionGroupsSettingsModel.problemOf(loaded(seeded))).toBeNull()
    expect(SessionGroupsSettingsModel.problemOf(SessionGroupsSettingsModel.initial().state)).toBeNull()
  })

  it('writes the whole list on save and takes it as loaded once it lands', () => {
    const edited = after(seeded, { input: 'add', title: 'Shipped' })
    const saving = SessionGroupsSettingsModel.transition(edited, { input: 'save' })

    expect(saving.effects).toEqual([{ effect: 'save', value: edited.buffer }])
    // A save in flight is not unsaved work: what it carries is on its way to disk.
    expect(SessionGroupsSettingsModel.isModified(saving.state)).toBe(false)
    const landed = SessionGroupsSettingsModel.transition(saving.state, { input: 'saved', ok: true }).state
    expect(landed.loaded).toEqual(edited.buffer)
    expect(SessionGroupsSettingsModel.isModified(landed)).toBe(false)
  })

  it('restores the seeded sections on reset', () => {
    const state = after(seeded, { input: 'remove', id: 'blocked' }, { input: 'reset' })

    expect(state.buffer).toEqual(seeded)
  })
})
