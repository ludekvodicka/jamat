import type {
  RemarkableOpenDocumentPages,
  RemarkableOpenedOperation,
  RemarkablePagePreview,
  RemarkableRenderedPage,
  RemarkableRenderTarget,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'

export type RemarkableOverlaySource = 'current' | 'listed-page'
export type RemarkableOverlayPhase =
  | 'starting'
  | 'ready'
  | 'loading-pages'
  | 'rendering'
  | 'failed'
  | 'output-ready'
export type RemarkableFailure = Extract<RemarkableResult<unknown>, { ok: false }>
export type RemarkablePreviewPhase = 'idle' | 'loading' | 'ready' | 'failed'
type RemarkableFailedAction = 'start' | 'pages' | 'render' | null

/** What the preview pane is about: the tablet's own page, or one page of the listed document. */
export const remarkableCurrentPreviewConst = 'current'

export interface RemarkableOverlayState {
  operationId: string | null
  source: RemarkableOverlaySource
  /** Whether the card previews the open page by itself. Saved as soon as it is ticked. */
  autoPreviewOnOpen: boolean
  phase: RemarkableOverlayPhase
  pages: RemarkableOpenDocumentPages | null
  selectedPageId: string | null
  failure: RemarkableFailure | null
  outputPath: string | null
  /**
   * Why this operation is not storing where the settings say, or null when it is. Shown as soon
   * as the operation opens: a page that will land somewhere else is worth saying BEFORE the
   * download, not once the path is already in the terminal.
   */
  storageNote: string | null
  failedAction: RemarkableFailedAction
  /** The confirm that moved the user to the page list, so the card can say why it did. */
  currentPageRefused: boolean
  /** `current` or a page ID: which page the pane is drawing, loading or failed on. */
  previewFor: string | null
  previewPhase: RemarkablePreviewPhase
  preview: RemarkablePagePreview | null
  previewFailure: RemarkableFailure | null
}

export type RemarkableInput =
  | { input: 'started'; result: RemarkableResult<RemarkableOpenedOperation> }
  | { input: 'auto-preview-toggled'; enabled: boolean }
  | { input: 'source-selected'; source: RemarkableOverlaySource }
  | { input: 'pages-loaded'; result: RemarkableResult<RemarkableOpenDocumentPages> }
  | { input: 'page-selected'; pageId: string }
  | { input: 'confirm' }
  | { input: 'rendered'; result: RemarkableResult<RemarkableRenderedPage> }
  | { input: 'inserted'; inserted: boolean }
  | { input: 'retry' }
  | { input: 'preview-requested' }
  | {
    input: 'previewed'
    previewFor: string
    result: RemarkableResult<RemarkablePagePreview>
  }
  | { input: 'close' }

export type RemarkableEffect =
  | { effect: 'start' }
  | { effect: 'pages'; operationId: string }
  | { effect: 'render'; operationId: string; target: RemarkableRenderTarget }
  | { effect: 'insert'; path: string }
  | { effect: 'save-auto-preview'; enabled: boolean }
  | {
    effect: 'preview'
    operationId: string
    previewFor: string
    target: RemarkableRenderTarget
  }
  | { effect: 'close' }

export interface RemarkableStep {
  state: RemarkableOverlayState
  effects: readonly RemarkableEffect[]
}

export class RemarkableModel {
  static initial(): RemarkableStep {
    return {
      state: {
        operationId: null,
        storageNote: null,
        autoPreviewOnOpen: false,
        source: 'current',
        phase: 'starting',
        pages: null,
        selectedPageId: null,
        failure: null,
        outputPath: null,
        failedAction: null,
        currentPageRefused: false,
        previewFor: null,
        previewPhase: 'idle',
        preview: null,
        previewFailure: null,
      },
      effects: [{ effect: 'start' }],
    }
  }

  static transition(state: RemarkableOverlayState, input: RemarkableInput): RemarkableStep {
    if (input.input === 'started') return RemarkableModel.started(state, input.result)
    else if (input.input === 'auto-preview-toggled')
      return RemarkableModel.autoPreviewToggled(state, input.enabled)
    else if (input.input === 'source-selected')
      return RemarkableModel.sourceSelected(state, input.source)
    else if (input.input === 'pages-loaded') return RemarkableModel.pagesLoaded(state, input.result)
    else if (input.input === 'page-selected')
      return RemarkableModel.pageSelected(state, input.pageId)
    else if (input.input === 'confirm') return RemarkableModel.confirmed(state)
    else if (input.input === 'rendered') return RemarkableModel.rendered(state, input.result)
    else if (input.input === 'inserted') return RemarkableModel.inserted(state, input.inserted)
    else if (input.input === 'retry') return RemarkableModel.retried(state)
    else if (input.input === 'preview-requested') return RemarkableModel.previewRequested(state)
    else if (input.input === 'previewed')
      return RemarkableModel.previewed(state, input.previewFor, input.result)
    else if (input.input === 'close') return RemarkableModel.step(state, { effect: 'close' })
    else throw new Error(`Unknown reMarkable input: ${JSON.stringify(input)}`)
  }

  /**
   * Only false once the tablet has told us so. The overlay contacts no device while it opens, so
   * until a page list arrives the current page is assumed usable and the first confirm is what
   * finds out.
   */
  static canUseCurrentPage(state: RemarkableOverlayState): boolean {
    return state.pages === null || state.pages.currentPageNumber !== null
  }

  static canConfirm(state: RemarkableOverlayState): boolean {
    if (state.phase !== 'ready' || state.operationId === null) return false
    if (state.source === 'current') return RemarkableModel.canUseCurrentPage(state)
    else if (state.source === 'listed-page')
      return state.pages !== null && state.selectedPageId !== null
    else throw new Error(`Unknown reMarkable source: ${JSON.stringify(state.source)}`)
  }

  static canRetry(state: RemarkableOverlayState): boolean {
    if (state.phase !== 'failed'
      || state.operationId === null
      || state.failure === null
      || state.failedAction === null
      || state.failedAction === 'start'
      || !state.failure.retryable) return false
    return state.failure.code === 'device-sleeping' || state.failure.code === 'device-busy'
  }

  static canChooseSource(state: RemarkableOverlayState): boolean {
    return state.phase === 'ready'
  }

  private static started(
    state: RemarkableOverlayState,
    result: RemarkableResult<RemarkableOpenedOperation>,
  ): RemarkableStep {
    if (state.phase !== 'starting') return RemarkableModel.step(state)
    if (!result.ok)
      return RemarkableModel.failed(state, 'start', result)
    const next = {
      ...state,
      operationId: result.value.operationId,
      storageNote: result.value.storageNote,
      autoPreviewOnOpen: result.value.autoPreviewOnOpen,
      failure: null,
    }
    if (state.source === 'current') {
      const ready: RemarkableOverlayState = { ...next, phase: 'ready' }
      // The one place the card touches the tablet without being asked, and only because the user
      // said it may. Everything else about the first render is unchanged.
      return next.autoPreviewOnOpen
        ? RemarkableModel.previewStep(ready, remarkableCurrentPreviewConst, { kind: 'current' })
        : RemarkableModel.step(ready)
    }
    else if (state.source === 'listed-page')
      return RemarkableModel.step(
        { ...next, phase: 'loading-pages' },
        { effect: 'pages', operationId: result.value.operationId },
      )
    else throw new Error(`Unknown reMarkable source: ${JSON.stringify(state.source)}`)
  }

  private static sourceSelected(
    state: RemarkableOverlayState,
    source: RemarkableOverlaySource,
  ): RemarkableStep {
    if (!RemarkableModel.canChooseSource(state) || state.source === source)
      return RemarkableModel.step(state)
    if (source === 'current')
      return RemarkableModel.canUseCurrentPage(state)
        ? RemarkableModel.step(RemarkableModel.previewCleared({ ...state, source }))
        : RemarkableModel.step(state)
    else if (source === 'listed-page') {
      if (state.pages !== null)
        return RemarkableModel.previewing({ ...state, source }, state.selectedPageId)
      if (state.operationId === null) return RemarkableModel.step({ ...state, source })
      return RemarkableModel.step(
        RemarkableModel.previewCleared(
          { ...state, source, phase: 'loading-pages', failure: null },
        ),
        { effect: 'pages', operationId: state.operationId },
      )
    } else throw new Error(`Unknown reMarkable source: ${JSON.stringify(source)}`)
  }

  private static pagesLoaded(
    state: RemarkableOverlayState,
    result: RemarkableResult<RemarkableOpenDocumentPages>,
  ): RemarkableStep {
    if (state.phase !== 'loading-pages' || state.source !== 'listed-page')
      return RemarkableModel.step(state)
    if (!result.ok) return RemarkableModel.failed(state, 'pages', result)
    const current = result.value.pages.find((page) => page.number === result.value.currentPageNumber)
    const selectedPageId = current?.pageId ?? null
    return RemarkableModel.previewing({
      ...state,
      phase: 'ready',
      pages: result.value,
      selectedPageId,
      failure: null,
      failedAction: null,
    }, selectedPageId)
  }

  /**
   * Listing a document downloads its archive, so every page of it renders locally from then on.
   * That is what makes an automatic preview affordable here and a deliberate one for `current`,
   * which has to ask the tablet.
   */
  private static previewing(
    state: RemarkableOverlayState,
    pageId: string | null,
  ): RemarkableStep {
    if (pageId === null || state.operationId === null)
      return RemarkableModel.step(RemarkableModel.previewCleared(state))
    return RemarkableModel.previewStep(state, pageId, { kind: 'listed-page', pageId })
  }

  private static previewCleared(state: RemarkableOverlayState): RemarkableOverlayState {
    return { ...state, previewFor: null, previewPhase: 'idle', preview: null, previewFailure: null }
  }

  private static previewStep(
    state: RemarkableOverlayState,
    previewFor: string,
    target: RemarkableRenderTarget,
  ): RemarkableStep {
    if (state.operationId === null) return RemarkableModel.step(state)
    return RemarkableModel.step(
      {
        ...state,
        previewFor,
        previewPhase: 'loading',
        preview: null,
        previewFailure: null,
      },
      { effect: 'preview', operationId: state.operationId, previewFor, target },
    )
  }

  /**
   * The button behind both the first preview of the tablet's own page and every retry: a preview
   * spends nothing, so a failed one is always worth offering again. It also drops the sentence
   * about a refused current page - that explained an earlier move, not this attempt.
   */
  /**
   * Ticking it on also previews, when the pane is showing nothing yet: the user turned on "do it
   * for me" and would otherwise have to press the button once more to see it happen this time.
   */
  private static autoPreviewToggled(
    state: RemarkableOverlayState,
    enabled: boolean,
  ): RemarkableStep {
    if (state.autoPreviewOnOpen === enabled) return RemarkableModel.step(state)
    const next = { ...state, autoPreviewOnOpen: enabled }
    const save: RemarkableEffect = { effect: 'save-auto-preview', enabled }
    if (!enabled || state.previewPhase !== 'idle' || state.source !== 'current'
      || !RemarkableModel.canUseCurrentPage(state)
      || state.phase !== 'ready'
      || state.operationId === null)
      return RemarkableModel.step(next, save)
    const previewed = RemarkableModel.previewStep(
      next,
      remarkableCurrentPreviewConst,
      { kind: 'current' },
    )
    return { state: previewed.state, effects: [save, ...previewed.effects] }
  }

  private static previewRequested(state: RemarkableOverlayState): RemarkableStep {
    if (state.phase !== 'ready'
      || state.operationId === null
      || state.previewPhase === 'loading')
      return RemarkableModel.step(state)
    const asked = { ...state, currentPageRefused: false }
    if (state.source === 'current') {
      if (!RemarkableModel.canUseCurrentPage(state)) return RemarkableModel.step(state)
      return RemarkableModel.previewStep(
        asked,
        remarkableCurrentPreviewConst,
        { kind: 'current' },
      )
    } else if (state.source === 'listed-page') {
      const pageId = state.selectedPageId
      if (pageId === null) return RemarkableModel.step(state)
      return RemarkableModel.previewStep(asked, pageId, { kind: 'listed-page', pageId })
    } else throw new Error(`Unknown reMarkable source: ${JSON.stringify(state.source)}`)
  }

  /** Late answers are dropped: the pane always draws the page the user is looking at now. */
  private static previewed(
    state: RemarkableOverlayState,
    previewFor: string,
    result: RemarkableResult<RemarkablePagePreview>,
  ): RemarkableStep {
    if (state.previewFor !== previewFor || state.previewPhase !== 'loading')
      return RemarkableModel.step(state)
    if (!result.ok)
      return RemarkableModel.step({
        ...state,
        previewPhase: 'failed',
        preview: null,
        previewFailure: result,
      })
    return RemarkableModel.step({
      ...state,
      previewPhase: 'ready',
      preview: result.value,
      previewFailure: null,
    })
  }

  private static currentPageUnavailable(
    state: RemarkableOverlayState,
    operationId: string,
  ): RemarkableStep {
    const next = RemarkableModel.previewCleared({
      ...state,
      source: 'listed-page',
      failure: null,
      failedAction: null,
      outputPath: null,
      currentPageRefused: true,
    })
    if (state.pages !== null)
      return RemarkableModel.previewing({ ...next, phase: 'ready' }, next.selectedPageId)
    return RemarkableModel.step(
      { ...next, phase: 'loading-pages' },
      { effect: 'pages', operationId },
    )
  }

  private static pageSelected(state: RemarkableOverlayState, pageId: string): RemarkableStep {
    if (state.phase !== 'ready'
      || state.source !== 'listed-page'
      || state.pages === null
      || !state.pages.pages.some((page) => page.pageId === pageId))
      return RemarkableModel.step(state)
    return RemarkableModel.previewing({ ...state, selectedPageId: pageId }, pageId)
  }

  private static confirmed(state: RemarkableOverlayState): RemarkableStep {
    if (!RemarkableModel.canConfirm(state) || state.operationId === null)
      return RemarkableModel.step(state)
    const target = RemarkableModel.targetOf(state)
    return RemarkableModel.step(
      {
        ...state,
        phase: 'rendering',
        failure: null,
        outputPath: null,
        failedAction: null,
        currentPageRefused: false,
      },
      { effect: 'render', operationId: state.operationId, target },
    )
  }

  private static rendered(
    state: RemarkableOverlayState,
    result: RemarkableResult<RemarkableRenderedPage>,
  ): RemarkableStep {
    if (state.phase !== 'rendering') return RemarkableModel.step(state)
    // A document IS open, so this is not a dead end: the pages are still listable, only the tablet's
    // idea of a current page is missing. Move the user to the choice that still works rather than
    // showing an error they can do nothing about.
    if (!result.ok && result.code === 'no-open-page' && state.operationId !== null)
      return RemarkableModel.currentPageUnavailable(state, state.operationId)
    if (!result.ok) return RemarkableModel.failed(state, 'render', result)
    return RemarkableModel.step(
      {
        ...state,
        phase: 'output-ready',
        failure: null,
        failedAction: null,
        outputPath: result.value.outputPath,
      },
      { effect: 'insert', path: result.value.insertText },
    )
  }

  private static inserted(state: RemarkableOverlayState, inserted: boolean): RemarkableStep {
    if (state.phase !== 'output-ready' || state.outputPath === null)
      return RemarkableModel.step(state)
    return RemarkableModel.step(state, ...(inserted ? [{ effect: 'close' } as const] : []))
  }

  private static retried(state: RemarkableOverlayState): RemarkableStep {
    if (!RemarkableModel.canRetry(state) || state.operationId === null)
      return RemarkableModel.step(state)
    if (state.failedAction === 'pages')
      return RemarkableModel.step(
        { ...state, phase: 'loading-pages', failure: null },
        { effect: 'pages', operationId: state.operationId },
      )
    else if (state.failedAction === 'render')
      return RemarkableModel.step(
        { ...state, phase: 'rendering', failure: null },
        { effect: 'render', operationId: state.operationId, target: RemarkableModel.targetOf(state) },
      )
    else if (state.failedAction === 'start' || state.failedAction === null)
      return RemarkableModel.step(state)
    else throw new Error(`Unknown failed reMarkable action: ${JSON.stringify(state.failedAction)}`)
  }

  private static targetOf(state: RemarkableOverlayState): RemarkableRenderTarget {
    if (state.source === 'current') return { kind: 'current' }
    else if (state.source === 'listed-page' && state.selectedPageId !== null)
      return { kind: 'listed-page', pageId: state.selectedPageId }
    else if (state.source === 'listed-page')
      throw new Error('A listed reMarkable page target requires a selected page ID')
    else throw new Error(`Unknown reMarkable source: ${JSON.stringify(state.source)}`)
  }

  private static failed(
    state: RemarkableOverlayState,
    failedAction: Exclude<RemarkableFailedAction, null>,
    failure: RemarkableFailure,
  ): RemarkableStep {
    return RemarkableModel.step({
      ...state,
      phase: 'failed',
      failure,
      failedAction,
      outputPath: null,
    })
  }

  private static step(
    state: RemarkableOverlayState,
    ...effects: readonly RemarkableEffect[]
  ): RemarkableStep {
    return { state, effects }
  }
}
