import type { RemoteControlError, RemoteControlErrorCode } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

export class RemoteRequestError extends Error {
  readonly code: RemoteControlErrorCode

  constructor(error: RemoteControlError) {
    super(error.detail)
    this.code = error.code
  }
}
