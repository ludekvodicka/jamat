import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessMessage } from '../../lib-orchestrator/shared/processWire.types'
import type { PeerAuthority } from '../../lib-orchestrator/remoteControl/peerProcess.types'
import type { RemoteControlRequest } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'

export class SmokeForwardTrace {
  static sent(message: ProcessMessage, stateDirectory: string): void {
    if (message.type !== 'call' || message.target !== 'peer-work' || message.method !== 'execute') return
    const [authority, request] = message.args as [PeerAuthority, RemoteControlRequest]
    appendFileSync(join(stateDirectory, 'latency-forward.jsonl'), `${JSON.stringify({ kind: 'forward', pid: process.pid,
      connectionId: authority.connectionId, requestId: request.requestId, operation: request.operation,
      at: Number(process.hrtime.bigint()) / 1e6 })}\n`)
  }
}
