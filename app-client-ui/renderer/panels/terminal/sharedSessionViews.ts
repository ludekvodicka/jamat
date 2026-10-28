import type { IpcResult } from '../../../shared/appClientUiIpc'
import { sessionOpenPageSchema, type SessionOpen, type SessionOpenCursor, type SessionOpenPage } from '../../../shared/sessionViewItems'
import { SessionWorkspaceKeys, type SessionTarget } from '../../../shared/sessionWorkspace'
import { TerminalTargetCodec } from '../../../shared/terminalTarget'
import { IpcSnapshotReader } from '../../ipc/ipcSnapshotReader'
import { PanelSplitParams, type PanelSplitItem } from '../../widgets/tabs/panelSplit'

export interface SharedSessionViewPorts {
  read(cursor: SessionOpenCursor): Promise<IpcResult<SessionOpenPage>>
  subscribe(changed: () => void): () => void
}
interface Consumption { epoch: string | null; through: number; seen: string[]; overflow: SessionOpen[] }

export class SharedSessionViews {
  private readonly target: SessionTarget
  private readonly ports: SharedSessionViewPorts
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  private readonly apply: (item: PanelSplitItem) => string | null
  private readonly changed: (overflow: readonly SessionOpen[]) => void
  private readonly report: (detail: string) => void

  constructor(target: SessionTarget, ports: SharedSessionViewPorts, storage: Pick<Storage, 'getItem' | 'setItem'>,
    apply: (item: PanelSplitItem) => string | null, changed: (overflow: readonly SessionOpen[]) => void, report: (detail: string) => void) {
    this.target = target; this.ports = ports; this.storage = storage; this.apply = apply; this.changed = changed; this.report = report
  }

  start(): () => void {
    try { this.changed(this.state().overflow) }
    catch (error) { this.report(String(error)); return () => {} }
    const reader = new IpcSnapshotReader({ subject: 'Shared session opens', read: () => this.read(),
      subscribe: this.ports.subscribe, reportError: this.report }, (pages) => this.accept(pages), () => {})
    return reader.start()
  }

  openPending(openId: string): void {
    try {
    const state = this.state()
    const entry = state.overflow.find((item) => item.openId === openId)
    if (!entry) return
    const refusal = this.apply(SharedSessionViews.item(this.target, entry))
    if (refusal) { this.report(refusal); return }
    state.overflow = state.overflow.filter((item) => item.openId !== openId)
    this.save(state)
    this.changed(state.overflow)
    } catch (error) { this.report(String(error)) }
  }

  static consumed(target: SessionTarget, openId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): boolean {
    return SharedSessionViews.load(storage, SharedSessionViews.key(target)).seen.includes(openId)
  }

  static remember(target: SessionTarget, openId: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): void {
    const key = SharedSessionViews.key(target)
    const state = SharedSessionViews.load(storage, key)
    if (!state.seen.includes(openId)) state.seen.push(openId)
    storage.setItem(key, JSON.stringify(state))
  }

  private async read(): Promise<IpcResult<SessionOpenPage[]>> {
    try {
      const pages: SessionOpenPage[] = []
      let cursor: SessionOpenCursor = { after: 0 }
      let count = 0
      for (;;) {
        const result = await this.ports.read(cursor)
        if (!result.ok) return result
        const page = sessionOpenPageSchema.parse(result.value)
        if (page.after !== cursor.after || cursor.epoch !== undefined && (page.epoch !== cursor.epoch || page.revision !== cursor.revision))
          throw new Error('Shared catalog changed during paging')
        let previous = page.after
        for (const item of page.items) {
          if (item.sessionId !== this.target.sessionId || item.sequence <= previous || item.sequence > page.revision)
            throw new Error('Invalid shared catalog item order or ownership')
          previous = item.sequence
        }
        if (page.next !== null && (page.next !== previous || page.next <= page.after)) throw new Error('Invalid shared catalog continuation')
        count += page.items.length
        if (count > 65536) throw new Error('Shared catalog exceeds its receipt bound')
        pages.push(page)
        if (page.next === null) return { ok: true, value: pages }
        cursor = { after: page.next, epoch: page.epoch, revision: page.revision }
      }
    } catch (error) { return { ok: false, error: String(error) } }
  }

  private accept(pages: SessionOpenPage[]): void {
    const first = pages[0]
    if (!first) return
    const state = this.state()
    if (state.epoch !== first.epoch) { state.epoch = first.epoch; state.through = 0 }
    const incoming = pages.flatMap((page) => page.items).filter((item) => item.sequence > state.through && !state.seen.includes(item.openId))
    // Consumption is saved before projection, so a reload during a render cannot reopen a dismissal.
    state.through = first.revision
    for (const item of incoming) state.seen.push(item.openId)
    state.overflow.push(...incoming.filter((item) => !state.overflow.some((held) => held.openId === item.openId)))
    this.save(state)
    const pending: SessionOpen[] = []
    for (const item of state.overflow) {
      if (!incoming.some((entry) => entry.openId === item.openId) || this.apply(SharedSessionViews.item(this.target, item))) pending.push(item)
    }
    state.overflow = pending
    this.save(state)
    this.changed(pending)
  }

  private state(): Consumption { return SharedSessionViews.load(this.storage, SharedSessionViews.key(this.target)) }
  private save(state: Consumption): void { this.storage.setItem(SharedSessionViews.key(this.target), JSON.stringify(state)) }
  private static key(target: SessionTarget): string { return `session-shared-opens:${TerminalTargetCodec.key(target)}` }
  private static load(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string): Consumption {
    const raw = storage.getItem(key)
    if (!raw) return { epoch: null, through: 0, seen: [], overflow: [] }
    const value = JSON.parse(raw) as Consumption
    if ((typeof value.epoch !== 'string' && value.epoch !== null) || !Number.isSafeInteger(value.through) || value.through < 0
      || !Array.isArray(value.seen) || value.seen.some((id) => typeof id !== 'string') || !Array.isArray(value.overflow))
      throw new Error('Shared open consumption state is unreadable')
    for (const entry of value.overflow) sessionOpenPageSchema.shape.items.element.parse(entry)
    return value
  }

  static item(target: SessionTarget, open: SessionOpen): PanelSplitItem {
    const key = target.kind === 'remote' ? SessionWorkspaceKeys.of(target, open.key) : open.key
    const common = { target, key, title: open.title }
    if (open.item.kind === 'file') return { ...common, kind: 'file', source: open.item.source }
    else if (open.item.kind === 'review') return { ...common, kind: 'commit', reviewId: open.item.reviewId, openId: open.openId, vcs: open.item.vcs, scopeRoot: open.item.scopeRoot }
    else if (open.item.kind === 'task') return { ...common, kind: 'task', sessionId: open.sessionId, task: open.item.task }
    else if (open.item.kind === 'workflow') return PanelSplitParams.workflowItemOf(open.sessionId, target)
    else throw new Error(`Unknown shared item: ${JSON.stringify(open.item)}`)
  }
}
