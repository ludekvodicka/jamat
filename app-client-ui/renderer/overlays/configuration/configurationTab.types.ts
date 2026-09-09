import type { JSX } from 'react'

import type { WorktreeSetupIntentStore } from './worktreeSetupIntentStore'

/**
 * Every settings node there is, groups and screens alike. A closed union, like `CommandId`: it grows
 * one entry per node.
 */
export type ConfigurationTabId =
  | 'projects'
  | 'ui'
  | 'keyboard'
  | 'agents'
  | 'versioning'
  | 'worktrees'
  | 'remarkable'
  | 'remarkableConnection'
  | 'remarkableStorage'
  | 'remoteControl'
  | 'remoteControlThisComputer'
  | 'remoteControlConnect'
  | 'remoteControlConnections'
  | 'window'

export interface ConfigurationOpenRequest {
  requestId: number
  /** A group is accepted here and resolves to its first screen; a caller need not know the shape. */
  tab: ConfigurationTabId | null
}

export interface ConfigurationTabProps {
  /**
   * The one fact that flows up. Only the window knows that a group is being left or that the card
   * is closing, so only it can ask before either happens - and it can only ask about a tab that
   * told it there was something to lose.
   */
  onDirtyChange: (dirty: boolean) => void
  /**
   * The one fact that flows down, and the mirror of the one above: what the surface that opened the
   * window asked for. It is a store with a one-shot `consume` rather than a value, so a card opened
   * later from Ctrl+, is not still editing the project somebody right-clicked last week.
   *
   * Optional because ABSENT IS A REAL STATE and the one Ctrl+, produces: nobody named a project.
   * Only Worktrees reads it, and requiring it would put a field on every tab's test for the benefit
   * of one - which is the same trade that kept the window's own Save button off the frame.
   */
  worktreeSetupIntents?: WorktreeSetupIntentStore
}

interface ConfigurationTabNode {
  id: ConfigurationTabId
  title: string
  /** Position among its siblings. Two of them claiming one number is a refused catalog. */
  order: number
}

/**
 * What the window knows about a settings node: what to call it, where it sits among its siblings,
 * and then either what to draw or what sits under it. Saving is not here on purpose - each tab
 * writes its own file with its own writer, so a single Save button on the frame would report one
 * outcome for two different writes.
 *
 * A node is one or the other, never both, and the compiler is what says so. Unlike the Debug tree, a
 * GROUP here draws nothing: a settings group has no state of its own to show, and a screen invented
 * to fill the pane would be a screen nobody asked for. Selecting a group therefore selects its first
 * screen.
 */
export type ConfigurationTabDescriptor =
  | (ConfigurationTabNode & {
    Component: (props: ConfigurationTabProps) => JSX.Element
    children?: undefined
  })
  | (ConfigurationTabNode & {
    children: readonly ConfigurationTabDescriptor[]
    Component?: undefined
  })
