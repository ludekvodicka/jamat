import { describe, expect, it } from 'vitest'

import type { WorktreeSettingsValue } from '../../../../../shared/worktreeSettings'
import {
  WorktreesSettingsModel,
  type WorktreesSettingsModelState,
  type WorktreesSettingsStep,
} from './worktreesSettingsModel'

describe('app-client-ui/renderer/overlays/configuration/tabs/worktrees/worktreesSettingsModel', () => {
  const offConst: WorktreeSettingsValue = { node: { pnpm: { globalVirtualStore: false } } }

  function loaded(value: WorktreeSettingsValue = offConst): WorktreesSettingsModelState {
    return WorktreesSettingsModel.transition(
      WorktreesSettingsModel.initial().state,
      { input: 'loaded', value },
    ).state
  }

  it('asks for its section before anything is on screen', () => {
    expect(WorktreesSettingsModel.initial().effects).toEqual([{ effect: 'load' }])
  })

  it('is modified once the switch moves, and not before', () => {
    const state = loaded()
    expect(WorktreesSettingsModel.isModified(state)).toBe(false)
    const moved = WorktreesSettingsModel.transition(
      state,
      { input: 'pnpm-global-virtual-store', value: true },
    ).state
    expect(WorktreesSettingsModel.isModified(moved)).toBe(true)
  })

  /* An option a newer build wrote beside this one must survive the edit, not just the read. */
  it('keeps every key it does not own when the switch moves', () => {
    const state = loaded({ future: 1, node: { deno: 2, pnpm: { strict: 3, globalVirtualStore: false } } } as WorktreeSettingsValue)
    const moved = WorktreesSettingsModel.transition(
      state,
      { input: 'pnpm-global-virtual-store', value: true },
    ).state
    expect(moved.buffer).toEqual({
      future: 1,
      node: { deno: 2, pnpm: { strict: 3, globalVirtualStore: true } },
    })
  })

  it('ignores a switch moved before the section arrived', () => {
    const step = WorktreesSettingsModel.transition(
      WorktreesSettingsModel.initial().state,
      { input: 'pnpm-global-virtual-store', value: true },
    )
    expect(step.state.buffer).toBeNull()
    expect(step.effects).toEqual([])
  })

  describe("the project's own setup", () => {
    const intentConst = { projectName: 'AppJamatV3', projectPath: 'Q:/x/AppJamatV3' }

    function opened(): WorktreesSettingsStep {
      return WorktreesSettingsModel.transition(loaded(), { input: 'project-opened', intent: intentConst })
    }

    it('asks for the file as soon as a project is named', () => {
      const step = opened()
      expect(step.effects).toEqual([{ effect: 'project-load', projectPath: intentConst.projectPath }])
      expect(step.state.project?.buffer).toBeNull()
    })

    /* Two different answers: "declares nothing" and "declares that it needs nothing". */
    it('keeps a project that declares nothing apart from one that declares an empty setup', () => {
      const none = WorktreesSettingsModel.transition(opened().state, { input: 'project-loaded', setup: null }).state
      expect(none.project?.loaded).toBeNull()
      expect(none.project?.buffer).toEqual([])
      expect(WorktreesSettingsModel.projectModified(none)).toBe(false)

      const empty = WorktreesSettingsModel.transition(opened().state, { input: 'project-loaded', setup: [] }).state
      expect(empty.project?.loaded).toEqual([])
      expect(WorktreesSettingsModel.projectModified(empty)).toBe(false)
    })

    it('is modified once a line is typed, and saves what was typed', () => {
      const read = WorktreesSettingsModel.transition(opened().state, { input: 'project-loaded', setup: [] }).state
      const typed = WorktreesSettingsModel.transition(read, { input: 'project-edited', setup: ['pnpm i'] }).state
      expect(WorktreesSettingsModel.projectModified(typed)).toBe(true)
      expect(WorktreesSettingsModel.isModified(typed)).toBe(true)

      const saving = WorktreesSettingsModel.transition(typed, { input: 'project-save' })
      expect(saving.effects).toEqual([
        { effect: 'project-save', projectPath: intentConst.projectPath, setup: ['pnpm i'] },
      ])
      // A write in flight is not unsaved work; a second Save would race two writers over one file.
      expect(WorktreesSettingsModel.projectModified(saving.state)).toBe(false)
      expect(WorktreesSettingsModel.transition(saving.state, { input: 'project-save' }).effects).toEqual([])

      const saved = WorktreesSettingsModel.transition(saving.state, { input: 'project-saved', ok: true }).state
      expect(saved.project?.loaded).toEqual(['pnpm i'])
      expect(WorktreesSettingsModel.projectModified(saved)).toBe(false)
    })

    it('offers no editor over a file the writer is going to refuse', () => {
      const broken = WorktreesSettingsModel.transition(
        opened().state,
        { input: 'project-unreadable', problem: 'not valid JSON' },
      ).state
      expect(broken.project?.readOnly).toBe(true)
      expect(broken.project?.buffer).toBeNull()
      expect(broken.project?.problem).toBe('not valid JSON')
      // An edit dispatched anyway changes nothing, and a save asks for nothing.
      const edited = WorktreesSettingsModel.transition(broken, { input: 'project-edited', setup: ['x'] }).state
      expect(edited.project?.buffer).toBeNull()
      expect(WorktreesSettingsModel.transition(broken, { input: 'project-save' }).effects).toEqual([])
    })

    it('keeps the buffer and says why when the write is refused', () => {
      const read = WorktreesSettingsModel.transition(opened().state, { input: 'project-loaded', setup: [] }).state
      const typed = WorktreesSettingsModel.transition(read, { input: 'project-edited', setup: ['pnpm i'] }).state
      const saving = WorktreesSettingsModel.transition(typed, { input: 'project-save' }).state
      const refused = WorktreesSettingsModel.transition(
        saving,
        { input: 'project-saved', ok: false, problem: 'is not writable' },
      ).state
      expect(refused.project?.problem).toBe('is not writable')
      expect(refused.project?.buffer).toEqual(['pnpm i'])
      expect(WorktreesSettingsModel.projectModified(refused)).toBe(true)
    })

    it('ignores an answer that arrives for a project nobody named', () => {
      expect(WorktreesSettingsModel.transition(loaded(), { input: 'project-loaded', setup: [] }).state.project)
        .toBeNull()
    })
  })

  it('throws on an input nobody handles', () => {
    expect(() => WorktreesSettingsModel.transition(
      loaded(),
      { input: 'yarn-something' } as never,
    )).toThrow('Unknown worktrees settings input')
  })
})
