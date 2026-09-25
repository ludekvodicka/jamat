import type {
  RemoteControlTerminalDeliverFailureData,
  RemoteControlTerminalDeliverProof,
} from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

/**
 * What the verified delivery of `/compact` proved. `delivered` means the agent took the command,
 * shown by `proof`; it does not mean the compaction has finished. `refused` carries the stage and
 * reason `terminal.deliver` stopped at, so the status can name them.
 */
export type ContextCompactionDelivery =
  | { kind: 'delivered'; proof: RemoteControlTerminalDeliverProof }
  | {
    kind: 'refused'
    stage: RemoteControlTerminalDeliverFailureData['stage']
    reason: RemoteControlTerminalDeliverFailureData['reason']
    detail: string
  }
