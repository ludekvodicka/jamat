import { z } from 'zod'

import type { ConfigStore } from '../../../lib-orchestrator/configStore/configStore'
import { RemoteControlOutcome } from '../../../lib-orchestrator/remoteControl/remoteControlOutcome'
import type { RemoteControlRegistry } from '../../../lib-orchestrator/remoteControl/remoteControlRegistry'
import { RemoteControlZod } from '../../../lib-orchestrator/remoteControl/remoteControlSchemas'
import type { AppOperationMap } from '../../shared/appOperationMap'
import {
  VersioningSettings,
  type VersioningSettingsField,
  type VersioningSettingsSaveResult,
  type VersioningSettingsValue,
} from '../../shared/versioningSettings'
import { VersioningSettingsSection } from './versioningSettingsSection'

/** The versioning section: the mode, the diff tool and how the commit review behaves. */
export class VersioningSettingsOperations {
  /** Every field a save may name; a save writes only the keys of that one field. */
  static readonly fieldsConst = [
    'mode', 'diffTool', 'activateSessionOnCommit', 'returnToPreviousSessionAfterCommit',
    'returnToPreviousSessionWithinMinutes', 'closeCommitOnSuccess', 'commitReview', 'commitSplitRatio',
  ] as const satisfies readonly VersioningSettingsField[]

  constructor(private readonly configStore: ConfigStore) {}

  register(registry: Pick<RemoteControlRegistry, 'registrar'>): void {
    const op = registry.registrar<AppOperationMap>()
    op('versioningSettings.get', {
      kind: 'read',
      description: 'The versioning section: mode, diff tool and the commit review options.',
      input: z.strictObject({}),
      run: async () => ({ ok: true, value: this.configStore.readSection(VersioningSettingsSection.spec) }),
    })
    op('versioningSettings.save', {
      kind: 'write',
      description: 'Save one field of the versioning section from `value` (default `mode`), leaving the others as stored.',
      input: z.strictObject({
        value: RemoteControlZod.ownedObject<VersioningSettingsValue>(),
        field: z.enum(VersioningSettingsOperations.fieldsConst, { error: 'Unknown versioning setting' }).optional(),
      }),
      run: async (body) => RemoteControlOutcome.of(this.save(body.value, body.field)),
    })
  }

  private save(value: VersioningSettingsValue, field: VersioningSettingsField = 'mode'): VersioningSettingsSaveResult {
    const current = this.configStore.readSection(VersioningSettingsSection.spec)
    const saved = this.configStore.saveSection(VersioningSettingsSection.spec, { ...current,
      ...Object.fromEntries(VersioningSettings.fieldsOf(field).map((key) => [key, value[key]])) })
    if (saved.ok) return saved
    else if (saved.code === 'config-latched' || saved.code === 'invalid-section')
      return { ok: false, code: saved.code, detail: saved.detail }
    else
      throw new Error(`Unexpected versioning section save result: ${JSON.stringify(saved)}`)
  }
}
