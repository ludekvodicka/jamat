import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge, IpcResult } from '../../shared/appClientUiIpc'
import type { TerminalThemeName, UiSettingsValue } from '../../shared/uiSettings'
import { IpcSnapshotReader } from '../ipc/ipcSnapshotReader'
import { UiSettingsStore } from './uiSettingsStore'

describe('app-client-ui/renderer/uiSettings/uiSettingsStore', () => {
  /** The two members of the bridge the store reaches, typed off it so a rename is a compile error. */
  type UiBridgeStub = Pick<AppClientUiBridge, 'ui' | 'onUiSettingsChanged'>

  interface Harness {
    /** The main process saying "something changed"; the answer is the read it schedules. */
    push: () => void
    /** Answers the read that is out, the way the main process would. */
    answer: (value: UiSettingsValue) => Promise<void>
  }

  let running: (() => void) | null = null

  function value(
    fontScalePercent: number,
    terminalFontScalePercent = 100,
    terminalTheme: TerminalThemeName = 'original',
    fileViewerFontScalePercent = 100,
  ): UiSettingsValue {
    return {
      fontScalePercent,
      fileViewerFontScalePercent,
      terminalFontScalePercent,
      terminalTheme,
      scrollSpeedPercent: 100,
      terminalScrollSpeedPercent: 100,
    }
  }

  function scale(): string {
    return document.documentElement.style.getPropertyValue('--ui-font-scale')
  }

  /** The viewer's own multiplier, which its body applies on top of the one above. */
  function viewerScale(): string {
    return document.documentElement.style.getPropertyValue('--file-viewer-font-scale')
  }

  /** The name `tokens.css` selects the terminal's pair by; the store writes it and nothing else. */
  function palette(): string | undefined {
    return document.documentElement.dataset.terminalTheme
  }

  function harness(): Harness {
    const pending: ((result: IpcResult<UiSettingsValue>) => void)[] = []
    let notify: (() => void) | null = null
    const stub: UiBridgeStub = {
      ui: {
        getSettings: () =>
          new Promise<IpcResult<UiSettingsValue>>((resolve) => pending.push(resolve)),
        saveSettings: () => {
          throw new Error('The store never writes; the settings tab does')
        },
      },
      onUiSettingsChanged: (callback) => {
        notify = callback
        return () => { notify = null }
      },
    }
    ;(window as unknown as { appClient: UiBridgeStub }).appClient = stub
    running = UiSettingsStore.start()
    return {
      push: () => notify?.(),
      answer: async (next) => {
        pending.shift()?.({ ok: true, value: next })
        await vi.advanceTimersByTimeAsync(0)
      },
    }
  }

  /** A push is coalesced before the read goes out, so the wait is the reader's own window. */
  async function pushed(context: Harness, next: UiSettingsValue): Promise<void> {
    context.push()
    await vi.advanceTimersByTimeAsync(IpcSnapshotReader.coalesceMillisecondsConst)
    await context.answer(next)
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  // The store is one object for the whole document, so each test hands the next one a clean one.
  // `reset` and not `clearPreview`: the state here is static, and dropping the preview alone leaves
  // the next test reading this one's `persisted` as if it had come from disk.
  afterEach(() => {
    running?.()
    running = null
    UiSettingsStore.reset()
    document.documentElement.style.removeProperty('--ui-font-scale')
    document.documentElement.style.removeProperty('--file-viewer-font-scale')
    delete document.documentElement.dataset.terminalTheme
    delete (window as unknown as { appClient?: unknown }).appClient
    vi.useRealTimers()
  })

  it('turns the percentage that arrives into the one property it sets', async () => {
    const context = harness()

    await context.answer(value(115))

    expect(scale()).toBe('1.15')
    expect(UiSettingsStore.current()).toEqual(value(115))
  })

  /**
   * The viewer's scale is a second property rather than a size of its own, and it is written even
   * when it is 1: a document that left it out would fall back to the token's default, which is the
   * same number today and stops being one the moment the default moves.
   */
  it('writes the file viewer scale beside the interface one', async () => {
    const context = harness()

    await context.answer(value(115, 100, 'original', 130))

    expect(scale()).toBe('1.15')
    expect(viewerScale()).toBe('1.3')

    UiSettingsStore.preview(value(115, 100, 'original', 70))
    expect(viewerScale()).toBe('0.7')

    UiSettingsStore.clearPreview()
    expect(viewerScale()).toBe('1.3')
  })

  // The three fields are one value, so a preview differing in the viewer's scale alone is still not
  // the value that was written, and repainting over it would resize a file somebody is reading.
  it('tells a preview apart by the file viewer scale as well', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(100, 100, 'original', 140))

    UiSettingsStore.committed(value(100, 100, 'original', 120))

    expect(viewerScale()).toBe('1.4')
    expect(UiSettingsStore.current()).toEqual(value(100, 100, 'original', 140))
  })

  /**
   * The palette rides the same call as the scale, and it rides it as a name: the colours are
   * `tokens.css`'s, keyed off this attribute, so a preview repaints the panel around every canvas
   * without a colour passing through here. Dropping it puts back what is on disk, like the scale.
   */
  it('writes the chosen palette onto the document as a name', async () => {
    const context = harness()

    await context.answer(value(100, 100, 'soft'))
    expect(palette()).toBe('soft')

    UiSettingsStore.preview(value(100, 100, 'vscodeDark'))
    expect(palette()).toBe('vscodeDark')

    UiSettingsStore.clearPreview()
    expect(palette()).toBe('soft')
  })

  it('applies a preview at once, without anything being written', () => {
    harness()

    UiSettingsStore.preview(value(130))

    expect(scale()).toBe('1.3')
    expect(UiSettingsStore.current()).toEqual(value(130))
  })

  // The save of the other window arrives on the same channel as this one's own.
  it('leaves an active preview alone when a persisted value arrives', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(130))

    await pushed(context, value(115))

    expect(scale()).toBe('1.3')
    expect(UiSettingsStore.current()).toEqual(value(130))
  })

  // The write of this window itself, which must not wait for the reader to bring it back around.
  it('keeps what was committed here when the preview is later dropped', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(130))

    UiSettingsStore.committed(value(130))
    UiSettingsStore.clearPreview()

    expect(scale()).toBe('1.3')
    expect(UiSettingsStore.current()).toEqual(value(130))
  })

  // The write left at 130 and the slider went on to 145 before the answer came back. Repainting the
  // window at what was written would leave it one size while the sliders and the readout say another.
  it('keeps a preview that is not the value it is being told was written', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(130))
    UiSettingsStore.preview(value(145))

    UiSettingsStore.committed(value(130))

    expect(scale()).toBe('1.45')
    expect(UiSettingsStore.current()).toEqual(value(145))
    // What was written is remembered all the same, so dropping the preview lands on it.
    UiSettingsStore.clearPreview()
    expect(scale()).toBe('1.3')
  })

  // The theme rides the same value as the two sizes: a preview differing in it alone is still not
  // what was written, and repainting over it would leave the terminals in colours the combobox in
  // front of them no longer shows.
  it('tells a preview apart by its theme as well as by its sizes', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(100, 100, 'vscodeDark'))

    UiSettingsStore.committed(value(100, 100, 'soft'))

    expect(UiSettingsStore.current()).toEqual(value(100, 100, 'vscodeDark'))
  })

  // The other half of the same rule: the preview WAS this write, so it goes, and the read that
  // arrives a tenth of a second later is applied rather than held off by a preview nobody dropped.
  it('lets the next read through once the preview was the value it wrote', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(130))

    UiSettingsStore.committed(value(130))
    await pushed(context, value(115))

    expect(scale()).toBe('1.15')
    expect(UiSettingsStore.current()).toEqual(value(115))
  })

  it('drops the preview onto the value that arrived while it was up', async () => {
    const context = harness()
    await context.answer(value(100))
    UiSettingsStore.preview(value(130))
    await pushed(context, value(115))

    UiSettingsStore.clearPreview()

    expect(scale()).toBe('1.15')
    expect(UiSettingsStore.current()).toEqual(value(115))
  })

  // The terminal hears about its own half of the value here and nowhere else.
  it('hands every subscriber what it applied', async () => {
    const context = harness()
    const seen: UiSettingsValue[] = []
    const unsubscribe = UiSettingsStore.subscribe((next) => seen.push(next))

    await context.answer(value(105, 120))
    UiSettingsStore.preview(value(140, 70))
    unsubscribe()
    UiSettingsStore.clearPreview()

    expect(seen).toEqual([value(105, 120), value(140, 70)])
  })

  // Last on purpose: it reads whatever every test above it left in the statics, so it is the one
  // that fails if the cleanup ever stops putting them back.
  it('starts where a fresh document starts, whatever ran before it', () => {
    harness()

    expect(UiSettingsStore.current()).toEqual(value(100))
  })
})
