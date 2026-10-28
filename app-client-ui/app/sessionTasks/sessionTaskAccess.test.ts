import { describe, expect, it, vi } from 'vitest'
import type { RemoteTaskRequest } from '../../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import type { SessionTasksOperations } from './sessionTasksOperations'
import type { RemoteSessionInteraction } from '../remoteControl/remoteSessionViews'
import { SessionTaskAccess } from './sessionTaskAccess'

const view: RemoteSessionInteraction = { peerId: 'peer', epoch: 'epoch', sessionId: 'parent', viewId: 'view', viewerId: 'viewer' }
function readers() {
  return {
    scriptsOf: vi.fn(() => null),
    listingOf: vi.fn(async () => ({ kind: 'none' as const, code: 'native-session-id-pending' as const, reason: 'Native identity is not ready' })),
    transcriptOf: vi.fn(async () => ({ kind: 'none' as const, code: 'native-session-id-pending' as const, reason: 'Native identity is not ready' })),
    shellOutputOf: vi.fn(async () => ({ kind: 'none' as const, code: 'unknown-task' as const, reason: 'This parent has no such shell' })),
    scriptOutputOf: vi.fn(async (_sessionId: string, runId: string) => runId === 'retained-run'
      ? { ok: true as const, value: { state: 'succeeded' as const, source: 'log' as const, lines: ['界'.repeat(200_000)], terminal: null, endedAt: 10 } }
      : { ok: false as const, error: { code: 'not-found' as const, detail: 'Run is not owned by this parent' } }),
  }
}
async function read(access: SessionTaskAccess, request: RemoteTaskRequest) {
  const first = await access.request(view, request)
  if (!first.ok) throw new Error(first.error.detail)
  let page = first.value
  const chunks: Buffer[] = []
  for (;;) {
    const bytes = Buffer.from(page.base64, 'base64')
    expect(bytes.length).toBeLessThanOrEqual(64 * 1024)
    chunks.push(bytes)
    const offset = page.offset + bytes.length
    if (offset === page.totalBytes) break
    const next = access.page(view, request, { transferId: page.transferId, version: page.version, offset })
    if (!next.ok) throw new Error(next.error.detail)
    page = next.value
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

describe('SessionTaskAccess', () => {
  it('uses source identity readers and refuses a foreign retained run', async () => {
    const tasks = readers(), access = new SessionTaskAccess(tasks)
    const transcript = await read(access, { kind: 'transcript', subagentId: 'child', known: 'old-version' })
    expect(tasks.transcriptOf).toHaveBeenCalledWith('parent', 'child', 'old-version')
    expect(transcript.result.value.code).toBe('native-session-id-pending')
    expect((await read(access, { kind: 'script', runId: 'foreign-run' })).result).toMatchObject({ ok: false, error: { code: 'not-found' } })
    expect((await read(access, { kind: 'shell', shellId: 'foreign-shell' })).result.value.code).toBe('unknown-task')
  })

  it('pages retained output, marks truncation visibly and binds cursors to peer, session, run and version', async () => {
    const tasks = readers(), access = new SessionTaskAccess(tasks), request = { kind: 'script', runId: 'retained-run' } as const
    const first = await access.request(view, request)
    if (!first.ok) throw new Error(first.error.detail)
    const cursor = { transferId: first.value.transferId, version: first.value.version, offset: 65536 }
    expect(access.page({ ...view, peerId: 'foreign' }, request, cursor).ok).toBe(false)
    expect(access.page({ ...view, sessionId: 'foreign' }, request, cursor).ok).toBe(false)
    expect(access.page(view, { ...request, runId: 'foreign' }, cursor).ok).toBe(false)
    expect(access.page(view, request, { ...cursor, version: 'wrong' }).ok).toBe(false)
    const answer = await read(access, request)
    expect(answer).toMatchObject({ sessionId: 'parent', request, result: { ok: true, value: { state: 'succeeded', source: 'log', endedAt: 10,
      logReason: 'Earlier output omitted from this source snapshot.' } } })
    expect(answer.result.value.lines.join('\n')).toHaveLength(65536)
    access.release(view)
    expect(access.page(view, request, cursor).ok).toBe(false)
  })

  it('bounds oversized transcript tails without turning the session into a disconnection', async () => {
    const tasks = readers()
    const transcript = { kind: 'transcript' as const, revision: 'version', header: { agentType: 'worker', description: '', model: null, state: 'done' as const, contextTokens: null },
      entries: Array.from({ length: 1000 }, () => ({ kind: 'message' as const, role: 'assistant' as const, text: '界'.repeat(4000), truncated: false, at: null })), earlierStepsOmitted: false }
    const access = new SessionTaskAccess({ ...tasks, transcriptOf: async () => transcript })
    const answer = await read(access, { kind: 'transcript', subagentId: 'child' })
    expect(answer.result.value.entries.length).toBeGreaterThan(0)
    expect(answer.result.value.entries.length).toBeLessThan(1000)
    expect(answer.result.value.earlierStepsOmitted).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThan(600 * 1024)
  })

  it('discards an in-flight read after view release without cancelling source work', async () => {
    let finish!: (value: Awaited<ReturnType<SessionTasksOperations['listingOf']>>) => void
    const tasks = { ...readers(), listingOf: () => new Promise<Awaited<ReturnType<SessionTasksOperations['listingOf']>>>((resolve) => { finish = resolve }) }
    const access = new SessionTaskAccess(tasks)
    const pending = access.request(view, { kind: 'list' })
    access.release(view)
    finish({ kind: 'tasks', rows: [], catchingUp: false, olderFinished: 0 })
    expect(await pending).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  })
})
