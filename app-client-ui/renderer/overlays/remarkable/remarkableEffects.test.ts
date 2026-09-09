import { describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge, IpcResult } from '../../../shared/appClientUiIpc'
import type {
  RemarkableOpenDocumentPages,
  RemarkableRenderedPage,
  RemarkableOpenedOperation,
  RemarkableResult,
} from '../../../shared/remarkableApi.types'
import { RemarkableEffects, type RemarkableEffectsPorts } from './remarkableEffects'
import type { RemarkableInput } from './remarkableModel'

describe('app-client-ui/renderer/overlays/remarkable/remarkableEffects', () => {
  function deferred<T>(): {
    promise: Promise<T>
    resolve(value: T): void
  } {
    let settle: ((value: T) => void) | null = null
    const promise = new Promise<T>((resolve) => { settle = resolve })
    return {
      promise,
      resolve: (value) => {
        if (settle === null) throw new Error('Deferred promise has no resolver')
        settle(value)
      },
    }
  }

  function answer<T>(value: T): IpcResult<RemarkableResult<T>> {
    return { ok: true, value: { ok: true, value } }
  }

  function harness() {
    const calls = {
      startOperation: vi.fn<AppClientUiBridge['remarkable']['startOperation']>(async () =>
        answer({ operationId: 'operation-1', storageNote: null, autoPreviewOnOpen: false })),
      pages: vi.fn<AppClientUiBridge['remarkable']['pages']>(async () => answer<
        RemarkableOpenDocumentPages
      >({
        operationId: 'operation-1',
        documentName: 'Sketch',
        currentPageNumber: 1,
        pages: [{ pageId: 'page-1', number: 1, template: null, modified: false }],
      })),
      render: vi.fn<AppClientUiBridge['remarkable']['render']>(async () => answer<
        RemarkableRenderedPage
      >({
        outputPath: 'Q:\\imports\\Sketch-page-1.png',
        insertText: 'Q:\\imports\\Sketch-page-1.png',
        pageNumber: 1,
        documentName: 'Sketch',
      })),
      release: vi.fn<AppClientUiBridge['remarkable']['release']>(async () => ({
        ok: true,
        value: undefined,
      })),
    }
    const dispatch = vi.fn<(input: RemarkableInput) => void>()
    const insert = vi.fn<(path: string) => boolean>(() => true)
    const close = vi.fn<() => void>()
    const bridge = { remarkable: calls } as unknown as Pick<AppClientUiBridge, 'remarkable'>
    const ports: RemarkableEffectsPorts = { dispatch, insert, close }
    return { calls, dispatch, insert, close, effects: new RemarkableEffects(bridge, ports, 's-1') }
  }

  it('runs start, pages and render through the one operation token', async () => {
    const test = harness()

    await test.effects.run({ effect: 'start' })
    await test.effects.run({ effect: 'pages', operationId: 'operation-1' })
    await test.effects.run({
      effect: 'render',
      operationId: 'operation-1',
      target: { kind: 'listed-page', pageId: 'page-1' },
    })

    expect(test.calls.startOperation).toHaveBeenCalledOnce()
    expect(test.calls.pages).toHaveBeenCalledWith('operation-1')
    expect(test.calls.render).toHaveBeenCalledWith(
      'operation-1',
      { kind: 'listed-page', pageId: 'page-1' },
    )
    expect(test.dispatch.mock.calls.map(([input]) => input.input))
      .toEqual(['started', 'pages-loaded', 'rendered'])
  })

  it('releases a token that arrives after disposal without dispatching it', async () => {
    const test = harness()
    const started = deferred<IpcResult<RemarkableResult<RemarkableOpenedOperation>>>()
    test.calls.startOperation.mockReturnValueOnce(started.promise)

    const running = test.effects.run({ effect: 'start' })
    test.effects.dispose()
    started.resolve(answer({ operationId: 'operation-late', storageNote: null, autoPreviewOnOpen: false }))
    await running
    test.effects.dispose()

    expect(test.dispatch).not.toHaveBeenCalled()
    expect(test.calls.release).toHaveBeenCalledOnce()
    expect(test.calls.release).toHaveBeenCalledWith('operation-late')
  })

  it('ignores late pages and render answers after disposal', async () => {
    for (const effect of ['pages', 'render'] as const) {
      const test = harness()
      await test.effects.run({ effect: 'start' })
      test.dispatch.mockClear()

      if (effect === 'pages') {
        const pending = deferred<Awaited<ReturnType<typeof test.calls.pages>>>()
        test.calls.pages.mockReturnValueOnce(pending.promise)
        const running = test.effects.run({ effect: 'pages', operationId: 'operation-1' })
        test.effects.dispose()
        pending.resolve(answer({
          operationId: 'operation-1',
          documentName: 'Late',
          currentPageNumber: 1,
          pages: [],
        }))
        await running
      }
      else if (effect === 'render') {
        const pending = deferred<Awaited<ReturnType<typeof test.calls.render>>>()
        test.calls.render.mockReturnValueOnce(pending.promise)
        const running = test.effects.run({
          effect: 'render',
          operationId: 'operation-1',
          target: { kind: 'current' },
        })
        test.effects.dispose()
        pending.resolve(answer({
          outputPath: 'late.png', insertText: 'late.png', pageNumber: 1, documentName: null,
        }))
        await running
      }
      else throw new Error(`Unknown pending effect: ${JSON.stringify(effect)}`)

      expect(test.dispatch).not.toHaveBeenCalled()
      expect(test.calls.release).toHaveBeenCalledOnce()
    }
  })

  it('closes and releases exactly once', async () => {
    const test = harness()
    await test.effects.run({ effect: 'start' })

    await test.effects.run({ effect: 'close' })
    await test.effects.run({ effect: 'close' })
    test.effects.dispose()

    expect(test.close).toHaveBeenCalledOnce()
    expect(test.calls.release).toHaveBeenCalledOnce()
    expect(test.calls.release).toHaveBeenCalledWith('operation-1')
  })

  it('keeps insertion failure in the model for false and thrown insertions', async () => {
    for (const outcome of ['false', 'throw'] as const) {
      const test = harness()
      if (outcome === 'false') test.insert.mockReturnValue(false)
      else if (outcome === 'throw') test.insert.mockImplementation(() => { throw new Error('gone') })
      else throw new Error(`Unknown insertion outcome: ${JSON.stringify(outcome)}`)

      await test.effects.run({ effect: 'insert', path: 'Q:\\imports\\page.png' })

      expect(test.insert).toHaveBeenCalledWith('Q:\\imports\\page.png')
      expect(test.dispatch).toHaveBeenCalledWith({ input: 'inserted', inserted: false })
    }
  })

  it('reports a successful insertion to the model', async () => {
    const test = harness()

    await test.effects.run({ effect: 'insert', path: 'Q:\\imports\\page.png' })

    expect(test.dispatch).toHaveBeenCalledWith({ input: 'inserted', inserted: true })
  })

  it('turns transport refusal and throws into non-retryable CLI failures', async () => {
    for (const outcome of ['refused', 'throw'] as const) {
      const test = harness()
      if (outcome === 'refused')
        test.calls.startOperation.mockResolvedValueOnce({ ok: false, error: 'main unavailable' })
      else if (outcome === 'throw')
        test.calls.startOperation.mockRejectedValueOnce(new Error('main gone'))
      else throw new Error(`Unknown transport outcome: ${JSON.stringify(outcome)}`)

      await test.effects.run({ effect: 'start' })

      expect(test.dispatch).toHaveBeenCalledWith({
        input: 'started',
        result: {
          ok: false,
          code: 'cli-failed',
          detail: outcome === 'refused' ? 'main unavailable' : 'The main process did not answer',
          retryable: false,
        },
      })
    }
  })
})
