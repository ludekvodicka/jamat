import { join } from 'node:path'
import type { SessionInfo } from '../../sessionManager/sessionManagerApi.types'
import { isOpen } from './admission'
import { endAttempt, sessionOf, setupRunning } from './attemptState'
import { PassInbox, type PassEvent } from './passInbox'
import type { AttemptRecord, SnapinContext, SnapinDefinition, SnapinStateDocument } from './snapinContract'
import type { SnapinStore } from './snapinStore'
import type { TickGuard } from './tickGuard'
import { WorktreeEnding } from './worktreeEnding'
import type { Presentation } from './presentation'

type InboxEntry = { n: number; event: PassEvent | null }
type Evidence = Awaited<ReturnType<SnapinDefinition['evidence']>> | null
export interface PassSettlerOptions {
  definition: SnapinDefinition
  store: SnapinStore
  context: SnapinContext
  directory: string
  stopped(): boolean
  presentation?: Presentation
}

export class PassSettler {
  private readonly options: PassSettlerOptions

  constructor(options: PassSettlerOptions) { this.options = options }

  async settle(guard: TickGuard, reconcile = false): Promise<boolean> {
    const { definition, store, stopped } = this.options
    for (const attempt of store.current.attempts) {
      if (!guard.open(definition.kind) || stopped()) return false
      if (!await this.settleAttempt(attempt.attemptId, guard, reconcile)) return false
    }
    return true
  }

  async settleAttempt(attemptId: string, guard: TickGuard, reconcile = false): Promise<boolean> {
    const { context, definition, store, directory, stopped } = this.options
    const attempt = store.current.attempts.find((a) => a.attemptId === attemptId)
    if (!attempt) return true
    const inbox = await PassInbox.open(join(directory, 'passes', attemptId))
    const events = await inbox.after(attempt.appliedThrough)
    const preview = structuredClone(attempt)
    this.events(preview, events, [])
    let session = sessionOf(preview, context.sessions.snapshot())
    if (session) preview.sessionId = session.sessionId
    const now = context.now()
    const due = (isOpen(preview) || preview.phase === 'review') && (reconcile || preview.evidenceCheckedAt === undefined || now - preview.evidenceCheckedAt >= 30_000)
    const evidence = due ? await definition.evidence(context, preview) : null
    if (isOpen(preview) && (reconcile || (preview.goneObservedAt !== undefined && now - preview.goneObservedAt >= 120_000)))
      events.push(...await inbox.after(events.at(-1)?.n ?? attempt.appliedThrough))
    session = sessionOf(preview, context.sessions.snapshot())
    if (stopped() || !guard.open(definition.kind)) return false
    const candidate = structuredClone(store.current)
    this.apply(candidate, candidate.attempts.find((a) => a.attemptId === attemptId)!, events, evidence, session, now, reconcile, [])
    const logs: string[] = []
    if (JSON.stringify(candidate) !== JSON.stringify(store.current)) {
      if (!await guard.write(definition.kind, (doc) => {
        this.apply(doc, doc.attempts.find((a) => a.attemptId === attemptId)!, events, evidence, session, now, reconcile, logs)
        return doc
      })) return false
      for (const line of logs) context.log(line)
    }
    let stored = store.current.attempts.find((a) => a.attemptId === attemptId)
    if (!stored) return guard.open(definition.kind)
    if (guard.open(definition.kind) && !stopped()) await this.options.presentation?.apply(definition.kind, stored, guard, context.log)
    stored = store.current.attempts.find((a) => a.attemptId === attemptId)
    if (!stored) return guard.open(definition.kind)
    if (stored.phase === 'completed' && stored.resultsSettled !== true && guard.open(definition.kind) && !stopped())
      await this.settleResults(stored, guard)
    return guard.open(definition.kind) && !stopped()
  }

