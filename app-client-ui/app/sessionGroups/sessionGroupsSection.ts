import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { SessionsGroupsState, type SessionGroupDefinition } from '../../shared/sessionsGroupsState'

/**
 * The `sessionGroups` key of `config.json`: which sections the sessions tree has, what they are
 * called and the order they are stacked in.
 *
 * Here rather than beside the assignments in the client state, and the split is deliberate. The list
 * is a SETTING - a person opens the settings window and edits it, like every other section of this
 * file - while an assignment is state a window writes as somebody drags a row. What connects them is
 * that a removed group leaves assignments naming it, and `SessionsGroupsState.pruned` is the one
 * rule for that, called by the service that saves this section.
 *
 * There is no rule here the renderer does not also have: the tab and this spec both read
 * `SessionsGroupsState`, so a list the tab could produce cannot be one this refuses.
 */
export class SessionGroupsSection {
  static readonly spec: ConfigSectionSpec<readonly SessionGroupDefinition[]> = {
    key: 'sessionGroups',
    coerce: (value, report) => SessionsGroupsState.coerceList(value, report),
    validate: (value) => SessionsGroupsState.problemOf(value),
  }
}
