import { homedir } from 'node:os'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import { ProviderTranscriptView } from '../../../lib-orchestrator/projectManager/providerTranscriptView'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { ClaimCache } from '../../../lib-orchestrator/sessionUncommitted/claims/claimCache'
import { SessionUncommittedTracker } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommittedTracker'
import type {
  SessionUncommittedWorkerRequest,
  SessionUncommittedWorkerResponse,
  SessionUncommittedWorkerStart,
} from './sessionUncommittedWorker.types'

/**
 * The tracker answers one request at a time: a scan awaits its transcript reads, and a second scan
 * over the same sessions in between would read the same growth twice.
 */
export class SessionUncommittedWorkerEntry {
  static run(): void {
    const port = parentPort
    if (port === null) throw new Error('The session uncommitted worker has no parent port')
    const start = workerData as SessionUncommittedWorkerStart
    const post = (response: SessionUncommittedWorkerResponse): void => port.postMessage(response)
    const tracker = new SessionUncommittedTracker({
      // The process's own transcript view lives on the orchestrator main thread; this one is the
      // thread's, with the same default homes.
      transcripts: new ProviderTranscriptView(),
      appData: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      cache: new ClaimCache(start.cacheFile, Date.now),
      now: Date.now,
    })
    let queue: Promise<void> = Promise.resolve()
    port.on('message', (request: SessionUncommittedWorkerRequest) => {
      queue = queue.then(() => SessionUncommittedWorkerEntry.answer(tracker, request)
        .then(post, (error: unknown) => post({ kind: 'failed', requestId: request.requestId, detail: ErrorText.of(error) })))
    })
    post({ kind: 'ready' })
  }

  private static async answer(tracker: SessionUncommittedTracker, request: SessionUncommittedWorkerRequest): Promise<SessionUncommittedWorkerResponse> {
    switch (request.kind) {
      case 'scan':
        return { kind: 'result', requestId: request.requestId, sessions: await tracker.scan(request.sessions, request.roots) }
      case 'observeStatus':
        tracker.observeStatus(request.root, request.entries)
        return { kind: 'done', requestId: request.requestId }
      case 'claims': {
        const claims = await tracker.claims(request.sessionId)
        return claims === null
          ? { kind: 'claims', requestId: request.requestId, touched: null }
          : { kind: 'claims', requestId: request.requestId, touched: [...claims.touched], shellRuns: [...claims.shellRuns] }
      }
      case 'stop':
        await tracker.flush()
        return { kind: 'done', requestId: request.requestId }
      default:
        throw new Error(`Unknown session uncommitted worker request: ${JSON.stringify(request satisfies never)}`)
    }
  }
}

SessionUncommittedWorkerEntry.run()
