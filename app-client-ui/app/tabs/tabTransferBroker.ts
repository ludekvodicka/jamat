import type { TabTransferLease, TabTransferPayload } from '../../shared/tabTransfer'
import type { WorkspaceWindows } from '../shell/workspaceWindows'
import type { WorkspacePanelIndex } from './workspacePanelIndex'

type PendingTransfer =
  | {
      phase: 'registered'
      sourceWindowId: string
      panel: TabTransferPayload
      sourceGone: false
      expiresAt: number
    }
  | {
      phase: 'prepared'
      sourceWindowId: string
      targetWindowId: string
      panel: TabTransferPayload
      sourceGone: boolean
      expiresAt: number
    }

interface TokenWaiter {
  release(): void
}

export class TabTransferBroker {
  private static readonly tokenWaitMillisecondsConst = 2_000
  private static readonly tokenTtlMillisecondsConst = 30_000

  private readonly pending = new Map<string, PendingTransfer>()
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly tokenWaiters = new Map<string, Set<TokenWaiter>>()

  constructor(
    private readonly windows: WorkspaceWindows,
    private readonly index: WorkspacePanelIndex,
  ) {}

  start(token: string, panel: TabTransferPayload, sourceWindowId: string): void {
    if (token.length === 0)
      throw new Error('A tab transfer token cannot be empty')
    if (!this.windows.acceptsWindow(sourceWindowId))
      throw new Error(`The source window is not accepting transfers: ${sourceWindowId}`)
    if (this.livePending(token) !== null)
      throw new Error(`Tab transfer token is already registered: ${token}`)
    const expiresAt = Date.now() + TabTransferBroker.tokenTtlMillisecondsConst
    this.pending.set(token, {
      phase: 'registered',
      sourceWindowId,
      panel: structuredClone(panel),
      sourceGone: false,
      expiresAt,
    })
    const timer = setTimeout(
      () => this.reap(token, expiresAt),
      TabTransferBroker.tokenTtlMillisecondsConst,
    )
    this.expiryTimers.set(token, timer)
    this.releaseWaiters(token)
  }

  async prepare(token: string, targetWindowId: string): Promise<TabTransferLease | null> {
    if (!this.windows.acceptsWindow(targetWindowId))
      return null
    let pending = this.livePending(token)
    if (pending === null) {
      await this.waitForRegistration(token)
      pending = this.livePending(token)
    }
    if (pending === null || pending.phase === 'prepared')
      return null
    if (pending.sourceWindowId === targetWindowId)
      return null
    if (!this.windows.acceptsWindow(targetWindowId))
      return null
    this.pending.set(token, {
      ...pending,
      phase: 'prepared',
      targetWindowId,
    })
    return { token, panel: { ...pending.panel, params: { ...pending.panel.params } } }
  }

  commit(token: string, targetWindowId: string): void {
    const pending = this.requirePrepared(token, targetWindowId)
    if (!this.windows.acceptsWindow(targetWindowId))
      throw new Error(`The target window is not accepting transfers: ${targetWindowId}`)
    const owner = this.index.ownerOf(pending.panel.panelId)
    const sourceIsExpected = pending.sourceGone
      ? owner === null
      : owner === pending.sourceWindowId
    if (!sourceIsExpected)
      throw new Error(`Stale transfer owner: ${JSON.stringify(owner)}`)
    this.index.transfer(pending.sourceWindowId, targetWindowId, pending.panel)
    this.clearPending(token)
    if (!pending.sourceGone)
      this.windows.publishToIfLive(
        pending.sourceWindowId,
        'tabs:transfer-out',
        pending.panel.panelId,
      )
  }

  abort(token: string, targetWindowId: string): void {
    const pending = this.livePending(token)
    if (pending === null)
      return
    if (pending.phase !== 'prepared' || pending.targetWindowId !== targetWindowId)
      throw new Error(`Tab transfer is not prepared for target ${targetWindowId}: ${token}`)
    this.clearPending(token)
  }

  cancelClosingWindow(windowId: string): void {
    for (const [token, pending] of this.pending)
      if (pending.sourceWindowId === windowId
        || (pending.phase === 'prepared' && pending.targetWindowId === windowId))
        this.clearPending(token)
  }

  rendererGone(windowId: string): void {
    for (const [token, pending] of this.pending) {
      if (pending.phase === 'prepared' && pending.sourceWindowId === windowId)
        this.pending.set(token, { ...pending, sourceGone: true })
      else if (pending.sourceWindowId === windowId
        || (pending.phase === 'prepared' && pending.targetWindowId === windowId))
        this.clearPending(token)
    }
  }

  cancelAll(): void {
    for (const token of [...this.pending.keys()])
      this.clearPending(token)
    for (const token of [...this.tokenWaiters.keys()])
      this.releaseWaiters(token)
  }

  private requirePrepared(token: string, targetWindowId: string): Extract<
    PendingTransfer,
    { phase: 'prepared' }
  > {
    const pending = this.livePending(token)
    if (pending === null || pending.phase !== 'prepared'
      || pending.targetWindowId !== targetWindowId)
      throw new Error(`Tab transfer is not prepared for target ${targetWindowId}: ${token}`)
    return pending
  }

  private livePending(token: string): PendingTransfer | null {
    const pending = this.pending.get(token)
    if (!pending)
      return null
    if (pending.expiresAt > Date.now())
      return pending
    this.clearPending(token)
    return null
  }

  private waitForRegistration(token: string): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      const waiter: TokenWaiter = {
        release: () => {
          clearTimeout(timer)
          const waiters = this.tokenWaiters.get(token)
          waiters?.delete(waiter)
          if (waiters?.size === 0)
            this.tokenWaiters.delete(token)
          resolve()
        },
      }
      const waiters = this.tokenWaiters.get(token) ?? new Set<TokenWaiter>()
      waiters.add(waiter)
      this.tokenWaiters.set(token, waiters)
      timer = setTimeout(waiter.release, TabTransferBroker.tokenWaitMillisecondsConst)
    })
  }

  private releaseWaiters(token: string): void {
    for (const waiter of [...(this.tokenWaiters.get(token) ?? [])])
      waiter.release()
  }

  /**
   * The identity check is what makes this safe against a token registered again under the same
   * name; the clock was a second opinion that could disagree. Node may fire a timer a fraction
   * early, and on that tick the comparison refused, the timer was spent, and the entry stayed for
   * the life of the process - once per abandoned drag, and a plain reorder registers one too.
   */
  private reap(token: string, expiresAt: number): void {
    const pending = this.pending.get(token)
    if (pending?.expiresAt === expiresAt)
      this.clearPending(token)
  }

  private clearPending(token: string): void {
    this.pending.delete(token)
    const timer = this.expiryTimers.get(token)
    if (timer)
      clearTimeout(timer)
    this.expiryTimers.delete(token)
  }
}
