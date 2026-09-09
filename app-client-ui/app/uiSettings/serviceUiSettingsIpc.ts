import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type { UiSettingsSaveResult, UiSettingsValue } from '../../shared/uiSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { UiSettingsSection } from './uiSettingsSection'

/**
 * The `ui` section's share of the named allowlist: read it, write it, and say when it moved.
 *
 * Reading always answers a value. A file the store cannot read means the defaults here, not a
 * failure: a window has to draw text whatever state the config is in, and that nothing will be
 * written is what the save says, once there is something to write.
 */
export class ServiceUiSettingsIpc extends ServiceIpcBase<typeof ServiceUiSettingsIpc.channelsConst> {
  static readonly channelsConst = {
    'ui:settings-get': true,
    'ui:settings-save': true,
  } as const

  constructor(
    private readonly configStore: ConfigStore,
    private readonly onChanged: () => void,
  ) {
    super()
  }

  initialize(): void {
    this.register('ui:settings-get', () => this.configStore.readSection(UiSettingsSection.spec))
    this.register('ui:settings-save', (_event, value) => this.save(value))
    this.assertComplete(ServiceUiSettingsIpc.channelsConst)
  }

  /**
   * The event says the STORED value moved, so a refused write must not send one: every window would
   * read the file back and find exactly what it already holds. The refusal itself travels as it is;
   * what is checked here is that its code is one of the two this section can produce. The store also
   * knows `section-damaged`, and `UiSettingsSection` deliberately declares no `damaged`: an unusable
   * `ui` key reads as the defaults and a save over it is the repair, not a loss. So that code cannot
   * arrive, and the day it could, this wire type would have to learn the word first.
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
