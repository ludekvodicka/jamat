import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  KeyboardSettingsSaveResult,
  KeyboardSettingsValue,
} from '../../shared/keyboardSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { KeyboardSettingsSection } from './keyboardSettingsSection'

/**
 * The `keyboard` section's share of the named allowlist: read it, write it, and say when it moved.
 *
 * Reading always answers a value. A file the store cannot read means the default here, not a
 * failure: the menu has to carry a key whatever state the config is in, and that nothing will be
 * written is what the save says, once there is something to write.
 */
export class ServiceKeyboardSettingsIpc
  extends ServiceIpcBase<typeof ServiceKeyboardSettingsIpc.channelsConst> {
  static readonly channelsConst = {
    'keyboard:settings-get': true,
    'keyboard:settings-save': true,
  } as const

  constructor(
    private readonly configStore: ConfigStore,
    private readonly onChanged: () => void,
  ) {
    super()
  }

  initialize(): void {
    this.register(
      'keyboard:settings-get',
      () => this.configStore.readSection(KeyboardSettingsSection.spec),
    )
    this.register('keyboard:settings-save', (_event, value) => this.save(value))
    this.assertComplete(ServiceKeyboardSettingsIpc.channelsConst)
  }

  /**
   * The event says the STORED value moved, so a refused write must not send one: the menu would be
   * rebuilt to exactly what it already is. The refusal itself travels as it is; what is checked here
   * is that its code is one of the two this section can produce. The store also knows
   * `section-damaged`, and `KeyboardSettingsSection` deliberately declares no `damaged`: an unusable
   * `keyboard` key reads as the default and a save over it is the repair, not a loss.
   */
  private save(value: KeyboardSettingsValue): KeyboardSettingsSaveResult {
    const saved = this.configStore.saveSection(KeyboardSettingsSection.spec, value)
    if (saved.ok) {
      this.onChanged()
      return saved
    }
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected keyboard section save result: ${JSON.stringify(saved)}`)
  }
}
