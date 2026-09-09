import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  VersioningSettingsSaveResult,
  VersioningSettingsValue,
} from '../../shared/versioningSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { VersioningSettingsSection } from './versioningSettingsSection'

export class ServiceVersioningSettingsIpc extends ServiceIpcBase<
  typeof ServiceVersioningSettingsIpc.channelsConst
> {
  static readonly channelsConst = {
    'versioning:settings-get': true,
    'versioning:settings-save': true,
  } as const

  constructor(private readonly configStore: ConfigStore) {
    super()
  }

  initialize(): void {
    this.register(
      'versioning:settings-get',
      () => this.configStore.readSection(VersioningSettingsSection.spec),
    )
    this.register('versioning:settings-save', (_event, value) => this.save(value))
    this.assertComplete(ServiceVersioningSettingsIpc.channelsConst)
  }

  private save(value: VersioningSettingsValue): VersioningSettingsSaveResult {
    const saved = this.configStore.saveSection(VersioningSettingsSection.spec, value)
    if (saved.ok) return saved
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected versioning section save result: ${JSON.stringify(saved)}`)
  }
}
