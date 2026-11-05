import type { HostDescriptor, RuntimeRef } from '../../../app-host/app/wire/hostWire.js'
import type {
  TerminalAttachResult,
  TerminalAttachSpec,
} from '../sessionManagerApi.types'
import {
  TerminalAttachment,
  type TerminalSocketFactory,
} from './terminalAttachment'
import { TerminalInputActivity } from './terminalInputActivity'

import type { TerminalRefResolution, TerminalPort, TerminalSessionsFeed, TerminalRefChange, TerminalActivitySink, TerminalAttachSource, TerminalAttachOwner, TerminalInputResult, TerminalResizeResult, InputInhibit, TerminalTransactionResult } from './terminalPort'

export interface TerminalGatewayDeps {
  descriptorOf: () => HostDescriptor | null
  leaseIdOf: () => string | null
  onError: (message: string) => void
  socketFactory: TerminalSocketFactory
  activity: TerminalActivitySink
}

interface InputControl {
  holders: number
  transaction: symbol | null
  waiting: (() => void)[]
  queued: { attachId: string; managed: ManagedTerminalAttachment; generation: number; data: string; at: number
    resolve: (result: TerminalInputResult) => void; reject: (error: unknown) => void }[]
}

interface ManagedTerminalAttachment {
  attachment: TerminalAttachment
  sessionId: string
  source: TerminalAttachSource
  windowId: string | undefined
  wantedSize: { cols: number; rows: number } | null
  geometryActive: boolean
  geometryOrder: number
}

export class TerminalGateway implements TerminalPort, TerminalSessionsFeed {
  readonly capabilities = { snapshotStreaming: true }
  private readonly refs = new Map<string, TerminalRefResolution>()
  private readonly inputTimes = new Map<string, { lastInput: number; lastMark: number }>()
  private readonly marks = new Map<string, number>()
  private markTimer: ReturnType<typeof setTimeout> | null = null
  private hintTimer: ReturnType<typeof setTimeout> | null = null

  async publishRefs(changes: readonly TerminalRefChange[]): Promise<void> {
    for (const change of changes) {
      if (!change.resolution.ok && change.resolution.code === 'unknown-session') {
        this.refs.delete(change.sessionId)
        this.inputTimes.delete(change.sessionId)
        this.marks.delete(change.sessionId)
      }
      else this.refs.set(change.sessionId, change.resolution)
    }
    if (this.marks.size === 0 && this.markTimer !== null) {
      clearTimeout(this.markTimer)
      this.markTimer = null
    }
  }

  private refOf = (sessionId: string): TerminalRefResolution => {
    return this.refs.get(sessionId) ?? { ok: false, code: 'unknown-session' }
  }

  async authorize(windowId: string, attachId: string): Promise<{ sessionId: string } | { refused: true }> {
    const managed = this.attachments.get(attachId)
    return managed?.source === 'local' && managed.windowId === windowId ? { sessionId: managed.sessionId } : { refused: true }
  }
  private static readonly earlyDetachLimitConst = 64

  private readonly controls = new Map<string, InputControl>()

  async inhibit(sessionId: string): Promise<InputInhibit> {
    const control = this.controlOf(sessionId)
    if (control.transaction !== null)
      return new Promise(resolve => control.waiting.push(() => resolve(this.inhibit(sessionId))))
    control.holders++
    let released = false
    return { release: () => {
      if (released) return
      released = true
      control.holders--
      this.releaseControl(sessionId, control)
    } }
  }

  async transaction(attachId: string): Promise<TerminalTransactionResult> {
    const managed = this.attachments.get(attachId)
    if (!managed || !managed.attachment.acceptsInput()) return { refused: 'not-writer' }
    const generation = managed.attachment.inputGeneration()
    const resolution = this.refOf(managed.sessionId)
    if (!resolution.ok) return { refused: 'not-writer' }
    return this.transactionFor(attachId, managed, generation, resolution.ref)
  }

