import type { AutomationState } from './sessionManagerApi.types'

/**
 * The closed set of bot states and the one guard over it: the validator, the CLI parser, the
 * lifecycle, the renderer, the filter and the mobile relay prove a state against this list.
 *
 * Web-safe on purpose (type imports only, no Node, DOM or clock), because the renderer and the
 * relay import it as a value. The same read/write asymmetry as `SessionColors`: a write of an
 * unknown state is refused, a read of one is absent, because a newer computer's state must never
 * cost a record or break an older view.
 */
export class AutomationStates {
  static readonly allConst = ['working', 'waiting', 'blocked', 'completed'] as const satisfies readonly AutomationState[]

  static readonly completeConst:
    [Exclude<AutomationState, (typeof AutomationStates.allConst)[number]>] extends [never]
      ? true
      : never = true

  static isState(value: unknown): value is AutomationState {
    return typeof value === 'string' && AutomationStates.allConst.includes(value as AutomationState)
  }

  static readOf(value: unknown): AutomationState | undefined {
    return AutomationStates.isState(value) ? value : undefined
  }

  /**
   * The ids of the four former bot sections. The startup cleanup removes them, and a new section never
   * takes one (dormant register, startup cleanup).
   */
  static readonly formerSectionIdsConst = ['automation', 'waiting', 'blocked', 'completed'] as const

  static isFormerSectionId(id: string): boolean {
    return (AutomationStates.formerSectionIdsConst as readonly string[]).includes(id)
  }
}
