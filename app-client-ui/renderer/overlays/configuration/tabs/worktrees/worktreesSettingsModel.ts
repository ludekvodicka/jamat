import {
  WorktreeSettings,
  type WorktreeSettingsValue,
} from '../../../../../shared/worktreeSettings'
import {
  SettingsCard,
  type SettingsCardEffect,
  type SettingsCardInput,
  type SettingsCardState,
} from '../../settingsCard'
import type { WorktreeSetupIntent } from '../../worktreeSetupIntentStore'

/**
 * The project half of the tab, which is a second card over a second file and therefore keeps its own
 * buffer, its own Save and its own problem line. One Save for both would report one outcome for two
 * writes, which is why the settings frame carries no Save button of its own either.
 *
 * `loaded: null` is a project that declares nothing, and that is not the same answer as `[]` - a
 * project saying out loud that it needs nothing installed. `readOnly` is a file that could not be
 * parsed: `WorktreeConfig.save` refuses to write over one, so the editor must not offer a write that
 * is going to be refused.
 */
export interface WorktreesProjectState {
  intent: WorktreeSetupIntent
  loaded: string[] | null
  buffer: string[] | null
  saving: string[] | null
  readOnly: boolean
  problem: string | null
}

export interface WorktreesSettingsModelState extends SettingsCardState<WorktreeSettingsValue> {
  /** Null until a right-click says which project; Ctrl+, opens this tab with the machine half only. */
  project: WorktreesProjectState | null
}

export type WorktreesSettingsInput =
  | SettingsCardInput<WorktreeSettingsValue>
  | { input: 'pnpm-global-virtual-store'; value: boolean }
  | { input: 'project-opened'; intent: WorktreeSetupIntent }
  | { input: 'project-loaded'; setup: string[] | null }
  | { input: 'project-unreadable'; problem: string }
  | { input: 'project-edited'; setup: string[] }
  | { input: 'project-save' }
  | { input: 'project-saved'; ok: boolean; problem?: string }

/** The shared card's own two effects, named so the generic calls below can be pinned to them. */
type WorktreesCardEffect = SettingsCardEffect<WorktreeSettingsValue>

export type WorktreesSettingsEffect =
  | WorktreesCardEffect
  | { effect: 'project-load'; projectPath: string }
  | { effect: 'project-save'; projectPath: string; setup: string[] }

export interface WorktreesSettingsStep {
  state: WorktreesSettingsModelState
  effects: readonly WorktreesSettingsEffect[]
}

/**
 * The worktrees tab as data: this machine's install options, one project's own `setup`, and the
 * machine every settings card shares. The family table beside them on screen holds no state at all -
 * it is `SetupFamilies.catalogConst` drawn - so nothing about it is here.
 */
export class WorktreesSettingsModel {
  static initial(): WorktreesSettingsStep {
    const start = SettingsCard.initial<WorktreeSettingsValue, WorktreesCardEffect>()
    return { state: { ...start.state, project: null }, effects: start.effects }
  }

  /** Either half having unsaved work makes the tab dirty; the window asks one question about both. */
  static isModified(state: WorktreesSettingsModelState): boolean {
    return WorktreesSettingsModel.machineModified(state)
      || WorktreesSettingsModel.projectModified(state)
  }

  static machineModified(state: WorktreesSettingsModelState): boolean {
    return SettingsCard.isModified(
      state,
      (loaded, buffer) =>
        loaded.node.pnpm.globalVirtualStore === buffer.node.pnpm.globalVirtualStore,
    )
  }

  static projectModified(state: WorktreesSettingsModelState): boolean {
    const project = state.project
    if (project === null || project.saving !== null || project.buffer === null) return false
    return !WorktreesSettingsModel.sameLines(project.loaded ?? [], project.buffer)
  }

  static transition(
    state: WorktreesSettingsModelState,
    input: WorktreesSettingsInput,
  ): WorktreesSettingsStep {
    const shared = SettingsCard.transition<WorktreeSettingsValue, WorktreesCardEffect>(
      state,
      input,
      (buffer) => ({ ...buffer, ...WorktreeSettings.defaultValue() }),
    )
    // The shared arms carry `project` through by spreading, but only the runtime knows that.
    if (shared !== null)
      return { state: { ...shared.state, project: state.project }, effects: shared.effects }
    if (input.input === 'pnpm-global-virtual-store')
      return WorktreesSettingsModel.pnpm(state, input.value)
    else if (input.input === 'project-opened')
      return {
        state: {
          ...state,
          project: {
            intent: input.intent,
            loaded: null,
            buffer: null,
            saving: null,
            readOnly: false,
            problem: null,
          },
        },
        effects: [{ effect: 'project-load', projectPath: input.intent.projectPath }],
      }
    else if (input.input === 'project-loaded')
      return WorktreesSettingsModel.project(state, (project) => ({
        ...project,
        loaded: input.setup,
        buffer: input.setup ?? [],
        readOnly: false,
        problem: null,
      }))
    else if (input.input === 'project-unreadable')
      // No buffer at all: a file the writer will refuse must not look editable.
      return WorktreesSettingsModel.project(state, (project) => ({
        ...project,
        loaded: null,
        buffer: null,
        saving: null,
        readOnly: true,
        problem: input.problem,
      }))
    else if (input.input === 'project-edited')
      return WorktreesSettingsModel.project(state, (project) =>
        project.readOnly ? project : { ...project, buffer: input.setup })
    else if (input.input === 'project-save')
      return WorktreesSettingsModel.projectSave(state)
    else if (input.input === 'project-saved')
      return WorktreesSettingsModel.project(state, (project) => input.ok
        // `loaded` becomes what the WRITE carried: anything typed since is still unsaved work.
        ? { ...project, loaded: project.saving, saving: null, problem: null }
        : { ...project, saving: null, problem: input.problem ?? 'Save refused' })
    else
      throw new Error(`Unknown worktrees settings input: ${JSON.stringify(input)}`)
  }

  private static pnpm(
    state: WorktreesSettingsModelState,
    value: boolean,
  ): WorktreesSettingsStep {
    if (state.buffer === null) return { state, effects: [] }
    // Spread every level: a key a newer build wrote beside this flag survives the edit.
    return {
      state: {
        ...state,
        buffer: {
          ...state.buffer,
          node: {
            ...state.buffer.node,
            pnpm: { ...state.buffer.node.pnpm, globalVirtualStore: value },
          },
        },
      },
      effects: [],
    }
  }

  private static projectSave(state: WorktreesSettingsModelState): WorktreesSettingsStep {
    const project = state.project
    // A second save while the first is in flight would race two writers over one file.
    if (project === null || project.buffer === null || project.saving !== null || project.readOnly)
      return { state, effects: [] }
    const setup = project.buffer
    return {
      state: { ...state, project: { ...project, saving: setup, problem: null } },
      effects: [{ effect: 'project-save', projectPath: project.intent.projectPath, setup }],
    }
  }

  private static project(
    state: WorktreesSettingsModelState,
    next: (project: WorktreesProjectState) => WorktreesProjectState,
  ): WorktreesSettingsStep {
    // An answer that arrives after the tab moved on to another project belongs to nobody.
    if (state.project === null) return { state, effects: [] }
    return { state: { ...state, project: next(state.project) }, effects: [] }
  }

  private static sameLines(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((line, index) => line === right[index])
  }
}
