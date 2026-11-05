import { writeSync } from 'node:fs'
import type { DebugSectionId } from '../../shared/debugSections.types'
import { ServiceIpcBase } from '../shared/serviceIpcBase'

export interface ServiceDebugIpcDeps {
  sectionActive: (callerId: string, section: DebugSectionId | null) => void
  smoke?: boolean
  block?: (request: { target: 'orchestrator'; id: string; milliseconds: 3000 | 20000 }) => Promise<void>
}

/**
 * The Debug tab's report of what is on screen. Its two reads of the Host are the control API's
 * `host.status` and `host.ping`; this one stays a channel because it describes the sending renderer.
 */
export class ServiceDebugIpc extends ServiceIpcBase<typeof ServiceDebugIpc.channelsConst> {
  static readonly channelsConst = {
    'debug:section-active': true,
    'debug:block-loop': true,
  } as const

  private readonly deps: ServiceDebugIpcDeps

  constructor(deps: ServiceDebugIpcDeps) {
    super()
    this.deps = deps
  }

  initialize(): void {
    this.register('debug:section-active', (caller, section) => this.deps.sectionActive(caller.id, section))
    this.register('debug:block-loop', (_event, request) => {
      if (this.deps.smoke !== true) throw new Error('debug.blockLoop requires --smoke')
      if (!request || (request.target !== 'orchestrator' && request.target !== 'main') || typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(request.id)
        || (request.milliseconds !== 3_000 && request.milliseconds !== 20_000) || (request.target === 'main' && request.milliseconds !== 3_000))
        throw new Error('Invalid smoke block request')
      switch (request.target) {
        case 'orchestrator':
          if (!this.deps.block) throw new Error('Orchestrator smoke block is not configured')
          return this.deps.block(request)
        case 'main': {
          const boundary = (phase: 'start' | 'end'): void => { writeSync(1, '[latency-smoke] ' + JSON.stringify({ kind: 'block', phase,
            id: request.id, target: request.target, process: 'main', pid: process.pid, milliseconds: request.milliseconds,
            at: Number(process.hrtime.bigint()) / 1e6 }) + '\n') }
          boundary('start')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, request.milliseconds)
          boundary('end')
          return
        }
        default: throw new Error('Unknown smoke block target')
      }
    })
    this.assertComplete(ServiceDebugIpc.channelsConst)
  }
}
