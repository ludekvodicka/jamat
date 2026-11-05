import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { SvnAssembly } from '../../../lib-orchestrator/svn/svnAssembly'
import { SvnAssemblyWorker } from './svnAssemblyWorker'
import type { SvnAssemblyWorkerRequest, SvnAssemblyWorkerResponse, SvnAssemblyWorkerThread } from './svnAssemblyWorker.types'

class FakeSvnAssemblyThread extends EventEmitter implements SvnAssemblyWorkerThread {
  readonly performance: SvnAssemblyWorkerThread['performance']

  constructor() {
    super()
    this.performance = { eventLoopUtilization: () => ({ idle: 60, active: 40, utilization: 0.4 }) }
  }
  readonly sent: SvnAssemblyWorkerRequest[] = []
  terminations = 0

  override on(event: 'message', listener: (message: SvnAssemblyWorkerResponse) => void): this
  override on(event: 'error', listener: (error: Error) => void): this
  override on(event: 'exit', listener: (code: number) => void): this
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  postMessage(message: SvnAssemblyWorkerRequest): void {
    this.sent.push(message)
  }

  terminate(): Promise<number> {
    this.terminations += 1
    return Promise.resolve(0)
  }

  answer(message: SvnAssemblyWorkerResponse): void {
    this.emit('message', message)
  }
}

const assembly = (content: string): SvnAssembly => ({ format: 1, content, metadata: 'm', nodes: [], incoming: [] })

function workerUnderTest(): { worker: SvnAssemblyWorker; threads: FakeSvnAssemblyThread[] } {
  const threads: FakeSvnAssemblyThread[] = []
  const worker = new SvnAssemblyWorker('svnAssemblyWorker.js', () => {
    const thread = new FakeSvnAssemblyThread()
    threads.push(thread)
    return thread
  })
  return { worker, threads }
}

describe('app/worktrees/svnAssemblyWorker', () => {
  it('starts one thread lazily, sends concurrent reads once it is ready and relays their progress', async () => {
    const { worker, threads } = workerUnderTest()
    const progress: string[] = []
    const first = worker.read('Q:/a', false, (mount, files) => progress.push(`${mount}:${files}`))
    const second = worker.read('Q:/b', true)
    expect(threads).toHaveLength(1)
    expect(threads[0].sent).toEqual([])

    threads[0].answer({ kind: 'ready' })
    expect(threads[0].sent).toEqual([
      { kind: 'read', requestId: 1, root: 'Q:/a', freshness: false },
      { kind: 'read', requestId: 2, root: 'Q:/b', freshness: true },
    ])
    threads[0].answer({ kind: 'progress', requestId: 1, mount: 'shared/app', files: 128 })
    threads[0].answer({ kind: 'result', requestId: 2, assembly: assembly('b') })
    threads[0].answer({ kind: 'result', requestId: 1, assembly: assembly('a') })

    await expect(second).resolves.toEqual(assembly('b'))
    await expect(first).resolves.toEqual(assembly('a'))
    expect(progress).toEqual(['shared/app:128'])
    const third = worker.read('Q:/c', false)
    expect(threads).toHaveLength(1)
    expect(threads[0].sent.at(-1)).toEqual({ kind: 'read', requestId: 3, root: 'Q:/c', freshness: false })
    threads[0].answer({ kind: 'failed', requestId: 3, detail: 'SVN status failed' })
    await expect(third).rejects.toThrow('SVN status failed')
  })

  it('fails the reads a broken thread holds and starts a new thread for the next read', async () => {
    const { worker, threads } = workerUnderTest()
    const held = worker.read('Q:/a', false)
    threads[0].answer({ kind: 'ready' })
    threads[0].emit('exit', 3)

    await expect(held).rejects.toThrow('The svn assembly worker failed: exited with code 3')
    expect(threads[0].terminations).toBe(1)
    const next = worker.read('Q:/a', false)
    expect(threads).toHaveLength(2)
    threads[1].answer({ kind: 'ready' })
    threads[1].answer({ kind: 'result', requestId: 2, assembly: assembly('a') })
    await expect(next).resolves.toEqual(assembly('a'))
  })

  it('treats an answer to a request it never sent as a broken thread', async () => {
    const { worker, threads } = workerUnderTest()
    const held = worker.read('Q:/a', false)
    threads[0].answer({ kind: 'result', requestId: 1, assembly: assembly('a') })

    await expect(held).rejects.toThrow('answered an unknown request: 1')
  })

  it('stops for good: held reads fail, the thread ends and later reads are refused', async () => {
    const { worker, threads } = workerUnderTest()
    const held = worker.read('Q:/a', false)
    threads[0].answer({ kind: 'ready' })

    await worker.stop()

    await expect(held).rejects.toThrow('The svn assembly worker stopped')
    expect(threads[0].terminations).toBe(1)
    await expect(worker.read('Q:/a', false)).rejects.toThrow('stopping')
    expect(threads).toHaveLength(1)
  })
})