  private apply(doc: SnapinStateDocument, attempt: AttemptRecord, events: InboxEntry[], evidence: Evidence,
    session: SessionInfo | undefined, now: number, reconcile: boolean, logs: string[]): void {
    this.events(attempt, events, logs)
    if (session) {
      if (attempt.sessionId !== session.sessionId) delete attempt.presentedPhase
      attempt.sessionId = session.sessionId
      delete attempt.createUndecided
    }
    if (evidence !== null) {
      attempt.evidenceCheckedAt = now
      if ('published' in evidence && evidence.published) {
        attempt.phase = 'completed'
        attempt.completedAt = now
        attempt.completion = { detail: evidence.detail }
        attempt.resultsSettled = attempt.mode === 'wc'
        attempt.leaseHeld = false
        delete attempt.attention
        logs.push(`Attempt ${attempt.attemptId}: completed: ${evidence.detail}`)
      } else if ('discarded' in evidence) {
        endAttempt(doc, attempt, 'discarded', now)
        logs.push(`Attempt ${attempt.attemptId}: discarded`)
      }
    }
    if (reconcile && attempt.phase === 'pending' && !session) {
      endAttempt(doc, attempt, 'never-created', now)
      logs.push(`Attempt ${attempt.attemptId}: never-created`)
      return
    }
    if (attempt.phase === 'completed') {
      if (session) delete attempt.goneObservedAt
      else attempt.goneObservedAt ??= now
      return
    }
    if (attempt.phase === 'ended') return
    const gone = !session || session.life === 'ended' || session.life === 'lost'
    if (gone) {
      if (reconcile && isOpen(attempt)) attempt.goneObservedAt = now
      else attempt.goneObservedAt ??= now
      if (isOpen(attempt) && now - attempt.goneObservedAt >= 120_000) {
        endAttempt(doc, attempt, 'ended-without-result', now)
        logs.push(`Attempt ${attempt.attemptId}: ended-without-result`)
        return
      }
      if (attempt.phase === 'review' && attempt.mode === 'wc') attempt.attention = 'not-published'
    } else delete attempt.goneObservedAt
    if (session?.life === 'live' && !setupRunning(session)) attempt.readyObservedAt ??= now
    if (attempt.phase === 'pending') {
      if (setupRunning(session) && now - attempt.createdAt >= 900_000) attempt.attention = 'setup'
      else if (attempt.startedAt === undefined && attempt.readyObservedAt !== undefined && now - attempt.readyObservedAt >= 120_000) attempt.attention = 'start'
    }
    if (session?.worktree?.kind === 'git' && attempt.mode === 'wt') attempt.attention = 'worktree-kind'
  }

  private events(attempt: AttemptRecord, events: InboxEntry[], logs: string[]): void {
    for (const { n, event } of events) {
      if (n <= attempt.appliedThrough) continue
      attempt.appliedThrough = n
      if (!event) { logs.push(`Attempt ${attempt.attemptId}: skipped corrupt inbox event ${n}`); continue }
      logs.push(`Attempt ${attempt.attemptId}: ${event.kind}${event.kind === 'note' ? `: ${event.note}` : ''}`)
      if (attempt.phase === 'completed' || attempt.phase === 'ended') continue
      if (event.kind === 'started') {
        if (attempt.phase !== 'pending') continue
        attempt.phase = 'working'
        attempt.startedAt = event.at
        if (event.trail !== undefined) attempt.trail = event.trail
        delete attempt.attention
      } else if (event.kind === 'working') {
        if (attempt.phase === 'pending' || attempt.phase === 'waiting' || attempt.phase === 'blocked' || attempt.phase === 'review') {
          attempt.phase = 'working'
          attempt.startedAt ??= event.at
          delete attempt.attention
        }
      } else if (event.kind === 'done') {
        if (event.outcome === 'ready' || event.outcome === 'closed' || event.outcome === 'published') attempt.phase = 'review'
        else if (event.outcome === 'analysis' && isOpen(attempt)) attempt.phase = event.waiting === 'blocked' ? 'blocked' : 'waiting'
        else if (event.outcome === 'blocked' && isOpen(attempt)) attempt.phase = 'blocked'
        else if (event.outcome === 'analysis' || event.outcome === 'blocked') continue
        else throw new Error(`Unknown pass outcome ${event.outcome}`)
        attempt.outcome = { kind: event.outcome, at: event.at, detail: event.detail,
          ...(event.waiting === undefined ? {} : { waiting: event.waiting }),
          ...(event.note === undefined ? {} : { note: event.note }), ...(event.report === undefined ? {} : { report: event.report }) }
        delete attempt.attention
      } else if (event.kind !== 'note') throw new Error(`Unknown pass event ${JSON.stringify(event)}`)
    }
  }

  private async settleResults(attempt: AttemptRecord, guard: TickGuard): Promise<void> {
    const { context, definition, stopped } = this.options
    const now = context.now()
    if (attempt.resultsCheckedAt !== undefined && now - attempt.resultsCheckedAt < 30_000) return
    const results = await context.sessions.worktreeResults({ tag: attempt.attemptId })
    if (!guard.open(definition.kind) || stopped()) return
    let acknowledged = results.ok
    if (results.ok)
      for (const result of results.value.results) {
        if (result.tag !== attempt.attemptId || result.acknowledgedAt !== null) continue
        if (!guard.open(definition.kind) || stopped()) return
        const answer = await context.sessions.acknowledgeWorktreeResult(result.actionId)
        if (!answer.ok) acknowledged = false
      }
    if (!guard.open(definition.kind) || stopped()) return
    const ending = WorktreeEnding.of(sessionOf(attempt, context.sessions.snapshot()))
    const missing = ending === 'missing' && attempt.goneObservedAt !== undefined && now - attempt.goneObservedAt >= 120_000
    const settled = acknowledged && (ending === 'terminal' || missing)
    if (await guard.write(definition.kind, (doc) => {
      const current = doc.attempts.find((a) => a.attemptId === attempt.attemptId)!
      current.resultsCheckedAt = now
      if (settled) current.resultsSettled = true
      return doc
    }) && settled && missing) context.log(`Attempt ${attempt.attemptId}: worktree ending not observed`)
  }
}
