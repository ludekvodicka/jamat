import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import type {
  FileChangesSettingsSaveResult,
  FileChangesSettingsValue,
} from '../../shared/fileChangesSettings'
import { ServiceIpcBase } from '../shared/serviceIpcBase'
import { FileChangesSettingsSection } from './fileChangesSettingsSection'

export class ServiceFileChangesSettingsIpc extends ServiceIpcBase<
  typeof ServiceFileChangesSettingsIpc.channelsConst
> {
  static readonly channelsConst = {
    'fileChanges:settings-get': true,
    'fileChanges:settings-save': true,
  } as const

  constructor(private readonly configStore: ConfigStore) {
    super()
  }

  initialize(): void {
    this.register(
      'fileChanges:settings-get',
      () => this.configStore.readSection(FileChangesSettingsSection.spec),
    )
    this.register('fileChanges:settings-save', (_event, value) => this.save(value))
    this.assertComplete(ServiceFileChangesSettingsIpc.channelsConst)
  }

  private save(value: FileChangesSettingsValue): FileChangesSettingsSaveResult {
    const saved = this.configStore.saveSection(FileChangesSettingsSection.spec, value)
    if (saved.ok) return saved
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected fileChanges section save result: ${JSON.stringify(saved)}`)
  }
}
