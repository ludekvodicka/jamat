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
    this.register('versioning:settings-save', (_event, value, field) => this.save(value, field))
    this.assertComplete(ServiceVersioningSettingsIpc.channelsConst)
  }

  private save(value: VersioningSettingsValue, field: keyof VersioningSettingsValue = 'mode'): VersioningSettingsSaveResult {
    if (field !== 'mode' && field !== 'diffTool')
      return { ok: false, code: 'invalid-section', detail: 'Unknown versioning setting' }
    const current = this.configStore.readSection(VersioningSettingsSection.spec)
    const saved = this.configStore.saveSection(VersioningSettingsSection.spec, { ...current, [field]: value[field] })
    if (saved.ok) return saved
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected versioning section save result: ${JSON.stringify(saved)}`)
  }
}
