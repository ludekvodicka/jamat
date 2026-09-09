import type { RemoteControlError } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

export class AppClientCliError extends Error {
  constructor(
    readonly code: RemoteControlError['code'],
    detail: string,
  ) {
    super(detail)
  }
}
