import { randomUUID } from 'node:crypto'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteSessionStatePage, RemoteSessionStateRequest, RemoteSessionSummary } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

export class RemoteSessionSnapshots {
  private readonly read: () => SessionsSnapshot
  private readonly reviews?: () => { revision: number; pending: readonly string[]; results: readonly string[] }
  private discoveryRevision = 0
  private discoveryKey = ''
  private readonly epoch = randomUUID()

  constructor(read: () => SessionsSnapshot, reviews?: RemoteSessionSnapshots['reviews']) {
    this.read = read
    this.reviews = reviews
  }

  page(request: RemoteSessionStateRequest): RemoteControlStepResult<RemoteSessionStatePage> {
    const source = this.read()
    const reviews = this.reviews?.()
    const key = JSON.stringify([source.revision, reviews?.revision, reviews?.pending, reviews?.results])
    if (key !== this.discoveryKey) { this.discoveryKey = key; this.discoveryRevision++ }
    const snapshot = reviews ? { ...source, revision: this.discoveryRevision } : source
    if (request.expected !== null
      && (request.expected.epoch !== this.epoch || request.expected.revision !== snapshot.revision))
      return { ok: false, error: { code: 'conflict', detail: 'Remote session state changed; restart discovery.' } }
    const cursor = { epoch: this.epoch, revision: snapshot.revision, offset: request.offset }
    if (request.kind === 'detail') {
      const session = snapshot.sessions.find((row) => row.sessionId === request.sessionId)
      if (!session) return { ok: false, error: { code: 'not-found', detail: 'Remote session no longer exists.' } }
      const bytes = Buffer.from(JSON.stringify(session), 'utf8')
      if (request.offset >= bytes.length) return RemoteSessionSnapshots.badOffset()
      const end = Math.min(bytes.length, request.offset + RemoteSessionSchemas.chunkBytes)
      return { ok: true, value: { ...cursor, kind: 'detail', sessionId: request.sessionId,
        sourceRevision: source.revision, totalBytes: bytes.length, base64: bytes.subarray(request.offset, end).toString('base64'),
        next: end < bytes.length ? end : null } }
    } else if (request.kind === 'sessions' || request.kind === 'categories') {
      const rows = request.kind === 'sessions'
        ? snapshot.sessions.map((session) => {
          const summary = RemoteSessionSnapshots.summary(session)
          return { ...summary, reviewPending: reviews?.pending.includes(session.sessionId) === true,
            pending: summary.pending || reviews?.pending.includes(session.sessionId) === true,
            hasResult: summary.hasResult || reviews?.results.includes(session.sessionId) === true }
        }).filter((row) => row.life !== 'ended' || row.pending || row.hasResult)
        : snapshot.categories
      if (request.offset > rows.length) return RemoteSessionSnapshots.badOffset()
      const value: RemoteSessionStatePage = { ...cursor, kind: request.kind, next: null,
        snapshot: { revision: snapshot.revision, reconciled: snapshot.reconciled, host: snapshot.host,
          sessions: [], categories: [], orphans: [] } }
      let end = request.offset
      for (; end < rows.length; end++) {
        const row = rows[end]!
        if (request.kind === 'sessions') value.snapshot.sessions.push(row as RemoteSessionSummary)
        else if (request.kind === 'categories') value.snapshot.categories.push(row as SessionsSnapshot['categories'][number])
        else throw new Error(`Unknown discovery kind: ${JSON.stringify(request)}`)
        value.next = end + 1 < rows.length ? end + 1 : null
        if (Buffer.byteLength(JSON.stringify({ type: 'session-state-response', response: { requestId: request.requestId, result: { ok: true, value } } }), 'utf8') > RemoteSessionSchemas.maximumPageBytes) {
          if (request.kind === 'sessions') value.snapshot.sessions.pop()
          else if (request.kind === 'categories') value.snapshot.categories.pop()
          else throw new Error(`Unknown discovery kind: ${JSON.stringify(request)}`)
          if (end === request.offset)
            return { ok: false, error: { code: 'operation-failed', detail: 'One remote session summary exceeds the page limit.' } }
          break
        }
      }
      value.next = end < rows.length ? end : null
      return { ok: true, value }
    } else throw new Error(`Unknown discovery kind: ${JSON.stringify(request)}`)
  }

  private static summary(session: SessionInfo): RemoteSessionSummary {
    const { sessionId, kind, title, titleParts, tabTitle, directory, project, life, activity, admits } = session
    return {
      sessionId, kind, title, titleParts, tabTitle, directory, project, life, activity, admits,
      parent: session.parent, script: session.script, agent: session.agent, color: session.color,
      activityDetail: session.activityDetail, compacting: session.compacting, completed: session.completed,
      endedAt: session.endedAt, exitCode: session.exitCode, outcome: session.outcome,
      pending: session.workflow?.open === true || session.actions?.sections.some((section) => section.open) === true
        || session.worktree?.cleanup?.phase === 'pending' || session.retiredWorktree?.landing !== undefined,
      hasResult: session.retiredWorktree !== undefined || session.worktree?.outcome !== undefined
        || session.actions?.sections.some((section) => !section.open && (section.revisions?.length ?? 0) > 0) === true,
      ...(session.worktree === undefined ? {} : { worktree: {
        worktreePath: session.worktree.worktreePath, cwdSubpath: session.worktree.cwdSubpath,
        branch: session.worktree.branch, baseCommit: session.worktree.baseCommit, kind: session.worktree.kind,
        choices: session.worktree.choices, diff: session.worktree.diff, baseMoved: session.worktree.baseMoved,
        liveFinish: session.worktree.liveFinish,
      } }),
    }
  }

  private static badOffset(): RemoteControlStepResult<never> {
    return { ok: false, error: { code: 'invalid-request', detail: 'Remote session page offset is out of range.' } }
  }
}
