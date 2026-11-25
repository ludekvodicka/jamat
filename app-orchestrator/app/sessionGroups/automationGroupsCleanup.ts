import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type { ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import { AutomationStates } from '../../../lib-orchestrator/sessionManager/automationStates'
import type { SessionGroup } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionGroupsOperations } from './sessionGroupsOperations'

export type AutomationGroupsCleanupResult =
  | { ok: true; removedSections: number; prunedAssignments: number }
  | { ok: false; detail: string }

export interface AutomationGroupsCleanupDeps {
  assignments: Pick<ShellSessionGroups, 'assignments' | 'assign'>
  sections: Pick<SessionGroupsOperations, 'removeReserved' | 'sectionIds'>
  log(message: string): void
  report(message: string): void
}

/**
 * Transition (dormant register): the four former bot sections (`automation`, `waiting`, `blocked`,
 * `completed`) leave a stored list and the client state on every start. A session filed under one
 * goes back to its project with no chip; a bot sets its chip at its next report. Nothing is written
 * when there is nothing to remove, so a second start changes nothing. A failure leaves everything
 * where it was, and the next start tries again.
 */
export class AutomationGroupsCleanup {
  private readonly deps: AutomationGroupsCleanupDeps

  constructor(deps: AutomationGroupsCleanupDeps) { this.deps = deps }

  async start(): Promise<void> {
    try {
      const result = await this.run()
      if (!result.ok)
        this.deps.report(`Automation groups cleanup stopped, the next start tries again: ${result.detail}`)
      else if (result.removedSections > 0 || result.prunedAssignments > 0)
        this.deps.log(`automation groups cleanup: removed ${result.removedSections} stored sections, `
          + `pruned ${result.prunedAssignments} assignments`)
    } catch (error) {
      this.deps.report(`Automation groups cleanup failed, the next start tries again: ${ErrorText.of(error)}`)
    }
  }

  async run(): Promise<AutomationGroupsCleanupResult> {
    const legacyBefore = this.legacyCount()
    const removed = await this.deps.sections.removeReserved()
    if (!removed.ok) return { ok: false, detail: removed.detail }
    // A save already prunes to the new list, but it ignores a refused prune; this one does not.
    if (this.legacyCount() > 0) {
      const held = this.deps.assignments.assignments().map(({ group }) => group)
      const groupIds = new Set<SessionGroup>([
        ...this.deps.sections.sectionIds(),
        ...held.filter((group) => !AutomationStates.isFormerSectionId(group)),
      ])
      const pruned = await this.deps.assignments.assign({ kind: 'prune', groupIds: [...groupIds] })
      if (!pruned.ok) return { ok: false, detail: 'the client state did not accept the removal of the former bot section assignments' }
    }
    return { ok: true, removedSections: removed.removed, prunedAssignments: legacyBefore - this.legacyCount() }
  }

  private legacyCount(): number {
    return this.deps.assignments.assignments().filter(({ group }) => AutomationStates.isFormerSectionId(group)).length
  }
}
