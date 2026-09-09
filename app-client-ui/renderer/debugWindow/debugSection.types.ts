import type { JSX } from 'react'

import type { DebugSectionId } from '../../shared/debugSections.types'

/**
 * What the Debug window knows about a node of its tree: what to call it, where it sits among its
 * siblings, what to draw, and what sits under it. Nothing else, and in particular nothing that flows
 * back up - the window is read-only, so there is no unsaved work to ask about and no state a section
 * has to hand the frame.
 *
 * A subsystem brings its own model, its own effects and its own named channels. Adding one, or
 * cutting an existing one into more nodes, is a change to the catalog beside this file and nothing
 * in the frame.
 */
export interface DebugSectionDescriptor {
  id: DebugSectionId
  title: string
  /** Position among its siblings. Two of them claiming one number is a refused catalog. */
  order: number
  /** Mounted only while it is the selected node, so a node nobody is looking at costs nothing. */
  Component: () => JSX.Element
  /**
   * What the subsystem's data is cut into. A parent is selectable itself and draws its own screen,
   * so the tree has no node that exists only to be opened.
   */
  children?: readonly DebugSectionDescriptor[]
}
