import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type {
  SessionGroupDefinition,
  SessionGroupsSaveResult,
} from '../../shared/sessionsGroupsState'
import { SessionsGroupsState } from '../../shared/sessionsGroupsState'
import type { ClientStateStore } from '../clientState/clientStateStore'
import { SessionGroupsSection } from './sessionGroupsSection'

/** The sections of the sessions tree, which a person edits in the settings. */
export class SessionGroupsOperations {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly store: ClientStateStore,
    private readonly onChanged: () => void,
  ) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('sessionGroups.list', {
      kind: 'read',
      description: 'The sections of the sessions tree, in order.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.configStore.readSection(SessionGroupsSection.spec) }),
    })
    op('sessionGroups.save', {
      kind: 'write',
      description: 'Replace the sections; the assignments a removed section left behind are dropped.',
      input: z.strictObject({
        groups: z.array(RemoteControlZod.ownedObject<SessionGroupDefinition>(), { error: 'must be a list of sections' }),
      }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.groups)),
    })
  }

  /**
   * The event says the STORED list moved, so a refused write must not send one. The codes are the
   * two this section can produce: it declares no `damaged`, because a hand-edit that broke the list
   * reads as the defaults and the settings are the only way to repair it from inside the app.
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
