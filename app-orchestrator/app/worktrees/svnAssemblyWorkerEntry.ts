import { parentPort } from 'node:worker_threads'

import { SvnAssemblyReader } from '../../../lib-orchestrator/svn/svnAssembly'
import { SvnInvoker } from '../../../lib-orchestrator/svn/svnInvoker'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import type { SvnAssemblyWorkerRequest, SvnAssemblyWorkerResponse } from './svnAssemblyWorker.types'

/**
 * An assembly read runs only svn reads (`info`, `status`, `proplist`, `export`), which the worktree
 * command runner hands straight to its `SvnInvoker` without a lease, so a plain invoker here runs
 * the same commands.
 */
export class SvnAssemblyWorkerEntry {
  static run(): void {
    const port = parentPort
    if (port === null) throw new Error('The svn assembly worker has no parent port')
    const post = (response: SvnAssemblyWorkerResponse): void => port.postMessage(response)
    const reader = new SvnAssemblyReader(new SvnInvoker())
    port.on('message', (request: SvnAssemblyWorkerRequest) => {
      if (request.kind !== 'read') throw new Error(`Unknown svn assembly worker request: ${JSON.stringify(request)}`)
      const { requestId } = request
      reader.read(request.root, request.freshness, (mount, files) => post({ kind: 'progress', requestId, mount, files }))
        .then((assembly) => post({ kind: 'result', requestId, assembly }),
          (error: unknown) => post({ kind: 'failed', requestId, detail: ErrorText.of(error) }))
    })
    post({ kind: 'ready' })
  }
}

SvnAssemblyWorkerEntry.run()
