import type { HostDescriptor } from '../../../app-host/app/wire/hostWire.js'
import type {
  TerminalAttachResult,
  TerminalAttachSpec,
  TerminalFrame,
} from '../sessionManagerApi.types'
import {
  TerminalAttachment,
  type TerminalRefResolution,
  type TerminalSocketFactory,
} from './terminalAttachment'

export type TerminalAttachSource = 'local' | 'remote'

export interface TerminalAttachOwner {
  source: TerminalAttachSource
  onFrame(frame: TerminalFrame): void
}

export type TerminalInputResult =
  | { kind: 'sent' }
  | { kind: 'not-writer' }
  | { kind: 'unknown-attach' }

export type TerminalResizeResult =
  | { kind: 'applied' }
  | { kind: 'ignored' }
  | { kind: 'unknown-attach' }

export interface TerminalGatewayDeps {
  descriptorOf: () => HostDescriptor | null
  leaseIdOf: () => string | null
  refOf: (sessionId: string) => TerminalRefResolution
  onError: (message: string) => void
  socketFactory: TerminalSocketFactory
}

interface ManagedTerminalAttachment {
  attachment: TerminalAttachment
  sessionId: string
  source: TerminalAttachSource
  wantedSize: { cols: number; rows: number } | null
  geometryActive: boolean
  geometryOrder: number
}

export class TerminalGateway {
  private static readonly earlyDetachLimitConst = 64

  private readonly attachments = new Map<string, ManagedTerminalAttachment>()
  private readonly detachedEarly = new Set<string>()
  private geometryOrder = 0

  constructor(private readonly deps: TerminalGatewayDeps) {}

  attach(
    attachId: string,
    spec: TerminalAttachSpec,
    owner: TerminalAttachOwner,
  ): TerminalAttachResult {
    if (this.detachedEarly.delete(attachId)) return { ok: true }
    if (this.deps.descriptorOf() === null)
      return { ok: false, code: 'host-unreachable', detail: 'no Host descriptor is published' }
    const resolution = this.deps.refOf(spec.sessionId)
    if (!resolution.ok) {
      if (resolution.code === 'unknown-session')
        return { ok: false, code: 'unknown-session', detail: `no session ${spec.sessionId}` }
      else if (resolution.code === 'not-live')
        return { ok: false, code: 'not-live', detail: `session ${spec.sessionId} has no live runtime` }
      else
        throw new Error(`Unknown terminal ref refusal: ${JSON.stringify(resolution)}`)
    }

    const previous = this.attachments.get(attachId)
    if (previous) {
      this.attachments.delete(attachId)
      previous.attachment.dispose()
      this.reconcileGeometry(previous.sessionId)
    }
    const attachment = new TerminalAttachment({
      sessionId: spec.sessionId,
      descriptorOf: this.deps.descriptorOf,
      leaseIdOf: this.deps.leaseIdOf,
      refOf: this.deps.refOf,
      onFrame: owner.onFrame,
      onError: this.deps.onError,
      onEnded: () => {
        if (this.attachments.get(attachId)?.attachment !== attachment)
          return
        this.attachments.delete(attachId)
        this.reconcileGeometry(spec.sessionId)
      },
      socketFactory: this.deps.socketFactory,
    })
    this.attachments.set(attachId, {
      attachment,
      sessionId: spec.sessionId,
      source: owner.source,
      wantedSize: spec.size,
      geometryActive: spec.size !== null,
      geometryOrder: spec.size === null ? 0 : ++this.geometryOrder,
    })
    this.reconcileGeometry(spec.sessionId)
    attachment.start()
    return { ok: true }
  }

  input(attachId: string, data: string): TerminalInputResult {
    const managed = this.attachments.get(attachId)
    if (!managed) return { kind: 'unknown-attach' }
    return managed.attachment.input(data) ? { kind: 'sent' } : { kind: 'not-writer' }
  }

  resize(attachId: string, cols: number, rows: number): TerminalResizeResult {
    const managed = this.attachments.get(attachId)
    if (!managed) return { kind: 'unknown-attach' }
    managed.wantedSize = { cols, rows }
    managed.geometryActive = true
    managed.geometryOrder = ++this.geometryOrder
    const owner = this.geometryOwnerOf(managed.sessionId)
    this.reconcileGeometry(managed.sessionId)
    return owner?.attachment === managed.attachment ? { kind: 'applied' } : { kind: 'ignored' }
  }

  setGeometryActive(attachId: string, active: boolean): TerminalResizeResult {
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

  detachAll(attachIds: readonly string[]): void {
    for (const attachId of attachIds) this.detach(attachId)
  }

  closeAll(): void {
    const attachments = [...this.attachments.values()]
    this.attachments.clear()
    for (const managed of attachments) managed.attachment.dispose()
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