  private async transactionFor(attachId: string, managed: ManagedTerminalAttachment, generation: number,
    ref: RuntimeRef): Promise<TerminalTransactionResult> {
    const resolution = this.refOf(managed.sessionId)
    if (this.attachments.get(attachId) !== managed || !managed.attachment.acceptsInput()
      || managed.attachment.inputGeneration() !== generation || !resolution.ok
      || resolution.ref.hostInstanceId !== ref.hostInstanceId
      || resolution.ref.runtimeSessionId !== ref.runtimeSessionId || resolution.ref.generation !== ref.generation)
      return { refused: 'not-writer' }
    const control = this.controlOf(managed.sessionId)
    if (control.transaction !== null) return { refused: 'busy' }
    if (control.holders > 0)
      return new Promise(resolve => control.waiting.push(() => resolve(this.transactionFor(attachId, managed, generation, ref))))
    const token = Symbol()
    control.transaction = token
    return {
      write: async data => {
        const current = this.refOf(managed.sessionId)
        if (control.transaction !== token || this.attachments.get(attachId) !== managed
          || managed.attachment.inputGeneration() !== generation || !current.ok
          || current.ref.hostInstanceId !== ref.hostInstanceId
          || current.ref.runtimeSessionId !== ref.runtimeSessionId
          || current.ref.generation !== ref.generation)
          return { refused: 'disconnected' }
        const written = this.write(managed, data)
        return managed.attachment.inputGeneration() === generation ? written : { refused: 'disconnected' }
      },
      end: () => {
        if (control.transaction !== token) return
        control.transaction = null
        this.releaseControl(managed.sessionId, control)
      },
    }
  }

  async pendingInput(sessionId: string): Promise<number> { return this.controls.get(sessionId)?.queued.length ?? 0 }

  private controlOf(sessionId: string): InputControl {
    let control = this.controls.get(sessionId)
    if (control === undefined) {
      control = { holders: 0, transaction: null, waiting: [], queued: [] }
      this.controls.set(sessionId, control)
    }
    return control
  }

  private releaseControl(sessionId: string, control: InputControl): void {
    if (control.holders > 0 || control.transaction !== null) return
    for (const resume of control.waiting.splice(0)) resume()
    if (control.holders > 0 || control.transaction !== null) return
    this.controls.delete(sessionId)
    if (control.queued.length > 0) this.queueHint()
    for (const input of control.queued.splice(0)) {
      try {
        if (this.attachments.get(input.attachId) !== input.managed
          || input.managed.attachment.inputGeneration() !== input.generation) {
          input.resolve({ kind: 'unknown-attach' })
          this.deps.onError(`Queued input for ${sessionId} was refused because its terminal attachment changed`)
        } else {
          const result = this.write(input.managed, input.data, input.at)
          input.resolve(result)
          if (result.kind === 'not-writer')
            this.deps.onError(`Queued input for ${sessionId} was refused because its terminal is no longer a writer`)
          else if (result.kind !== 'sent')
            throw new Error(`Unknown terminal write result: ${JSON.stringify(result)}`)
        }
      } catch (error) { input.reject(error) }
    }
  }

  private readonly attachments = new Map<string, ManagedTerminalAttachment>()
  private readonly detachedEarly = new Set<string>()
  private geometryOrder = 0

  private readonly deps: TerminalGatewayDeps

  constructor(deps: TerminalGatewayDeps) {
    this.deps = deps
  }

