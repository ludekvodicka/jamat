import type { ConfigSectionSpec } from '../../../lib-orchestrator/configStore/configStore.types'
import {
  RemoteControlSettings,
  type RemoteControlSettingsValue,
} from '../../shared/remoteControlSettings'

export class RemoteControlSettingsSection {
  static readonly spec: ConfigSectionSpec<RemoteControlSettingsValue> = {
    key: 'remoteControl',
    coerce: (value, report) => RemoteControlSettings.coerce(value, report),
    damaged: (value) => RemoteControlSettings.isDamaged(value),
    validate: (value) => RemoteControlSettings.isValid(value)
      ? null
      : 'remoteControl must hold a valid listener and unique pinned peer profiles',
  }
}
