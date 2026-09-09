import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import { WorktreeSettings, type WorktreeSettingsValue } from '../../shared/worktreeSettings'

export class WorktreeSettingsSection {
  static readonly spec: ConfigSectionSpec<WorktreeSettingsValue> = {
    key: 'worktrees',
    coerce: (value, report) => WorktreeSettings.coerce(value, report),
    validate: (value) => WorktreeSettings.isValid(value)
      ? null
      : 'worktrees.node.pnpm.globalVirtualStore must be a boolean',
  }
}
