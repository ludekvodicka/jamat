import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../shared/appOperationMap'
import type {
  FileChangesSettingsSaveResult,
  FileChangesSettingsValue,
} from '../../shared/fileChangesSettings'
import { FileChangesSettingsSection } from './fileChangesSettingsSection'

/** Which VCS the file changes view prefers, and how it lists them. */
export class FileChangesSettingsOperations {
  constructor(private readonly configStore: ConfigStore) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('fileChangesSettings.get', {
      kind: 'read',
      description: 'The fileChanges section: the preferred VCS and the listing options.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.configStore.readSection(FileChangesSettingsSection.spec) }),
    })
    op('fileChangesSettings.save', {
      kind: 'write',
      description: 'Replace the fileChanges section; the section refuses a value it cannot store, naming the field.',
      input: z.strictObject({ value: RemoteControlZod.ownedObject<FileChangesSettingsValue>() }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.value)),
    })
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
