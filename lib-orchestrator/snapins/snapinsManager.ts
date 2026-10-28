import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { ErrorText } from '../shared/errorText'
import { PathCompare } from '../shared/pathCompare'
import { SessionWorkingDirectory } from '../sessionManager/sessionWorkingDirectory'
import type { SessionsSnapshot } from '../sessionManager/sessionManagerApi.types'
import { admit, isOpen, type AdmissionInput } from './shared/admission'
import { endAttempt, holderOf, newestOf, sessionOf, setupRunning } from './shared/attemptState'
import { PassLauncher } from './shared/passLauncher'
import { PassSettler } from './shared/passSettler'
import { PassReconciler } from './shared/passReconciler'
import { Presentation } from './shared/presentation'
import type { SnapinContext, SnapinDefinition, SnapinItem } from './shared/snapinContract'
import { SnapinLog } from './shared/snapinLog'
import { SnapinStore } from './shared/snapinStore'
import { TickGuard } from './shared/tickGuard'
import type { SnapinAction, SnapinKindState, SnapinPresentationPort, SnapinResult, SnapinsSettings, SnapinsSettingsView, SnapinView } from './snapinsApi.types'

interface KindRuntime {
  definition: SnapinDefinition
  store: SnapinStore
  log: SnapinLog
  pendingLogs: Promise<void>
  items: SnapinItem[]
  listingAt: number | null
  listingError: string | null
  listedValues: string | null
  holds: Map<string, string>
  launcher?: PassLauncher
  settler?: PassSettler
  reconciler?: PassReconciler
  latch: string | null
  ready: boolean
  commands: { actionId: string; itemKeys: string[] }[]
  view: SnapinView | null
}

export interface SnapinsManagerOptions {
  definitions: SnapinDefinition[]
  ports: Pick<SnapinContext, 'sessions' | 'svn' | 'projects'>
  settings(): SnapinsSettings
  directory: string
  onChanged(kind: string): void
  report(message: string): void
  now?(): number
  presentation?: SnapinPresentationPort
}

export class SnapinsManager {
  private readonly kinds: Map<string, KindRuntime>
  private readonly options: SnapinsManagerOptions
  private readonly now: () => number
  private ticking: Promise<void> | null
  private again: boolean
  private stopped: boolean
  private timer: ReturnType<typeof setTimeout> | null
  private readonly presentation: Presentation | undefined

  constructor(options: SnapinsManagerOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.kinds = new Map(options.definitions.map((definition) => {
      const directory = join(options.directory, definition.kind)
      return [definition.kind, { definition,
        store: new SnapinStore(directory, definition.kind, { now: this.now, report: options.report }),
        log: new SnapinLog(directory, options.report), pendingLogs: Promise.resolve(), items: [], listingAt: null, listingError: null,
        latch: null, ready: false, commands: [], view: null, listedValues: null, holds: new Map() }]
    }))
    if (this.kinds.size !== options.definitions.length) throw new Error('Duplicate snap-in kind')
    this.ticking = null
    this.again = false
    this.stopped = false
    this.timer = null
    this.presentation = options.presentation ? new Presentation(options.presentation, this.now, () => this.stopped) : undefined
    for (const [kind, value] of this.kinds) {
      value.launcher = new PassLauncher({ definition: value.definition, store: value.store, context: this.context(value),
        directory: join(options.directory, kind), settings: options.settings, values: () => this.values(kind),
        stopped: () => this.stopped, hold: (key, text) => value.holds.set(key, text),
        refuse: (key, text) => { const item = value.items.find((entry) => entry.key === key); if (item) item.hold = text },
        presentation: this.presentation })
      value.settler = new PassSettler({ definition: value.definition, store: value.store, context: this.context(value),
        directory: join(options.directory, kind), stopped: () => this.stopped, presentation: this.presentation })
      value.reconciler = new PassReconciler(value.settler)
    }
  }

  list(): { kinds: { kind: string; title: string; state: SnapinKindState }[] } {
    return { kinds: [...this.kinds].map(([kind, value]) => ({ kind, title: value.definition.title, state: this.state(value) })) }
  }

