import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type { UiSettingsSaveResult, UiSettingsValue } from '../../shared/uiSettings'
import { UiSettingsSection } from './uiSettingsSection'

/**
 * The `ui` section: read it, write it, and say when it moved.
 *
 * Reading always answers a value. A file the store cannot read means the defaults here, not a
 * failure: a window has to draw text whatever state the config is in, and that nothing will be
 * written is what the save says, once there is something to write.
 */
export class UiSettingsOperations {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly onChanged: () => void,
  ) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('uiSettings.get', {
      kind: 'read',
      description: 'The font scales, terminal theme and scroll speeds of every window.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.configStore.readSection(UiSettingsSection.spec) }),
    })
    op('uiSettings.save', {
      kind: 'write',
      description: 'Replace the ui section; the section refuses a value it cannot store, naming the field.',
      input: z.strictObject({ value: RemoteControlZod.ownedObject<UiSettingsValue>() }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.value)),
    })
  }

  /**
   * The event says the STORED value moved, so a refused write must not send one: every window would
   * read the file back and find exactly what it already holds. `UiSettingsSection` declares no
   * `damaged`: an unusable `ui` key reads as the defaults and a save over it is the repair, so
   * `section-damaged` cannot arrive, and the day it could, this wire type would have to learn it first.
   */
  private save(value: UiSettingsValue): UiSettingsSaveResult {
    const saved = this.configStore.saveSection(UiSettingsSection.spec, value)
    if (saved.ok) {
      this.onChanged()
      return saved
    }
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected ui section save result: ${JSON.stringify(saved)}`)
  }
}
