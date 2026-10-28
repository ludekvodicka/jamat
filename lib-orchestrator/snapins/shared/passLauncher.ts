import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionCreated, SessionsOpResult } from '../../sessionManager/sessionManagerApi.types'
import type { SnapinKindValues, SnapinsSettings } from '../snapinsApi.types'
import type { Presentation } from './presentation'
import type { Grant } from './admission'
import { endAttempt, sessionOf } from './attemptState'
import { PassInbox } from './passInbox'
import type { QueueEntry, SnapinContext, SnapinDefinition, SnapinStateDocument } from './snapinContract'
import type { SnapinStore } from './snapinStore'
import type { TickGuard } from './tickGuard'

type CreateAnswer = SessionsOpResult<SessionCreated> | 'rejected'
export interface PassLauncherOptions {
  definition: SnapinDefinition
  store: SnapinStore
  context: SnapinContext
  directory: string
  settings(): SnapinsSettings
  values(): SnapinKindValues
  stopped(): boolean
  hold(itemKey: string, text: string): void
  /** Marks the listed item held until the next listing; the source refused it at launch. */
  refuse(itemKey: string, text: string): void
  presentation?: Presentation
}

export class PassLauncher {
  private readonly options: PassLauncherOptions
  private readonly unboundAnswers: Map<string, { answer: CreateAnswer; entry: QueueEntry }>

  constructor(options: PassLauncherOptions) { this.options = options; this.unboundAnswers = new Map() }
  get hasUnbound(): boolean { return this.unboundAnswers.size > 0 }

  async bindUnbound(guard: TickGuard): Promise<void> {
    const { definition, store, context } = this.options
    for (const [attemptId, { answer, entry }] of this.unboundAnswers) {
      if (!guard.open(definition.kind)) return
      if (await guard.write(definition.kind, (doc) => this.bind(doc, attemptId, answer, entry))) this.unboundAnswers.delete(attemptId)
    }
    for (const attempt of store.current.attempts) {
      if (!guard.open(definition.kind)) return
      if (!attempt.createUndecided) continue
      const session = sessionOf(attempt, context.sessions.snapshot())
      if (session) await guard.write(definition.kind, (doc) => {
        const current = doc.attempts.find((a) => a.attemptId === attempt.attemptId)!
        if (current.sessionId !== session.sessionId) delete current.presentedPhase
        current.sessionId = session.sessionId
        delete current.createUndecided
        return doc
      })
    }
  }

  async launch(grant: Grant, guard: TickGuard): Promise<void> {
    const { definition, context, store, stopped } = this.options
    const template = this.options.settings().workerPrompts[grant.agentId]
    if (!template?.trim() || !template.includes('{pass}')) {
      this.options.hold(grant.item.key, 'No worker configured: Settings → Snap-ins')
      return
    }
    const values = structuredClone(this.options.values())
    const attemptId = randomUUID()
    const spec = await definition.launchSpec(context, values, grant.item, attemptId)
    if (stopped() || !guard.open(grant.kind)) return
    if (JSON.stringify(values) !== JSON.stringify(this.options.values())) {
      this.options.hold(grant.item.key, 'Settings changed; waiting for a fresh listing')
      return
    }
    // Dequeued rather than kept: a queued item is granted again on every tick, and a source checks
    // its precondition (svn for review todos) in `launchSpec`, so a kept refusal would repeat that check.
    if ('hold' in spec) {
      if (!await guard.write(grant.kind, (doc) => { doc.queue = doc.queue.filter((entry) => entry.itemKey !== grant.item.key); return doc }))
        return
      this.options.refuse(grant.item.key, spec.hold)
      context.log(`Skipped ${grant.item.title}: ${spec.hold}`)
      return
    }
    const projectDirectory = await realpath(grant.item.projectDirectory)
    if (stopped() || !guard.open(grant.kind)) return
    const inbox = await PassInbox.create(join(this.options.directory, 'passes', attemptId), {
      schema: 1, attemptId, kind: grant.kind, mode: grant.item.mode, projectDirectory,
      priorAttemptId: grant.entry.priorAttemptId ?? null, work: spec.work,
    })
    if (stopped() || !guard.open(grant.kind)) return
    if (JSON.stringify(values) !== JSON.stringify(this.options.values())) {
      this.options.hold(grant.item.key, 'Settings changed; waiting for a fresh listing')
      return
    }
    if (!await guard.write(grant.kind, (doc) => {
      const holder = grant.item.mode === 'wc' ? doc.attempts.find((a) => a.attemptId === grant.entry.inheritsLeaseFrom && a.leaseHeld) : undefined
      if (holder) holder.leaseHeld = false
      doc.attempts.push({ attemptId, itemKey: grant.item.key, title: grant.item.title, group: grant.item.group,
        mode: grant.item.mode, projectDirectory, agentId: grant.agentId, phase: 'pending', createdAt: context.now(),
        appliedThrough: 0, leaseHeld: grant.item.mode === 'wc', ...(holder ? { leaseFrom: holder.attemptId } : {}) })
      doc.queue = doc.queue.filter((entry) => entry.itemKey !== grant.item.key)
      return doc
    })) return
    if (stopped()) return
    let answer: CreateAnswer
    try {
      answer = await context.sessions.createSession({ kind: 'agent', directory: spec.directory, title: spec.title,
        number: spec.number, color: definition.colour, agent: { agentId: grant.agentId, mode: 'new',
          initialPrompt: PassLauncher.prompt(template, inbox.directory) },
        ...(grant.item.mode === 'wt' ? { worktree: { slug: spec.worktreeSlug!, tag: attemptId } } : {}),
        ...(grant.entry.acknowledgeSetup ? { acknowledgeSetup: grant.entry.acknowledgeSetup } : {}),
      }, { callerOperationId: attemptId })
    } catch { answer = 'rejected' }
    if (!await guard.write(grant.kind, (doc) => this.bind(doc, attemptId, answer, grant.entry))) {
      this.unboundAnswers.set(attemptId, { answer, entry: grant.entry })
      return
    }
    const stored = store.current.attempts.find((a) => a.attemptId === attemptId)!
    if (stored.sessionId && !stopped() && guard.open(grant.kind))
      await this.options.presentation?.apply(grant.kind, stored, guard, context.log)
  }

  static prompt(template: string, directory: string): string { return template.replaceAll('{pass}', `"${directory}"`) }

  private bind(doc: SnapinStateDocument, attemptId: string, answer: CreateAnswer, entry: QueueEntry): SnapinStateDocument {
    const attempt = doc.attempts.find((a) => a.attemptId === attemptId)!
    if (answer === 'rejected') attempt.createUndecided = true
    else if (answer.ok) attempt.sessionId = answer.value.sessionId
    else if (answer.recordedSessionId) attempt.sessionId = answer.recordedSessionId
    else {
      endAttempt(doc, attempt, `create-refused:${answer.code}`, this.options.context.now())
      this.options.context.log(`Attempt ${attemptId}: create-refused:${answer.code}: ${answer.detail}`)
      if (answer.code === 'setup-not-acknowledged' && answer.setup) {
        const retry: QueueEntry = { ...entry, setupAgreement: { hash: answer.setup.hash, commands: [...answer.setup.commands] } }
        delete retry.acknowledgeSetup
        doc.queue.unshift(retry)
      }
    }
    return doc
  }
}
