import type { RemoteControlOperation, RemoteControlRequestBody } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

export class RemoteSessionCommandsContract {
  static readonly operations = ['sessions.restart', 'sessions.reopen', 'sessions.fork', 'sessions.remove',
    'sessions.setDetails', 'sessions.color', 'sessions.group', 'sessions.setNote'] as const satisfies readonly RemoteControlOperation[]
}

export type RemoteSessionCommandOperation = typeof RemoteSessionCommandsContract.operations[number]
export type RemoteSessionCommand = { [K in RemoteSessionCommandOperation]: {
  operation: K; operationId: string; body: RemoteControlRequestBody<K>
} }[RemoteSessionCommandOperation]