  async settingsView(): Promise<SnapinsSettingsView> {
    const settings = structuredClone(this.options.settings())
    const kinds = []
    for (const [kind, value] of this.kinds)
      kinds.push({ kind, title: value.definition.title,
        fields: await value.definition.settings.fields(settings.kinds[kind] ?? {}, this.context(value)) })
    return { settings, kinds }
  }

  async view(kind: string): Promise<SnapinResult<SnapinView>> {
    const value = this.kinds.get(kind)
    if (!value) return { ok: false, code: 'unknown-kind', detail: `Unknown snap-in ${kind}` }
    return { ok: true, value: structuredClone(value.view ?? await this.compose(value, 0)) }
  }

  async press(kind: string, actionId: string, itemKeys: string[] = []): Promise<SnapinResult<{ accepted: true }>> {
    if (this.stopped) return { ok: false, code: 'stopping', detail: 'Snap-ins are stopping' }
    const value = this.kinds.get(kind)
    if (!value) return { ok: false, code: 'unknown-kind', detail: `Unknown snap-in ${kind}` }
    if (value.latch !== null) return { ok: false, code: 'kind-latched', detail: value.latch }
    const shared = ['shared.refresh', 'shared.solveSelected', 'shared.solveAll', 'shared.pause', 'shared.resume',
      'shared.dequeue', 'shared.startAnyway', 'shared.approveSetup', 'shared.openWorker', 'shared.openHolder', 'shared.release', 'shared.restart']
    if (!shared.includes(actionId) && !value.items.some((item) => item.actions.some((action) => action.id === actionId)))
      return { ok: false, code: 'unknown-action', detail: `Unknown action ${actionId}` }
    if (itemKeys.some((key) => !value.items.some((item) => item.key === key) && !value.store.current.attempts.some((a) => a.itemKey === key))
      || (['shared.dequeue', 'shared.startAnyway', 'shared.approveSetup', 'shared.openWorker', 'shared.openHolder', 'shared.release', 'shared.restart'].includes(actionId) && itemKeys.length !== 1))
      return { ok: false, code: 'invalid-items', detail: 'The selected items are no longer listed' }
    if (actionId === 'shared.openWorker' || actionId === 'shared.openHolder') return this.openWorker(value, itemKeys[0]!, actionId)
    if (value.ready) {
      const refusal = this.eligibility(value, actionId, itemKeys)
      if (refusal) return refusal
    }
    value.commands.push({ actionId, itemKeys: [...itemKeys] })
    this.wake()
    return { ok: true, value: { accepted: true } }
  }

