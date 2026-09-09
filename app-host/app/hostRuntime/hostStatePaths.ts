import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeChannel } from '../wire/hostWire.js'

/**
 * Machine-local paths for one Host. The root is `jamat-v3`, deliberately separate from V2's `jamat`:
 * a V3 Host must never contend for a V2 Host's lock or overwrite its descriptor, even when both are
 * pointed at the same config directory.
 */
export class HostStatePaths {
  private static readonly rootNameConst = 'jamat-v3'

  static machineRoot(): string {
    const override = process.env.JAMAT_V3_LOCAL_STATE_DIR
    if (override) return override
    if (process.platform === 'win32')
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
        HostStatePaths.rootNameConst,
      )
    else if (process.platform === 'darwin')
      return join(homedir(), 'Library', 'Application Support', HostStatePaths.rootNameConst)
    else if (process.platform === 'linux')
      return join(
        process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
        HostStatePaths.rootNameConst,
      )
    else
      throw new Error(`Unsupported platform: ${process.platform}`)
  }

  // An override names the scope ROOT, never one channel's directory: consuming it verbatim collapses
  // two channels into one state directory, so the second Host cannot take its own lock.
  static directory(configIdentity: string, channel: RuntimeChannel): string {
    const scopeRoot = process.env.JAMAT_V3_HOST_STATE_DIR
      ?? join(HostStatePaths.machineRoot(), 'host')
    return join(scopeRoot, configIdentity, channel)
  }

  static descriptor(configIdentity: string, channel: RuntimeChannel): string {
    return join(HostStatePaths.directory(configIdentity, channel), 'descriptor.json')
  }

  static lock(configIdentity: string, channel: RuntimeChannel): string {
    return join(HostStatePaths.directory(configIdentity, channel), 'host.lock')
  }

  static registry(configIdentity: string, channel: RuntimeChannel): string {
    return join(HostStatePaths.directory(configIdentity, channel), 'host-state.json')
  }

  static log(configIdentity: string, channel: RuntimeChannel): string {
    return join(HostStatePaths.directory(configIdentity, channel), 'host.log.jsonl')
  }
}
