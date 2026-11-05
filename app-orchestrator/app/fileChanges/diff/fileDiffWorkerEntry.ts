import { parentPort } from 'node:worker_threads'

import { FileDiffComputer } from '../../../../lib-orchestrator/fileChangesManager/diff/fileDiffComputer'
import type {
  FileDiffWorkerRequest,
  FileDiffWorkerResponse,
} from './fileDiffWorker.types'

export class FileDiffWorkerEntry {
  static run(): void {
    const port = parentPort
    if (port === null) throw new Error('The file diff worker has no parent port')
    port.on('message', (request: FileDiffWorkerRequest) => {
      if (request.kind === 'compute') {
        const response: FileDiffWorkerResponse = {
          kind: 'result',
          requestId: request.requestId,
          result: FileDiffComputer.compute(request),
        }
        port.postMessage(response)
      }
      else
        throw new Error(`Unknown file diff worker request: ${JSON.stringify(request)}`)
    })
    port.postMessage({ kind: 'ready' } satisfies FileDiffWorkerResponse)
  }
}

FileDiffWorkerEntry.run()