  wake(): void {
    if (this.stopped) return
    if (this.ticking) {
      this.again = true
      return
    }
    this.ticking = this.tick().catch((error: unknown) => this.options.report(ErrorText.of(error))).finally(() => {
      this.ticking = null
      this.armTimer()
      if (this.again) {
        this.again = false
        this.wake()
      }
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.ticking) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.ticking, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 10_000) })])
    clearTimeout(timeout)
  }

  private async tick(): Promise<void> {
    this.presentation?.beginTick()
    const guard = new TickGuard(new Map([...this.kinds].map(([kind, value]) => [kind, value.store])),
      (kind) => { void this.log(this.kinds.get(kind)!, 'State write refused; remaining work of this kind skipped', 'warn') })
    for (const [kind, value] of this.kinds) {
      try {
        const read = await value.store.read()
        if (!read.ok) {
          value.latch = read.latched
          continue
        }
        // Every session change wakes this tick and a source may read every catalog project, so a tick
        // lists only for queued work that has no listing made with the current settings (a restart, a
        // settings change). Otherwise only the `shared.refresh` the shown panel presses lists.
        if (value.store.current.queue.length > 0 && value.listedValues !== JSON.stringify(this.values(kind)))
          await this.refresh(value)
      } catch (error) {
        guard.abort(kind)
        await this.log(value, ErrorText.of(error), 'error')
        this.options.report(`Snap-in ${kind}: ${ErrorText.of(error)}`)
      }
    }
    const snapshot = this.options.ports.sessions.snapshot()
    if (snapshot.reconciled) {
      for (const [kind, value] of this.kinds) {
        if (value.latch !== null) continue
        try {
          if (!value.ready) value.ready = await value.reconciler!.run(guard) && guard.open(kind)
          if (!value.ready) continue
          await value.launcher?.bindUnbound(guard)
          while (value.commands.length && guard.open(kind) && !this.stopped)
            await this.applyCommand(value, value.commands.shift()!, guard)
          if (guard.open(kind) && !this.stopped) await value.settler?.settle(guard)
        } catch (error) { guard.abort(kind); await this.failed(value, error) }
      }
      if (!this.stopped && [...this.kinds.values()].every((value) => value.ready && value.latch === null)
        && [...this.kinds.values()].some((value) => value.store.current.queue.length)) {
        try {
        const currentSnapshot = this.options.ports.sessions.snapshot()
        const admission = currentSnapshot.reconciled ? admit(await this.admissionInput(guard, currentSnapshot)) : { grants: [], holds: [], dropped: [] }
        for (const value of this.kinds.values()) value.holds.clear()
        for (const hold of admission.holds)
          for (const value of this.kinds.values())
            if (value.store.current.queue.some((entry) => entry.itemKey === hold.itemKey)) value.holds.set(hold.itemKey, hold.hold)
        for (const [kind, value] of this.kinds)
          if (guard.open(kind) && value.store.current.queue.some((entry) => admission.dropped.includes(entry.itemKey)))
            await guard.write(kind, (doc) => { doc.queue = doc.queue.filter((entry) => !admission.dropped.includes(entry.itemKey)); return doc })
        for (const grant of admission.grants) {
          if (this.stopped || !guard.open(grant.kind)) continue
          const value = this.kinds.get(grant.kind)!
          try { await value.launcher?.launch(grant, guard) }
          catch (error) { guard.abort(grant.kind); await this.failed(value, error) }
        }
        } catch (error) {
          for (const value of this.kinds.values())
            if (value.store.current.queue.length) await this.failed(value, error)
        }
      }
    }
    for (const [kind, value] of this.kinds) {
      const next = await this.compose(value, value.view?.revision ?? 0)
      if (JSON.stringify(next) === JSON.stringify(value.view)) continue
      next.revision += 1
      value.view = next
      this.options.onChanged(kind)
    }
  }

  private async refresh(value: KindRuntime): Promise<void> {
    if (value.listingAt !== null && this.now() - value.listingAt < 10_000) return
    value.listingAt = this.now()
    try {
      const values = structuredClone(this.values(value.definition.kind))
      const answer = await value.definition.list(this.context(value), values)
      if (answer.ok) {
        value.items = await Promise.all(answer.items.map(async (item) => ({ ...item,
          projectDirectory: await realpath(item.projectDirectory) })))
        value.listedValues = JSON.stringify(values)
        value.listingError = null
      } else value.listingError = answer.detail
    } catch (error) {
      value.listingError = ErrorText.of(error)
      await this.log(value, value.listingError, 'error')
      this.options.report(`Snap-in ${value.definition.kind}: ${value.listingError}`)
    }
  }

  private async openWorker(value: KindRuntime, itemKey: string, actionId: string): Promise<SnapinResult<{ accepted: true }>> {
    const attempt = actionId === 'shared.openHolder' ? holderOf(value.store.current, itemKey) : newestOf(value.store.current, itemKey)
    const session = attempt && sessionOf(attempt, this.options.ports.sessions.snapshot())
    if (!session) return { ok: false, code: 'no-session', detail: 'No worker session is available' }
    try {
      const result = await this.options.ports.sessions.openTerminal(session.sessionId)
      if (result === 'ok') return { ok: true, value: { accepted: true } }
      else if (result === 'missing-session') return { ok: false, code: 'no-session', detail: 'No worker session is available' }
      else return { ok: false, code: 'tab-unavailable', detail: result.error }
    } catch (error) { return { ok: false, code: 'tab-unavailable', detail: ErrorText.of(error) } }
  }

  private async applyCommand(value: KindRuntime, command: { actionId: string; itemKeys: string[] }, guard: TickGuard): Promise<void> {
    const { actionId, itemKeys } = command
    const kind = value.definition.kind
    const refusal = this.eligibility(value, actionId, itemKeys)
    if (refusal && !refusal.ok) { await this.log(value, refusal.detail, 'warn'); return }
    if (actionId === 'shared.refresh') await this.refresh(value)
    else if (!actionId.startsWith('shared.')) {
      const answer = await value.definition.press(this.context(value), this.values(kind), actionId, itemKeys)
      if (!answer.ok) await this.log(value, answer.code, 'warn')
    }
    if (this.stopped || !guard.open(kind)) return
    await guard.write(kind, (doc) => {
      if (actionId === 'shared.release') {
        const newest = newestOf(doc, itemKeys[0]!)
        const holder = holderOf(doc, itemKeys[0]!)
        if (newest && (isOpen(newest) || newest.phase === 'review')) endAttempt(doc, newest, 'released', this.now())
        if (holder) {
          holder.leaseHeld = false
          for (const entry of doc.queue)
            if (entry.inheritsLeaseFrom === holder.attemptId) delete entry.inheritsLeaseFrom
        }
      } else if (actionId === 'shared.restart') {
        const newest = newestOf(doc, itemKeys[0]!)!
        const holder = holderOf(doc, itemKeys[0]!)
        if (newest.phase === 'review') endAttempt(doc, newest, 'superseded', this.now())
        doc.queue.push({ itemKey: newest.itemKey, addedAt: this.now(), priorAttemptId: newest.attemptId,
          ...(holder ? { inheritsLeaseFrom: holder.attemptId } : {}) })
      } else if (actionId === 'shared.solveSelected' || actionId === 'shared.solveAll') {
        const items = actionId === 'shared.solveAll' ? value.definition.solveAllOrder(value.items)
          : itemKeys.map((key) => value.items.find((item) => item.key === key)).filter((item): item is SnapinItem => !!item)
        for (const item of items) {
          if (item.hold || !item.selectable || doc.queue.some((entry) => entry.itemKey === item.key)
            || doc.attempts.some((a) => a.itemKey === item.key && (isOpen(a) || a.phase === 'review'))) {
            void this.log(value, `Skipped ${item.title}: held, queued or already running`)
            continue
          }
          doc.queue.push({ itemKey: item.key, addedAt: this.now() })
        }
      } else if (actionId === 'shared.pause') doc.paused = true
      else if (actionId === 'shared.resume') doc.paused = false
      else if (actionId === 'shared.dequeue') doc.queue = doc.queue.filter((entry) => !itemKeys.includes(entry.itemKey))
      else if (actionId === 'shared.startAnyway' || actionId === 'shared.approveSetup') {
        const entry = doc.queue.find((item) => item.itemKey === itemKeys[0])
        if (entry && actionId === 'shared.startAnyway') entry.startAnyway = true
        else if (entry?.setupAgreement && actionId === 'shared.approveSetup') entry.acknowledgeSetup = entry.setupAgreement.hash
      } else if (actionId !== 'shared.refresh' && actionId.startsWith('shared.')) throw new Error(`Unknown shared action ${actionId}`)
      return doc
    })
  }

  private eligibility(value: KindRuntime, actionId: string, itemKeys: string[]): SnapinResult<{ accepted: true }> | null {
    if (actionId !== 'shared.release' && actionId !== 'shared.restart') return null
    const doc = value.store.current
    const newest = newestOf(doc, itemKeys[0]!)
    const holder = holderOf(doc, itemKeys[0]!)
    if (actionId === 'shared.restart') {
      if (!newest || !value.items.some((item) => item.key === itemKeys[0]) || doc.queue.some((entry) => entry.itemKey === itemKeys[0])
        || !(newest.phase === 'ended' || (newest.phase === 'review' && newest.attention === 'not-published')))
        return { ok: false, code: 'invalid-items', detail: 'Restart requires a listed item with an ended or unpublished attempt' }
    } else if (actionId === 'shared.release') {
      if (!holder && (!newest || (!isOpen(newest) && newest.phase !== 'review')))
        return { ok: false, code: 'invalid-items', detail: 'Release no longer applies to this item' }
      for (const attempt of [newest && (isOpen(newest) || newest.phase === 'review') ? newest : undefined, holder]) {
        if (!attempt) continue
        const session = sessionOf(attempt, this.options.ports.sessions.snapshot())
        if (session?.life === 'starting' || session?.life === 'live')
          return { ok: false, code: 'session-live', detail: `Close the worker session of attempt ${attempt.attemptId.slice(0, 8)} first` }
      }
    } else throw new Error(`Unknown eligibility action ${actionId}`)
    return null
  }

  private async admissionInput(guard: TickGuard, snapshot: SessionsSnapshot): Promise<AdmissionInput> {
    const settings = this.options.settings()
    const attempts = [...this.kinds.values()].flatMap((value) => value.store.current.attempts)
    const foreign = await Promise.all(snapshot.sessions.filter((session) => (session.life === 'starting' || session.life === 'live') && !session.script
      && !attempts.some((a) => a.sessionId === session.sessionId || a.attemptId === session.callerOperationId))
      .map(async (session) => { const directory = SessionWorkingDirectory.of(session)
        return directory ? { title: session.title, directory: await realpath(directory) } : null }))
    return { limit: settings.limit, agents: settings.agents.filter((agent) => settings.workerPrompts[agent]?.trim()
      && settings.workerPrompts[agent]?.includes('{pass}')),
      kinds: [...this.kinds].map(([kind, value]) => ({ kind, paused: value.store.current.paused,
        listingAvailable: guard.open(kind) && value.listingError === null && value.listedValues === JSON.stringify(this.values(kind)),
        queue: value.store.current.queue.map((entry) => ({ entry, item: value.items.find((item) => item.key === entry.itemKey) ?? null })),
        attempts: value.store.current.attempts.map((record) => { const session = sessionOf(record, snapshot)
          return { record, life: session?.life ?? 'missing', setupRunning: setupRunning(session) } }),
      })), foreign: foreign.filter((session): session is NonNullable<typeof session> => session !== null),
    }
  }

  private async failed(value: KindRuntime, error: unknown): Promise<void> {
    await this.log(value, ErrorText.of(error), 'error')
    this.options.report(`Snap-in ${value.definition.kind}: ${ErrorText.of(error)}`)
  }

  private values(kind: string) { return this.options.settings().kinds[kind] ?? {} }
  private context(value: KindRuntime): SnapinContext {
    return { ...this.options.ports, now: this.now, log: (text) => { void this.log(value, text) } }
  }
  private log(value: KindRuntime, text: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<void> {
    value.pendingLogs = value.log.append({ at: this.now(), level, text })
    return value.pendingLogs
  }
  private state(value: KindRuntime): SnapinKindState {
    if (!value.ready && value.latch === null) return 'reconciling'
    if (value.latch !== null || value.listingError !== null) return 'unavailable'
    const settings = this.options.settings()
    if (!settings.agents.some((agent) => settings.workerPrompts[agent]?.trim() && settings.workerPrompts[agent]?.includes('{pass}'))) return 'unconfigured'
    if (value.store.current.paused) return 'paused'
    if (value.store.current.queue.length || value.store.current.attempts.some((a) => a.phase !== 'ended' && a.phase !== 'completed')) return 'running'
    return 'idle'
  }

  private async compose(value: KindRuntime, revision: number): Promise<SnapinView> {
    await value.pendingLogs
    const groups: Extract<SnapinView['sections'][number], { kind: 'items' }>['groups'] = []
    const byDirectory = new Map<string, (typeof groups)[number]>()
    const doc = value.store.current
    const listed = new Set(value.items.map((item) => item.key))
    const items = [...value.items]
    for (const attempt of doc.attempts) {
      if (items.some((item) => item.key === attempt.itemKey)) continue
      const newest = newestOf(doc, attempt.itemKey)!
      if (!isOpen(newest) && newest.phase !== 'review' && !holderOf(doc, newest.itemKey)
        && this.now() - (newest.completedAt ?? newest.endedAt ?? newest.createdAt) > 86_400_000) continue
      items.push({ key: newest.itemKey, title: newest.title, group: newest.group, mode: newest.mode,
        projectDirectory: newest.projectDirectory, selectable: false, actions: [], payload: {} })
    }
    const counts: SnapinView['counts'] = {}
    for (const item of items) {
      const directory = PathCompare.comparable(item.projectDirectory)
      let group = byDirectory.get(directory)
      if (!group) {
        group = { title: item.group, mode: item.mode, items: [] }
        groups.push(group)
        byDirectory.set(directory, group)
      }
      if (group.mode !== item.mode) delete group.mode
      const attempt = newestOf(doc, item.key)
      const holder = holderOf(doc, item.key)
      const entry = doc.queue.find((entry) => entry.itemKey === item.key)
      let hold = entry?.setupAgreement && entry.acknowledgeSetup !== entry.setupAgreement.hash
        ? `Worktree commands need approval\n${entry.setupAgreement.commands.join('\n')}` : value.holds.get(item.key) ?? item.hold
      if (holder && holder.attemptId !== attempt?.attemptId)
        hold = [hold, `WC lease held by attempt ${holder.attemptId.slice(0, 8)}`].filter(Boolean).join('\n')
      if (attempt?.attention) hold = [hold, attempt.attention].filter(Boolean).join('\n')
      const state = entry ? hold ? 'held' : 'queued' : attempt?.phase ?? (hold ? 'held' : 'ready')
      const label = state === 'review' ? 'waits for review' : state === 'completed' ? 'done'
        : state === 'ended' && (attempt?.endedReason === 'never-created' || attempt?.endedReason?.startsWith('create-refused:'))
          ? 'launch failed' : state
      const actions = [...item.actions]
      if (entry) {
        actions.push(this.action('dequeue', 'Dequeue', 'item'))
        if (hold?.startsWith('session ')) actions.push(this.action('startAnyway', 'Start anyway', 'item'))
        if (entry.setupAgreement) actions.push(this.action('approveSetup', 'Approve and start', 'item'))
      }
      if (attempt) actions.push(this.action('openWorker', 'Open worker', 'item'))
      if (holder || (attempt && (isOpen(attempt) || attempt.phase === 'review')))
        actions.push(this.action('release', 'Release', 'item'))
      if (holder?.sessionId && holder.attemptId !== attempt?.attemptId) actions.push(this.action('openHolder', 'Open lease holder', 'item'))
      if (listed.has(item.key) && !entry && attempt && (attempt.phase === 'ended' || (attempt.phase === 'review' && attempt.attention === 'not-published')))
        actions.push(this.action('restart', 'Restart', 'item'))
      if (state !== 'ready') counts[state as keyof typeof counts] = (counts[state as keyof typeof counts] ?? 0) + 1
      group.items.push({ key: item.key, title: item.title, state: label, mode: item.mode,
        tone: state === 'completed' ? 'done' : hold || state === 'review' || state === 'blocked' ? 'attention'
          : state === 'working' || state === 'pending' ? 'active' : 'neutral', hold,
        sessionId: attempt?.sessionId, selectable: listed.has(item.key) && item.selectable, actions })
    }
    const state = this.state(value)
    const sections: SnapinView['sections'] = []
    const problem = value.latch ?? value.listingError
    if (problem !== null) sections.push({ kind: 'notice', tone: 'warning', text: problem })
    if (state === 'unconfigured') sections.push({ kind: 'notice', tone: 'info', text: 'No worker configured: Settings → Snap-ins' })
    if (state === 'reconciling') sections.push({ kind: 'notice', tone: 'info', text: 'Reconciling worker sessions' })
    sections.push({ kind: 'items', groups, actions: [this.action('solveSelected', 'Solve selected', 'selection'),
      this.action('solveAll', 'Solve all', 'kind'), this.action(doc.paused ? 'resume' : 'pause', doc.paused ? 'Resume' : 'Pause', 'kind'),
      this.action('refresh', 'Refresh', 'kind')] },
      { kind: 'log', lines: await value.log.read() })
    return { kind: value.definition.kind, title: value.definition.title, revision, state,
      counts, sections }
  }

  private action(id: string, label: string, scope: SnapinAction['scope']): SnapinAction {
    return { id: `shared.${id}`, label, scope, tone: id.startsWith('solve') ? 'primary' : 'secondary' }
  }

  private armTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.stopped || ![...this.kinds.values()].some((value) => !value.ready || value.commands.length || value.launcher?.hasUnbound
      || value.store.current.queue.length || value.store.current.attempts.some((a) => a.presentationRetryAt !== undefined
        || (a.phase === 'completed' && a.resultsSettled !== true) || (a.phase !== 'completed' && a.phase !== 'ended')))) return
    this.timer = setTimeout(() => { this.timer = null; this.wake() }, 10_000)
    this.timer.unref()
  }
}
