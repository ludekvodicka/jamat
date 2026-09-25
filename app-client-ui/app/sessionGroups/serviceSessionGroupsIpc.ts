import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  SessionGroupDefinition,
  SessionGroupsSaveResult,
} from '../../shared/sessionsGroupsState'
import { SessionsGroupsState } from '../../shared/sessionsGroupsState'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { SessionGroupsSection } from './sessionGroupsSection'

/**
 * The `sessionGroups` section's share of the named allowlist: read the sections of the tree, write
 * them, and drop the assignments a removed one left behind.
 *
 * That last part is why this is not the two-line service the `ui` section has. The list lives in
 * `config.json` and the assignments in the client state, so a group removed here leaves keys naming
 * a section nobody can see. They are dropped in the same call that removes it, before the event, so
 * no window reads a tree between the two writes and finds a session filed nowhere. The tree prunes
 * what it reads as well, because the file can be written by a window that is not this build.
 */
export class ServiceSessionGroupsIpc extends ServiceIpcBase<typeof ServiceSessionGroupsIpc.channelsConst> {
  static readonly channelsConst = {
    'session-groups:get': true,
    'session-groups:save': true,
  } as const

  constructor(
    private readonly configStore: ConfigStore,
    private readonly store: ClientStateStore,
    private readonly onChanged: () => void,
  ) {
    super()
  }

  initialize(): void {
    this.register('session-groups:get', () =>
      this.configStore.readSection(SessionGroupsSection.spec))
    this.register('session-groups:save', (_event, groups) => this.save(groups))
    this.assertComplete(ServiceSessionGroupsIpc.channelsConst)
  }

  /**
   * The event says the STORED list moved, so a refused write must not send one. The codes are the
   * two this section can produce: it declares no `damaged`, because a hand-edit that broke the list
   * reads as the defaults and this tab is the only way to repair it from inside the app.
   */
  private save(groups: readonly SessionGroupDefinition[]): SessionGroupsSaveResult {
    const saved = this.configStore.saveSection(SessionGroupsSection.spec, groups)
    if (!saved.ok) {
      if (saved.code === 'config-latched' || saved.code === 'invalid-section')
        return { ok: false, code: saved.code, detail: saved.detail }
      throw new Error(`Unexpected session groups save result: ${JSON.stringify(saved)}`)
    }
    this.pruneAssignments(groups)
    this.onChanged()
    return saved
  }

  /**
   * A refused prune is not a refused save: the list IS stored, and a client state that is not
   * accepting writes leaves keys the tree drops as it reads them. Nothing is reported twice.
   */
  private pruneAssignments(groups: readonly SessionGroupDefinition[]): void {
    const assignments = this.store.loadSessionGroups()
    const kept = SessionsGroupsState.pruned(assignments, groups)
    if (kept.length !== assignments.length)
      this.store.saveSessionGroups(kept)
  }
}
