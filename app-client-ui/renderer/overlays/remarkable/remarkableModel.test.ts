import { describe, expect, it } from 'vitest'

import type {
  RemarkableErrorCode,
  RemarkableOpenDocumentPages,
  RemarkablePagePreview,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import {
  type RemarkableEffect,
  type RemarkableInput,
  RemarkableModel,
  type RemarkableOverlayState,
} from './remarkableModel'

describe('app-client-ui/renderer/overlays/remarkable/remarkableModel', () => {
  const pagesConst: RemarkableOpenDocumentPages = {
    operationId: 'operation-1',
    documentName: 'Architecture notes',
    currentPageNumber: 2,
    pages: [
      { pageId: 'page-a', number: 1, template: null, modified: false },
      { pageId: 'page-b', number: 2, template: 'Grid', modified: true },
      { pageId: 'page-c', number: 3, template: null, modified: false },
    ],
  }

  const previewConst: RemarkablePagePreview = {
    pngBase64: 'iVBORw0KGgo=',
    width: 360,
    height: 480,
    pageNumber: 2,
  }

  class Run {
    private constructor(
      readonly state: RemarkableOverlayState,
      readonly effects: readonly RemarkableEffect[],
    ) {}

    static initial(): Run {
      const step = RemarkableModel.initial()
      return new Run(step.state, step.effects)
    }

    static ready(): Run {
      return Run.initial().then({
        input: 'started',
        result: { ok: true, value: { operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: false } },
      })
    }

    then(...inputs: readonly RemarkableInput[]): Run {
      let state = this.state
      let effects: readonly RemarkableEffect[] = []
      for (const input of inputs) {
        const step = RemarkableModel.transition(state, input)
        state = step.state
        effects = step.effects
      }
      return new Run(state, effects)
    }
  }

  function failure(
    code: RemarkableErrorCode,
    retryable = true,
  ): Extract<RemarkableResult<never>, { ok: false }> {
    return { ok: false, code, detail: `failure: ${code}`, retryable }
  }

  it('starts on current page without listing the open document', () => {
    const initial = Run.initial()

    expect(initial.state.phase).toBe('starting')
    expect(initial.state.source).toBe('current')
    expect(initial.effects).toEqual([{ effect: 'start' }])

    const confirmed = initial
      .then({ input: 'started', result: { ok: true, value: { operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: false } } })
      .then({ input: 'confirm' })

    expect(confirmed.state.phase).toBe('rendering')
    expect(confirmed.effects).toEqual([{
      effect: 'render',
      operationId: 'operation-1',
      target: { kind: 'current' },
    }])
  })

  it('lists once, preselects the current page and renders its explicit page ID', () => {
    const listing = Run.ready().then({ input: 'source-selected', source: 'listed-page' })

    expect(listing.state.phase).toBe('loading-pages')
    expect(listing.effects).toEqual([{ effect: 'pages', operationId: 'operation-1' }])

    const loaded = listing.then({ input: 'pages-loaded', result: { ok: true, value: pagesConst } })
    expect(loaded.state.pages).toBe(pagesConst)
    expect(loaded.state.selectedPageId).toBe('page-b')

    const confirmed = loaded
      .then({ input: 'page-selected', pageId: 'page-c' })
      .then({ input: 'confirm' })
    expect(confirmed.effects).toEqual([{
      effect: 'render',
      operationId: 'operation-1',
      target: { kind: 'listed-page', pageId: 'page-c' },
    }])
  })

  it('reuses a loaded page snapshot when another page is selected again', () => {
    const loaded = Run.ready()
      .then({ input: 'source-selected', source: 'listed-page' })
      .then({ input: 'pages-loaded', result: { ok: true, value: pagesConst } })

    const current = loaded.then({ input: 'source-selected', source: 'current' })
    expect(current.effects).toEqual([])
    expect(current.then({ input: 'confirm' }).effects[0]).toMatchObject({
      effect: 'render',
      target: { kind: 'current' },
    })

    const listedAgain = current.then({ input: 'source-selected', source: 'listed-page' })
    expect(listedAgain.state.pages).toBe(pagesConst)
    // The preview of the page it returns to is local; only a second download would be wrong.
    expect(listedAgain.effects.map((effect) => effect.effect)).toEqual(['preview'])
  })

  /**
   * The overlay contacts no device while it opens, so a confirm is what discovers that the tablet
   * names no open page. A document IS open and its pages still render, so the answer is the page
   * list, not an error the user can do nothing about.
   */
  it('turns a confirm with no identified open page into the page list', () => {
    const rendered = Run.ready()
      .then({ input: 'confirm' })
      .then({ input: 'rendered', result: failure('no-open-page', false) })

    expect(rendered.state.source).toBe('listed-page')
    expect(rendered.state.phase).toBe('loading-pages')
    expect(rendered.state.failure).toBeNull()
    // The move happened instead of an answer to the confirm, so the card has to explain itself.
    expect(rendered.state.currentPageRefused).toBe(true)
    expect(rendered.effects).toEqual([{ effect: 'pages', operationId: 'operation-1' }])

    const loaded = rendered.then({
      input: 'pages-loaded',
      result: { ok: true, value: { ...pagesConst, currentPageNumber: null } },
    })
    expect(loaded.state.phase).toBe('ready')
    expect(loaded.state.selectedPageId).toBeNull()
    expect(RemarkableModel.canUseCurrentPage(loaded.state)).toBe(false)
    expect(RemarkableModel.canConfirm(loaded.state)).toBe(false)

    const chosen = loaded.then({ input: 'page-selected', pageId: 'page-c' })
    expect(RemarkableModel.canConfirm(chosen.state)).toBe(true)
    expect(chosen.then({ input: 'confirm' }).effects).toEqual([{
      effect: 'render',
      operationId: 'operation-1',
      target: { kind: 'listed-page', pageId: 'page-c' },
    }])
  })

  it('refuses to go back to a current page the tablet does not name', () => {
    const loaded = Run.ready()
      .then({ input: 'source-selected', source: 'listed-page' })
      .then({
        input: 'pages-loaded',
        result: { ok: true, value: { ...pagesConst, currentPageNumber: null } },
      })

    const back = loaded.then({ input: 'source-selected', source: 'current' })
    expect(back.state.source).toBe('listed-page')
    expect(back.effects).toEqual([])
  })

  it('keeps a loaded page list instead of downloading it twice', () => {
    const loaded = Run.ready()
      .then({ input: 'source-selected', source: 'listed-page' })
      .then({ input: 'pages-loaded', result: { ok: true, value: pagesConst } })
      .then({ input: 'source-selected', source: 'current' })
      .then({ input: 'confirm' })
      .then({ input: 'rendered', result: failure('no-open-page', false) })

    expect(loaded.state.source).toBe('listed-page')
    expect(loaded.state.phase).toBe('ready')
    expect(loaded.effects.some((effect) => effect.effect === 'pages')).toBe(false)
  })

  /** The pane draws the page the user is looking at now, so a late answer for another is dropped. */
  it('previews a listed page by itself, the tablet page on request, and drops stale answers', () => {
    const loaded = Run.ready()
      .then({ input: 'source-selected', source: 'listed-page' })
      .then({ input: 'pages-loaded', result: { ok: true, value: pagesConst } })

    expect(loaded.state.previewPhase).toBe('loading')
    expect(loaded.effects).toEqual([{
      effect: 'preview',
      operationId: 'operation-1',
      previewFor: 'page-b',
      target: { kind: 'listed-page', pageId: 'page-b' },
    }])

    const switched = loaded.then({ input: 'page-selected', pageId: 'page-c' })
    const stale = switched.then({
      input: 'previewed',
      previewFor: 'page-b',
      result: { ok: true, value: previewConst },
    })
    expect(stale.state.previewPhase).toBe('loading')
    expect(stale.state.preview).toBeNull()

    const drawn = switched.then({
      input: 'previewed',
      previewFor: 'page-c',
      result: { ok: true, value: previewConst },
    })
    expect(drawn.state.previewPhase).toBe('ready')
    expect(drawn.state.preview).toBe(previewConst)

    const back = drawn.then({ input: 'source-selected', source: 'current' })
    expect(back.state.previewPhase).toBe('idle')
    expect(back.state.preview).toBeNull()
    expect(back.effects).toEqual([])

    expect(back.then({ input: 'preview-requested' }).effects).toEqual([{
      effect: 'preview',
      operationId: 'operation-1',
      previewFor: 'current',
      target: { kind: 'current' },
    }])

    // Try again on a listed page asks for that page, not for the tablet's own.
    const failed = switched.then({
      input: 'previewed',
      previewFor: 'page-c',
      result: failure('device-sleeping'),
    })
    expect(failed.state.previewPhase).toBe('failed')
    expect(failed.then({ input: 'preview-requested' }).effects).toEqual([{
      effect: 'preview',
      operationId: 'operation-1',
      previewFor: 'page-c',
      target: { kind: 'listed-page', pageId: 'page-c' },
    }])
  })

  /** The sentence explained an earlier move; a new attempt must not inherit it as its reason. */
  it('drops the refused-current-page sentence when a new attempt starts', () => {
    const refused = Run.ready()
      .then({ input: 'confirm' })
      .then({ input: 'rendered', result: failure('no-open-page', false) })
      .then({ input: 'pages-loaded', result: { ok: true, value: pagesConst } })
      .then({ input: 'previewed', previewFor: 'page-b', result: { ok: true, value: previewConst } })
    expect(refused.state.currentPageRefused).toBe(true)

    expect(refused.then({ input: 'preview-requested' }).state.currentPageRefused).toBe(false)
    expect(refused.then({ input: 'confirm' }).state.currentPageRefused).toBe(false)
  })

  /**
   * However many times: a sleeping tablet is fixed by picking it up, and the card cannot know
   * which attempt is the one after that. Capping it at one made the third click say the request
   * was no longer valid and ask the user to close the card and open it again.
   */
  it('keeps offering a retry after a sleeping or busy failure', () => {
    for (const code of ['device-sleeping', 'device-busy'] as const) {
      let failed = Run.ready()
        .then({ input: 'confirm' })
        .then({ input: 'rendered', result: failure(code) })

      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(RemarkableModel.canRetry(failed.state)).toBe(true)
        const retried = failed.then({ input: 'retry' })
        expect(retried.effects).toEqual([{
          effect: 'render',
          operationId: 'operation-1',
          target: { kind: 'current' },
        }])
        failed = retried.then({ input: 'rendered', result: failure(code) })
      }
    }
  })

  /**
   * The one thing the card does to the tablet without being asked, and only because the setting
   * says it may. With it off the card opens the way it always has: nothing is contacted.
   */
  it('previews the current page on open only when the setting says so', () => {
    const off = Run.initial().then({
      input: 'started',
      result: { ok: true, value: { operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: false } },
    })
    expect(off.effects).toEqual([])
    expect(off.state.previewPhase).toBe('idle')

    const on = Run.initial().then({
      input: 'started',
      result: { ok: true, value: { operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: true } },
    })
    expect(on.effects).toEqual([{
      effect: 'preview',
      operationId: 'operation-1',
      previewFor: 'current',
      target: { kind: 'current' },
    }])
    expect(on.state.previewPhase).toBe('loading')
    expect(on.state.autoPreviewOnOpen).toBe(true)
  })

  it('saves the setting the moment it is ticked, and previews when nothing is drawn yet', () => {
    const ticked = Run.ready().then({ input: 'auto-preview-toggled', enabled: true })
    expect(ticked.state.autoPreviewOnOpen).toBe(true)
    expect(ticked.effects).toEqual([
      { effect: 'save-auto-preview', enabled: true },
      { effect: 'preview', operationId: 'operation-1', previewFor: 'current', target: { kind: 'current' } },
    ])

    const unticked = ticked.then({ input: 'auto-preview-toggled', enabled: false })
    expect(unticked.state.autoPreviewOnOpen).toBe(false)
    expect(unticked.effects).toEqual([{ effect: 'save-auto-preview', enabled: false }])
  })

  /** Ticking it while a page is already drawn saves and nothing else: the pane is not disturbed. */
  it('does not re-preview when the pane already holds a page', () => {
    const drawn = Run.ready()
      .then({ input: 'preview-requested' })
      .then({ input: 'previewed', previewFor: 'current', result: { ok: true, value: previewConst } })

    const ticked = drawn.then({ input: 'auto-preview-toggled', enabled: true })

    expect(ticked.effects).toEqual([{ effect: 'save-auto-preview', enabled: true }])
  })
  it('retries a failed listing without replacing its operation', () => {
    const failed = Run.ready()
      .then({ input: 'source-selected', source: 'listed-page' })
      .then({ input: 'pages-loaded', result: failure('device-busy') })

    const retried = failed.then({ input: 'retry' })

    expect(retried.state.phase).toBe('loading-pages')
    expect(retried.effects).toEqual([{ effect: 'pages', operationId: 'operation-1' }])
  })

  it('never retries another error even when the sender marks it retryable', () => {
    const failed = Run.ready()
      .then({ input: 'confirm' })
      .then({ input: 'rendered', result: failure('timeout') })

    expect(RemarkableModel.canRetry(failed.state)).toBe(false)
    expect(failed.then({ input: 'retry' }).effects).toEqual([])
  })

  it('keeps the exact rendered path until insertion succeeds', () => {
    const rendered = Run.ready()
      .then({ input: 'confirm' })
      .then({
        input: 'rendered',
        result: {
          ok: true,
          value: {
            outputPath: 'Q:\\imports\\Architecture notes-page-2.png',
            insertText: 'Q:\\imports\\Architecture notes-page-2.png',
            pageNumber: 2,
            documentName: 'Architecture notes',
          },
        },
      })

    expect(rendered.state.phase).toBe('output-ready')
    expect(rendered.state.outputPath).toBe('Q:\\imports\\Architecture notes-page-2.png')
    expect(rendered.effects).toEqual([{
      effect: 'insert',
      path: 'Q:\\imports\\Architecture notes-page-2.png',
    }])
    expect(rendered.then({ input: 'inserted', inserted: false }).effects).toEqual([])
    expect(rendered.then({ input: 'inserted', inserted: true }).effects)
      .toEqual([{ effect: 'close' }])
  })

  it('ignores results and insertion acknowledgements outside their active phase', () => {
    const ready = Run.ready()

    expect(ready.then({ input: 'pages-loaded', result: { ok: true, value: pagesConst } }).state)
      .toBe(ready.state)
    expect(ready.then({
      input: 'rendered',
      result: {
        ok: true,
        value: {
          outputPath: 'late.png', insertText: 'late.png', pageNumber: 1, documentName: null,
        },
      },
    }).state).toBe(ready.state)
    expect(ready.then({ input: 'inserted', inserted: true }).effects).toEqual([])
  })

  it('closes from every phase through one effect', () => {
    expect(Run.initial().then({ input: 'close' }).effects).toEqual([{ effect: 'close' }])
  })

  it('throws on an input it does not know', () => {
    expect(() => RemarkableModel.transition(Run.initial().state, {
      input: 'unknown',
    } as never)).toThrow(/Unknown reMarkable input/)
  })
})
