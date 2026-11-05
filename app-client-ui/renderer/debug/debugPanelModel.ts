import type { DebugSectionId } from '../../shared/debugSections.types'
import type { DebugSectionDescriptor } from './debugSection.types'
import { DebugSections } from './debugSections'

export interface DebugPanelState {
  activeSection: DebugSectionId
}

export type DebugPanelInput = { input: 'select'; section: DebugSectionId }

/**
 * The whole state of the Debug frame: which section is on screen. There is no dirty tracking and no
 * question before leaving one, because nothing here is edited - a read-only surface has nothing to
 * lose by being walked away from, which is what makes this a different machine from the settings
 * window's rather than a generalization of it.
 */
export class DebugPanelModel {
  /**
   * The first node of the first subsystem. A parent draws a screen of its own, so the tab opens on
   * something rather than on a node that exists only to be opened. An empty catalog is a defect, not
   * a tab with nothing in it.
   */
  static initial(
    sections: readonly DebugSectionDescriptor[] = DebugSections.ordered(),
  ): DebugPanelState {
    const first = sections[0]
    if (!first)
      throw new Error('The debug catalog holds no section')
    return { activeSection: first.id }
  }

  static transition(state: DebugPanelState, input: DebugPanelInput): DebugPanelState {
    if (input.input === 'select')
      // The same section again is the same state, object identity included: the frame reports the
      // active section to the main process whenever it changes, and a new object would report it
      // again for a click that changed nothing.
      return input.section === state.activeSection ? state : { activeSection: input.section }
    else
      throw new Error(`Unknown debug input: ${JSON.stringify(input)}`)
  }
}
