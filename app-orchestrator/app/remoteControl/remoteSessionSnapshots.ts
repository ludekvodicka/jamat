import { randomUUID } from 'node:crypto'

import type { RemoteControlStepResult } from '../../../lib-orchestrator/remoteControl/remoteControlApi.types'
import type { RemoteSessionStatePage, RemoteSessionStateRequest, RemoteSessionSummary } from '../../../lib-orchestrator/remoteControl/remoteSessionApi.types'
import { RemoteSessionSchemas } from '../../../lib-orchestrator/remoteControl/remoteSessionSchemas'
import type { SessionInfo, SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { SessionUncommittedSnapshot } from '../../../lib-orchestrator/sessionUncommitted/sessionUncommitted.types'

export class RemoteSessionSnapshots {
  private readonly read: () => SessionsSnapshot
  private readonly reviews?: () => { revision: number; pending: readonly string[]; results: readonly string[] }
  private readonly uncommitted?: () => SessionUncommittedSnapshot
  private discoveryRevision = 0
  private discoveryKey = ''
  private readonly epoch = randomUUID()

  constructor(read: () => SessionsSnapshot, reviews?: RemoteSessionSnapshots['reviews'], uncommitted?: RemoteSessionSnapshots['uncommitted']) {
    this.read = read
    this.reviews = reviews
    this.uncommitted = uncommitted
  }

  page(request: RemoteSessionStateRequest, viewer: { processes: boolean } = { processes: true }): RemoteControlStepResult<RemoteSessionStatePage> {
    const source = this.read()
    const reviews = this.reviews?.()
    const uncommitted = this.uncommitted?.()
    const key = JSON.stringify([source.revision, reviews?.revision, reviews?.pending, reviews?.results, uncommitted?.revision])
    if (key !== this.discoveryKey) { this.discoveryKey = key; this.discoveryRevision++ }
    const snapshot = reviews || uncommitted ? { ...source, revision: this.discoveryRevision } : source
    if (request.expected !== null
      && (request.expected.epoch !== this.epoch || request.expected.revision !== snapshot.revision))
      return { ok: false, error: { code: 'conflict', detail: 'Remote session state changed; restart discovery.' } }
    const cursor = { epoch: this.epoch, revision: snapshot.revision, offset: request.offset }
    if (request.kind === 'detail') {
      const found = snapshot.sessions.find((row) => row.sessionId === request.sessionId)
      if (!found || (!viewer.processes && found.script?.scriptId === 'service'))
        return { ok: false, error: { code: 'not-found', detail: 'Remote session no longer exists.' } }
      const session = viewer.processes ? found : RemoteSessionSnapshots.withoutServices(found)
      const bytes = Buffer.from(JSON.stringify(session), 'utf8')
      if (request.offset >= bytes.length) return RemoteSessionSnapshots.badOffset()
      const end = Math.min(bytes.length, request.offset + RemoteSessionSchemas.chunkBytes)
      return { ok: true, value: { ...cursor, kind: 'detail', sessionId: request.sessionId,
        sourceRevision: source.revision, totalBytes: bytes.length, base64: bytes.subarray(request.offset, end).toString('base64'),
        next: end < bytes.length ? end : null } }
    } else if (request.kind === 'sessions' || request.kind === 'categories') {
      const rows = request.kind === 'sessions'
        ? snapshot.sessions
          .filter((session) => viewer.processes || session.script?.scriptId !== 'service')
          .map((session) => {
            const summary = RemoteSessionSnapshots.summary(session)
            const files = uncommitted?.sessions[session.sessionId]?.files ?? 0
            return { ...summary, reviewPending: reviews?.pending.includes(session.sessionId) === true,
              pending: summary.pending || reviews?.pending.includes(session.sessionId) === true,
              hasResult: summary.hasResult || reviews?.results.includes(session.sessionId) === true,
              ...(files > 0 ? { uncommittedFiles: files } : {}) }
          }).filter((row) => row.life !== 'ended' || row.pending || row.hasResult || row.uncommittedFiles !== undefined)
        : snapshot.categories
      if (request.offset > rows.length) return RemoteSessionSnapshots.badOffset()
      const value: RemoteSessionStatePage = { ...cursor, kind: request.kind, next: null,
        snapshot: { revision: snapshot.revision, reconciled: snapshot.reconciled, host: snapshot.host,
          sessions: [], categories: [], orphans: [] } }
      // The page is measured as a running sum rather than stringified again per row: the empty page
      // without its `null` next, each row with the comma before it, and the digits of the next offset.
      const emptyBytes = RemoteSessionSnapshots.bytesOf(request.requestId, value) - 'null'.length
      let rowsBytes = 0
      let end = request.offset
      for (; end < rows.length; end++) {
        const row = rows[end]!
        const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + (end === request.offset ? 0 : 1)
        const next = end + 1 < rows.length ? end + 1 : null
        if (emptyBytes + rowsBytes + rowBytes + String(next).length > RemoteSessionSchemas.maximumPageBytes) {
          if (end === request.offset)
            return { ok: false, error: { code: 'operation-failed', detail: 'One remote session summary exceeds the page limit.' } }
          break
        }
        rowsBytes += rowBytes
        if (request.kind === 'sessions') value.snapshot.sessions.push(row as RemoteSessionSummary)
        else if (request.kind === 'categories') value.snapshot.categories.push(row as SessionsSnapshot['categories'][number])
        else throw new Error(`Unknown discovery kind: ${JSON.stringify(request)}`)
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
      activityDetail: session.activityDetail, compacting: session.compacting, shellsRunning: session.shellsRunning,
      completed: session.completed,
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

  /** The page as the transport frames it, in UTF-8 bytes. */
  static bytesOf(requestId: string, value: RemoteSessionStatePage): number {
    return Buffer.byteLength(JSON.stringify({ type: 'session-state-response', response: { requestId, result: { ok: true, value } } }), 'utf8')
  }

  private static withoutServices(session: SessionInfo): SessionInfo {
    if (session.scripts === undefined) return session
    const runs = session.scripts.runs.filter((run) => run.scriptId !== 'service')
    if (runs.length === session.scripts.runs.length) return session
    return { ...session, scripts: { ...session.scripts, runs } }
  }

  private static badOffset(): RemoteControlStepResult<never> {
    return { ok: false, error: { code: 'invalid-request', detail: 'Remote session page offset is out of range.' } }
  }
}
