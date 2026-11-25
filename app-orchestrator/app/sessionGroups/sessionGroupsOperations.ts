import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../../lib-orchestrator/clientApi/appOperationMap'
import type {
  SessionGroup,
  SessionGroupDefinition,
  SessionGroupsSaveResult,
} from '../../../lib-orchestrator/clientApi/sessionsGroupsState'
import { AutomationStates } from '../../../lib-orchestrator/sessionManager/automationStates'
import type { ShellSessionGroups } from '../../../lib-orchestrator/shared/shellPort.types'
import { SessionGroupsSection } from './sessionGroupsSection'

/** The sections of the sessions tree, which a person edits in the settings. */
export class SessionGroupsOperations {
  private readonly configStore: ConfigStore
  private readonly store: ShellSessionGroups
  private readonly onChanged: () => void

  constructor(
    configStore: ConfigStore,
    store: ShellSessionGroups,
    onChanged: () => void,
  ) { this.configStore = configStore; this.store = store; this.onChanged = onChanged }

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
      run: async (body) => RemoteControlOutcome.of(await this.save(body.groups)),
    })
  }

  /**
   * Transition (dormant register): the startup cleanup's half of the list. It saves only when the
   * stored list still holds one of the four former bot sections, so a computer on the defaults gets
   * no `sessionGroups` key written, and every other section stays where the person put it.
   */
  async removeReserved(): Promise<{ ok: true; removed: number } | Extract<SessionGroupsSaveResult, { ok: false }>> {
    const current = this.configStore.readSection(SessionGroupsSection.spec)
    const kept = current.filter((group) => !AutomationStates.isFormerSectionId(group.id))
    if (kept.length === current.length) return { ok: true, removed: 0 }
    const saved = await this.save(kept)
    return saved.ok ? { ok: true, removed: current.length - kept.length } : saved
  }

  sectionIds(): readonly SessionGroup[] {
    return this.configStore.readSection(SessionGroupsSection.spec).map((group) => group.id)
  }

  /**
   * The event says the STORED list moved, so a refused write must not send one. The codes are the
   * two this section can produce: it declares no `damaged`, because a hand-edit that broke the list
   * reads as the defaults and the settings are the only way to repair it from inside the app.
   */
  private async save(groups: readonly SessionGroupDefinition[]): Promise<SessionGroupsSaveResult> {
    const saved = this.configStore.saveSection(SessionGroupsSection.spec, groups)
    if (!saved.ok) {
      if (saved.code === 'config-latched' || saved.code === 'invalid-section')
        return { ok: false, code: saved.code, detail: saved.detail }
      throw new Error(`Unexpected session groups save result: ${JSON.stringify(saved)}`)
    }
    await this.pruneAssignments(groups)
    this.onChanged()
    return saved
  }

  /**
   * A refused prune is not a refused save: the list IS stored, and a client state that is not
   * accepting writes leaves keys the tree drops as it reads them. Nothing is reported twice.
   */
  private async pruneAssignments(groups: readonly SessionGroupDefinition[]): Promise<void> {
    await this.store.assign({ kind: 'prune', groupIds: groups.map(group => group.id) })
  }
}
