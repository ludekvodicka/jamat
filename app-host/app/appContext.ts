import { randomBytes, randomUUID } from 'node:crypto'

import type { AppConfig } from './appConfig.js'
import { BuildInfoSource } from './hostRuntime/buildInfo.js'
import { HostHealth } from './hostRuntime/hostHealth.js'
import { HostLog } from './hostRuntime/hostLog.js'
import { ProcessStartIdentity } from './shared/processStartIdentity.js'
import type { BuildInfo } from './wire/hostWire.js'

export class AppContext {
  readonly token = randomBytes(32).toString('hex')
  readonly hostInstanceId = randomUUID()
  readonly hostGeneration = randomUUID()
  readonly processStartedAt = ProcessStartIdentity.current()
  readonly health = new HostHealth()
  readonly buildInfo: BuildInfo = BuildInfoSource.current()
  private readonly hostLog: HostLog

  constructor(readonly config: AppConfig) {
    this.hostLog = new HostLog(
      config.identity.configIdentity,
      config.runtimeChannel,
    )
  }

  /** Redacts once for both sinks, so a token cannot reach the file through the console path. */
  log(message: string): void {
    const redacted = HostLog.redact(message)
    const level = redacted.startsWith('ERROR')
      ? 'error'
      : redacted.startsWith('WARN')
        ? 'warn'
        : 'info'
    this.hostLog.write(level, redacted)
    console.log(`[app-host] ${redacted}`)
  }
}
