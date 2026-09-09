import type { ConfigurationTabId } from './configurationTab.types'
import { ConfigurationTabs } from './configurationTabs'

export interface ConfigurationState {
  activeTab: ConfigurationTabId
  /** The tabs that said they hold something unsaved. The window never learns what. */
  dirty: ReadonlySet<ConfigurationTabId>
  /** The open question "you have unsaved changes": which tab is being left, and for where. */
  leaving: { from: ConfigurationTabId; to: ConfigurationTabId | 'close' } | null
}

export type ConfigurationInput =
  | { input: 'select'; tab: ConfigurationTabId }
  | { input: 'dirty'; tab: ConfigurationTabId; dirty: boolean }
  /** Escape, the close button and the backdrop: every way of asking to leave the surface. */
  | { input: 'escape' }
  | { input: 'leave-answered'; leave: boolean }

export type ConfigurationEffect =
  | { effect: 'close' }

export interface ConfigurationStep {
  state: ConfigurationState
  effects: readonly ConfigurationEffect[]
}

/**
 * The frame of the settings window as a pure machine: which group is shown, which groups hold
 * unsaved work, and the one question asked before leaving one of those.
 *
 * It owns no tab's content and saves nothing. Switching groups and closing the card are the same
 * decision made twice - they differ only in where the window ends up - so both run through one
 * branch and one question.
 */
export class ConfigurationModel {
  /**
   * The selection is always a SCREEN, never a group: a group draws nothing, so a window sitting on
   * one would have an empty pane. A caller that asks for a group gets its first screen.
   */
  static initial(requested: ConfigurationTabId | null = null): ConfigurationState {
    const [first] = ConfigurationTabs.screens()
    // The window with no group is a window with nothing to show, which is a catalog bug rather than
    // a state the frame should try to draw.
    if (!first)
      throw new Error('The configuration catalog holds no tab')
    const active = requested === null ? first : ConfigurationTabs.screenOf(requested)
    if (!active)
      throw new Error(`The configuration catalog holds no tab ${JSON.stringify(requested)}`)
    return { activeTab: active.id, dirty: new Set(), leaving: null }
  }

  static transition(state: ConfigurationState, input: ConfigurationInput): ConfigurationStep {
    if (input.input === 'select') return ConfigurationModel.selected(state, input.tab)
    else if (input.input === 'dirty') return ConfigurationModel.marked(state, input.tab, input.dirty)
    else if (input.input === 'escape') return ConfigurationModel.escaped(state)
    else if (input.input === 'leave-answered') return ConfigurationModel.answered(state, input.leave)
    else
      throw new Error(`Unknown configuration input: ${JSON.stringify(input)}`)
  }

  private static selected(state: ConfigurationState, tab: ConfigurationTabId): ConfigurationStep {
    // While the question stands it is the only thing on the card that answers; a click behind it
    // would move the window the user has not yet agreed to move.
    if (state.leaving !== null) return ConfigurationModel.step(state)
    const screen = ConfigurationTabs.screenOf(tab)
    if (screen === null)
      throw new Error(`The configuration catalog holds no tab ${JSON.stringify(tab)}`)
    if (screen.id === state.activeTab) return ConfigurationModel.step(state)
    if (!state.dirty.has(state.activeTab))
      return ConfigurationModel.step({ ...state, activeTab: screen.id })
    return ConfigurationModel.step({ ...state, leaving: { from: state.activeTab, to: screen.id } })
  }

  private static marked(
    state: ConfigurationState,
    tab: ConfigurationTabId,
    dirty: boolean,
  ): ConfigurationStep {
    return ConfigurationModel.step({ ...state, dirty: ConfigurationModel.withDirty(state, tab, dirty) })
  }

  /** One layer per press: the question first, and only a card with no question open closes. */
  private static escaped(state: ConfigurationState): ConfigurationStep {
    if (state.leaving !== null)
      return ConfigurationModel.step({ ...state, leaving: null })
    if (state.dirty.has(state.activeTab))
      return ConfigurationModel.step({ ...state, leaving: { from: state.activeTab, to: 'close' } })
    return ConfigurationModel.step(state, { effect: 'close' })
  }

  private static answered(state: ConfigurationState, leave: boolean): ConfigurationStep {
    const leaving = state.leaving
    if (leaving === null)
      return ConfigurationModel.step(state)
    if (!leave)
      return ConfigurationModel.step({ ...state, leaving: null })
    // Leaving drops what the tab held: the window cannot save it, so carrying the mark on would
    // make the next Escape ask about work that is already gone.
    const dropped = ConfigurationModel.withDirty(state, leaving.from, false)
    if (leaving.to === 'close')
      return ConfigurationModel.step({ ...state, dirty: dropped, leaving: null }, { effect: 'close' })
    return ConfigurationModel.step({ ...state, activeTab: leaving.to, dirty: dropped, leaving: null })
  }

  private static withDirty(
    state: ConfigurationState,
    tab: ConfigurationTabId,
    dirty: boolean,
  ): ReadonlySet<ConfigurationTabId> {
    const next = new Set(state.dirty)
    if (dirty)
      next.add(tab)
    else
      next.delete(tab)
    return next
  }

  private static step(
    state: ConfigurationState,
    ...effects: readonly ConfigurationEffect[]
  ): ConfigurationStep {
    return { state, effects }
  }
}