  async attach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): Promise<TerminalAttachResult> {
    if (this.detachedEarly.delete(attachId)) return { ok: true }
    if (this.deps.descriptorOf() === null)
      return { ok: false, code: 'host-unreachable', detail: 'no Host descriptor is published' }
    const resolution = this.refOf(spec.sessionId)
    if (!resolution.ok) {
      if (resolution.code === 'unknown-session')
        return { ok: false, code: 'unknown-session', detail: `no session ${spec.sessionId}` }
      else if (resolution.code === 'not-live')
        return { ok: false, code: 'not-live', detail: `session ${spec.sessionId} has no live runtime` }
      else
        throw new Error(`Unknown terminal ref refusal: ${JSON.stringify(resolution)}`)
    }

    if (this.attachments.has(attachId)) this.detach(attachId)
    const attachment = new TerminalAttachment({
      sessionId: spec.sessionId,
      descriptorOf: this.deps.descriptorOf,
      leaseIdOf: this.deps.leaseIdOf,
      refOf: this.refOf,
      onFrame: frame => {
        const managed = this.attachments.get(attachId)
        if (managed?.attachment === attachment && frame.type === 'terminal.status')
          this.refuseQueued(managed, { kind: 'not-writer' })
        owner.onFrame(frame)
      },
      onError: this.deps.onError,
      onEnded: () => {
        const managed = this.attachments.get(attachId)
        if (managed?.attachment !== attachment) return
        this.attachments.delete(attachId)
        this.refuseQueued(managed, { kind: 'unknown-attach' })
        this.reconcileGeometry(spec.sessionId)
      },
      socketFactory: this.deps.socketFactory,
      snapshotFlow: owner.snapshotFlow,
    })
    this.attachments.set(attachId, {
      attachment,
      sessionId: spec.sessionId,
      source: owner.source,
      windowId: owner.windowId,
      wantedSize: spec.size,
      geometryActive: spec.size !== null,
      geometryOrder: spec.size === null ? 0 : ++this.geometryOrder,
    })
    this.reconcileGeometry(spec.sessionId)
    attachment.start()
    return { ok: true }
  }

  async input(attachId: string, data: string): Promise<TerminalInputResult> {
    const at = Date.now()
    const managed = this.attachments.get(attachId)
    if (!managed) return { kind: 'unknown-attach' }
    const held = this.controls.get(managed.sessionId)
    if (held !== undefined && (held.holders > 0 || held.transaction !== null)) {
      if (!managed.attachment.acceptsInput()) return { kind: 'not-writer' }
      return new Promise((resolve, reject) => {
        held.queued.push({ attachId, managed, generation: managed.attachment.inputGeneration(), data, at, resolve, reject })
        this.queueHint()
      })
    }
    return this.write(managed, data, at)
  }

  private write(managed: ManagedTerminalAttachment, data: string, at = Date.now()): TerminalInputResult {
    if (!managed.attachment.input(data)) return { kind: 'not-writer' }
    if (TerminalInputActivity.isUserInput(data)) this.noteInput(managed.sessionId, at)
    return { kind: 'sent' }
  }

  async resize(attachId: string, cols: number, rows: number): Promise<TerminalResizeResult> {
    const managed = this.attachments.get(attachId)
    if (!managed) return { kind: 'unknown-attach' }
    managed.wantedSize = { cols, rows }
    managed.geometryActive = true
    managed.geometryOrder = ++this.geometryOrder
    const owner = this.geometryOwnerOf(managed.sessionId)
    this.reconcileGeometry(managed.sessionId)
    return owner?.attachment === managed.attachment ? { kind: 'applied' } : { kind: 'ignored' }
  }

  async setGeometryActive(attachId: string, active: boolean): Promise<TerminalResizeResult> {
    const managed = this.attachments.get(attachId)
    if (!managed) return { kind: 'unknown-attach' }
    managed.geometryActive = active && managed.wantedSize !== null
    if (managed.geometryActive)
      managed.geometryOrder = ++this.geometryOrder
    const owner = this.geometryOwnerOf(managed.sessionId)
    this.reconcileGeometry(managed.sessionId)
    return owner?.attachment === managed.attachment ? { kind: 'applied' } : { kind: 'ignored' }
  }

  detach(attachId: string): void {
    const managed = this.attachments.get(attachId)
    if (managed) {
      this.attachments.delete(attachId)
      this.refuseQueued(managed, { kind: 'unknown-attach' })
      managed.attachment.dispose()
      this.reconcileGeometry(managed.sessionId)
      return
    }
    if (this.detachedEarly.size >= TerminalGateway.earlyDetachLimitConst) {
      const oldest = this.detachedEarly.values().next()
      if (!oldest.done) this.detachedEarly.delete(oldest.value)
    }
    this.detachedEarly.add(attachId)
  }

  private refuseQueued(managed: ManagedTerminalAttachment, result: Exclude<TerminalInputResult, { kind: 'sent' }>): void {
    const control = this.controls.get(managed.sessionId)
    if (control === undefined) return
    const refused = control.queued.filter(input => input.managed === managed)
    if (refused.length === 0) return
    control.queued = control.queued.filter(input => input.managed !== managed)
    this.queueHint()
    for (const input of refused) input.resolve(result)
    if (result.kind === 'unknown-attach')
      this.deps.onError(`Queued input for ${managed.sessionId} was refused because its terminal attachment changed`)
    else if (result.kind === 'not-writer')
      this.deps.onError(`Queued input for ${managed.sessionId} was refused because its terminal is no longer a writer`)
    else throw new Error(`Unknown queued input refusal: ${JSON.stringify(result)}`)
  }

  /** The controller lease is held under a new id: every read-only attach that asked to write asks again. */
  leaseChanged(): void {
    for (const managed of [...this.attachments.values()]) managed.attachment.leaseChanged()
  }

  detachAll(attachIds: readonly string[]): void {
    for (const attachId of attachIds) this.detach(attachId)
  }

  closeAll(): void {
    this.flushMarks(true)
    this.detachAll([...this.attachments.keys()])
    if (this.hintTimer !== null) clearTimeout(this.hintTimer)
    this.hintTimer = null
    this.inputTimes.clear()
    this.deps.activity.pendingInputHint(new Map())
    this.detachedEarly.clear()
  }

  /**
   * How many attachments this gateway is holding. Named for what it counts, because the wire has a
   * `liveCount` of its own that means live RUNTIMES, and the two are not the same number: the
   * snapshot's comes from the Host's runtimes, this one from surfaces.
   *
   * Nothing in the product reads it. It stays because it is the one way a test can ask whether an
   * attach was let go of, which is the invariant most of this class exists to hold.
   */
  attachmentCount(): number {
    return this.attachments.size
  }

  private noteInput(sessionId: string, at: number): void {
    const now = Date.now()
    const previous = this.inputTimes.get(sessionId)
    const immediate = previous === undefined || at - previous.lastInput >= 5_000 || now - previous.lastMark >= 1_000
    this.inputTimes.set(sessionId, { lastInput: at, lastMark: immediate ? now : previous.lastMark })
    if (immediate) {
      this.marks.delete(sessionId)
      this.deps.activity.userInput([{ sessionId, at }])
    } else this.marks.set(sessionId, at)
    this.scheduleMarks()
  }

  private scheduleMarks(): void {
    if (this.markTimer !== null || this.marks.size === 0) return
    const due = Math.min(...[...this.marks.keys()].map(id => this.inputTimes.get(id)!.lastMark + 1_000))
    this.markTimer = setTimeout(() => this.flushMarks(), Math.max(0, due - Date.now()))
    this.markTimer.unref()
  }

  private flushMarks(all = false): void {
    if (this.markTimer !== null) clearTimeout(this.markTimer)
    this.markTimer = null
    const now = Date.now()
    const marks: { sessionId: string; at: number }[] = []
    for (const [sessionId, at] of this.marks) {
      const times = this.inputTimes.get(sessionId)
      if (times === undefined || (!all && now - times.lastMark < 1_000)) continue
      times.lastMark = now
      marks.push({ sessionId, at })
      this.marks.delete(sessionId)
    }
    if (marks.length > 0) this.deps.activity.userInput(marks)
    this.scheduleMarks()
  }

  private queueHint(): void {
    if (this.hintTimer !== null) return
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null
      this.deps.activity.pendingInputHint(new Map([...this.controls].map(([id, control]) => [id, control.queued.length])))
    }, 0)
    this.hintTimer.unref()
  }

  private reconcileGeometry(sessionId: string): void {
    const owner = this.geometryOwnerOf(sessionId)
    for (const managed of this.attachments.values())
      if (managed.sessionId === sessionId)
        managed.attachment.setGeometry(
          managed.attachment === owner?.attachment ? managed.wantedSize : null,
        )
  }

  private geometryOwnerOf(sessionId: string): ManagedTerminalAttachment | null {
    let selected: ManagedTerminalAttachment | null = null
    for (const managed of this.attachments.values()) {
      if (managed.sessionId !== sessionId
        || !managed.geometryActive
        || managed.wantedSize === null)
        continue
      if (selected === null) {
        selected = managed
        continue
      }
      const priority = TerminalGateway.sourcePriority(managed.source)
      const selectedPriority = TerminalGateway.sourcePriority(selected.source)
      if (priority > selectedPriority
        || (priority === selectedPriority && managed.geometryOrder > selected.geometryOrder))
        selected = managed
    }
    return selected
  }

  private static sourcePriority(source: TerminalAttachSource): number {
    if (source === 'local') return 2
    else if (source === 'remote') return 1
    else throw new Error(`Unknown terminal attach source: ${JSON.stringify(source)}`)
  }
}
