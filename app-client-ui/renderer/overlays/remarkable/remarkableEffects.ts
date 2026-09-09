import type {
  AppClientUiBridge,
  IpcResult,
} from '../../../shared/appClientUiIpc'
import type {
  RemarkableOpenDocumentPages,
  RemarkablePagePreview,
  RemarkableRenderedPage,
  RemarkableRenderTarget,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import type {
  RemarkableEffect,
  RemarkableInput,
} from './remarkableModel'

export interface RemarkableEffectsPorts {
  dispatch(input: RemarkableInput): void
  insert(path: string): boolean
  close(): void
}

export class RemarkableEffects {
  private disposed = false
  private closed = false
  private started = false
  private operationId: string | null = null
  private released = false

  constructor(
    private readonly bridge: Pick<AppClientUiBridge, 'remarkable'>,
    private readonly ports: RemarkableEffectsPorts,
    /** The terminal this card was opened over: the only thing that says which project it is. */
    private readonly sessionId: string,
  ) {}

  async run(effect: RemarkableEffect): Promise<void> {
    if (this.disposed) return
    if (effect.effect === 'close') {
      this.close()
      return
    }
    if (effect.effect === 'start') return await this.start()
    else if (effect.effect === 'pages') return await this.pages(effect.operationId)
    else if (effect.effect === 'render')
      return await this.render(effect.operationId, effect.target)
    else if (effect.effect === 'insert') return this.insert(effect.path)
    else if (effect.effect === 'save-auto-preview')
      return await this.saveAutoPreview(effect.enabled)
    else if (effect.effect === 'preview')
      return await this.preview(effect.operationId, effect.previewFor, effect.target)
    else throw new Error(`Unknown reMarkable effect: ${JSON.stringify(effect)}`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.release()
  }

  private async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const result = await this.request(
      () => this.bridge.remarkable.startOperation(this.sessionId),
    )
    if (result.ok) this.operationId = result.value.operationId
    if (this.disposed) {
      this.release()
      return
    }
    this.ports.dispatch({ input: 'started', result })
  }

  private async pages(operationId: string): Promise<void> {
    if (this.operationId !== operationId) return
    const result = await this.request<RemarkableOpenDocumentPages>(
      () => this.bridge.remarkable.pages(operationId),
    )
    if (!this.disposed && this.operationId === operationId)
      this.ports.dispatch({ input: 'pages-loaded', result })
  }

  private async render(
    operationId: string,
    target: Parameters<AppClientUiBridge['remarkable']['render']>[1],
  ): Promise<void> {
    if (this.operationId !== operationId) return
    const result = await this.request<RemarkableRenderedPage>(
      () => this.bridge.remarkable.render(operationId, target),
    )
    if (!this.disposed && this.operationId === operationId)
      this.ports.dispatch({ input: 'rendered', result })
  }

  private async preview(
    operationId: string,
    previewFor: string,
    target: RemarkableRenderTarget,
  ): Promise<void> {
    if (this.operationId !== operationId) return
    const result = await this.request<RemarkablePagePreview>(
      () => this.bridge.remarkable.preview(operationId, target),
    )
    if (!this.disposed && this.operationId === operationId)
      this.ports.dispatch({ input: 'previewed', previewFor, result })
  }

  /**
   * Written and forgotten: the card already draws the new state, and a settings write that failed
   * is worth nothing to a user in the middle of importing a page. The next open reads what stuck.
   */
  private async saveAutoPreview(enabled: boolean): Promise<void> {
    await this.request(
      () => this.bridge.remarkable.saveImport({ autoPreviewOnOpen: enabled }),
    )
  }

  private insert(path: string): void {
    let inserted = false
    try { inserted = this.ports.insert(path) }
    catch { inserted = false }
    if (!this.disposed) this.ports.dispatch({ input: 'inserted', inserted })
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.dispose()
    this.ports.close()
  }

  private release(): void {
    if (this.operationId === null || this.released) return
    this.released = true
    void this.bridge.remarkable.release(this.operationId).catch(() => undefined)
  }

  private async request<T>(
    call: () => Promise<IpcResult<RemarkableResult<T>>>,
  ): Promise<RemarkableResult<T>> {
    try {
      const answer = await call()
      if (answer.ok) return answer.value
      return RemarkableEffects.transportFailure(answer.error)
    } catch {
      return RemarkableEffects.transportFailure('The main process did not answer')
    }
  }

  private static transportFailure<T>(detail: string): RemarkableResult<T> {
    return { ok: false, code: 'cli-failed', detail, retryable: false }
  }
}
