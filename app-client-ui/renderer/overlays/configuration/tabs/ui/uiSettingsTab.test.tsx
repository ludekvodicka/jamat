import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppClientUiBridge, IpcResult } from '../../../../../shared/appClientUiIpc'
import type { UiSettingsSaveResult, UiSettingsValue } from '../../../../../shared/uiSettings'
import { UiSettingsStore } from '../../../../uiSettings/uiSettingsStore'
import { UiSettingsTab } from './uiSettingsTab'

describe('app-client-ui/renderer/overlays/configuration/tabs/ui/uiSettingsTab', () => {
  /** The members of the bridge this screen reaches, typed off it so a rename is a compile error. */
  type UiBridgeStub = Pick<AppClientUiBridge, 'ui' | 'onUiSettingsChanged'>

  const storedConst: UiSettingsValue = {
    fontScalePercent: 110,
    fileViewerFontScalePercent: 125,
    terminalFontScalePercent: 120,
    terminalTheme: 'soft',
    scrollSpeedPercent: 150,
    terminalScrollSpeedPercent: 200,
  }

  let stopStore: (() => void) | null = null

  /** The main process as a lever: a write is only answered when a test says so. */
  class BridgeStub {
    readonly saved: UiSettingsValue[] = []
    private readonly waiting: ((answer: IpcResult<UiSettingsSaveResult>) => void)[] = []

    install(): void {
      const bridge: UiBridgeStub = {
        ui: {
          getSettings: () => Promise.resolve({ ok: true, value: storedConst }),
          saveSettings: (value) => {
            this.saved.push(value)
            return new Promise<IpcResult<UiSettingsSaveResult>>(
              (resolve) => this.waiting.push(resolve),
            )
          },
        },
        // Nothing is ever pushed here: what the window knows after its own save is what it was told.
        onUiSettingsChanged: () => () => {},
      }
      ;(window as unknown as { appClient: UiBridgeStub }).appClient = bridge
    }

    async answersSave(): Promise<void> {
      const resolve = this.waiting.shift()
      if (!resolve)
        throw new Error('No save is in flight')
      resolve({ ok: true, value: { ok: true } })
      await flush()
    }
  }

  /** Lets every pending promise callback run while the clock stays under the test's control. */
  async function flush(milliseconds = 0): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds)
    })
  }

  async function mount(stub = new BridgeStub()) {
    stub.install()
    // Started the way `main.tsx` starts it: the tab previews into a document that already knows
    // what is on disk, which is what makes dropping a preview mean anything.
    stopStore = UiSettingsStore.start()
    const onDirtyChange = vi.fn()
    const view = render(<UiSettingsTab onDirtyChange={onDirtyChange} />)
    await flush()
    return { onDirtyChange, stub, view }
  }

  function sliders(container: HTMLElement): HTMLInputElement[] {
    return [...container.querySelectorAll<HTMLInputElement>('.jamat-configuration-ui__slider')]
  }

  function themeChoice(container: HTMLElement): HTMLSelectElement {
    const found = container.querySelector<HTMLSelectElement>('.jamat-configuration-ui__select')
    if (!found)
      throw new Error('The tab drew no theme list')
    return found
  }

  function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label)
    if (!found)
      throw new Error(`The tab drew no ${label} button`)
    return found
  }

  function scale(): string {
    return document.documentElement.style.getPropertyValue('--ui-font-scale')
  }

  function viewerScale(): string {
    return document.documentElement.style.getPropertyValue('--file-viewer-font-scale')
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  // `cleanup` explicitly and first: unmounting drops the tab's preview, and that has to happen
  // while the store is still the one this test was using.
  afterEach(() => {
    cleanup()
    stopStore?.()
    stopStore = null
    UiSettingsStore.reset()
    document.documentElement.style.removeProperty('--ui-font-scale')
    document.documentElement.style.removeProperty('--file-viewer-font-scale')
    delete (window as unknown as { appClient?: unknown }).appClient
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('draws the three scales and the two speeds the settings answered with', async () => {
    const { view } = await mount()

    expect(sliders(view.container).map((slider) => slider.value))
      .toEqual(['110', '125', '120', '150', '200'])
    expect([...view.container.querySelectorAll('.jamat-configuration-ui__value')]
      .map((node) => node.textContent))
      .toEqual(['110 %', '125 %', '120 %', '150 %', '200 %'])
    expect(scale()).toBe('1.1')
    expect(viewerScale()).toBe('1.25')
  })

  /*
   * A speed is offered on its own grid, not the fonts': the two rows above it step by 5 inside
   * 70-150, and these step by 25 up to 400. A slider that offered a value the main process refuses
   * would be a Save that fails on something the card itself drew.
   */
  it('offers the scroll speeds on their own range, and writes one on Save', async () => {
    const { stub, view } = await mount()
    const [,,, windowSpeed, terminalSpeed] = sliders(view.container)

    expect([windowSpeed?.min, windowSpeed?.max, windowSpeed?.step]).toEqual(['50', '400', '25'])
    expect([terminalSpeed?.min, terminalSpeed?.max, terminalSpeed?.step]).toEqual(['50', '400', '25'])

    fireEvent.input(windowSpeed, { target: { value: '275' } })
    fireEvent.click(buttonNamed(view.container, 'Save'))
    await stub.answersSave()

    expect(stub.saved).toEqual([{ ...storedConst, scrollSpeedPercent: 275 }])
  })

  /*
   * The terminal's speed previews while the thumb moves, unlike its font size: a multiplier on the
   * wheel changes no cell, so nothing renegotiates the PTY geometry and there is no drag to settle.
   */
  it('previews the terminal speed without waiting for the thumb to be let go', async () => {
    const { view } = await mount()
    const applied: number[] = []
    const off = UiSettingsStore.subscribe((value) => applied.push(value.terminalScrollSpeedPercent))

    fireEvent.input(sliders(view.container)[4], { target: { value: '300' } })

    expect(applied).toEqual([300])
    off()
  })

  /**
   * Live like the interface scale and unlike the terminal's: a viewer is drawn by this same
   * document, so a step of the drag is a repaint. The terminal's wait exists because each step
   * there is a ConPTY reflow, and there is nothing of that kind here to wait out.
   */
  it('previews the file viewer size while the thumb moves, and writes it on Save', async () => {
    const { stub, view } = await mount()

    fireEvent.input(sliders(view.container)[1], { target: { value: '140' } })

    expect(viewerScale()).toBe('1.4')
    expect(scale()).toBe('1.1')

    fireEvent.click(buttonNamed(view.container, 'Save'))
    await stub.answersSave()

    expect(stub.saved).toEqual([{ ...storedConst, fileViewerFontScalePercent: 140 }])
  })

  /**
   * The store is TOLD what this window wrote. Nothing is broadcast in this test, so a tab that
   * waited to hear its own write back would leave the document at the size before the save - and
   * the moment the card closes, at that old size for good.
   */
  it('leaves the window at the size it wrote, before any broadcast arrives', async () => {
    const { stub, view } = await mount()

    fireEvent.input(sliders(view.container)[0], { target: { value: '130' } })
    fireEvent.click(buttonNamed(view.container, 'Save'))
    await stub.answersSave()

    expect(stub.saved).toEqual([{ ...storedConst, fontScalePercent: 130 }])
    expect(scale()).toBe('1.3')
    view.unmount()
    expect(scale()).toBe('1.3')
  })

  /**
   * A held arrow key commits a range input about thirty times a second, and every preview that
   * reached the terminals would be a ConPTY reflow of the wide characters in them. The burst is one
   * preview; a mouse release is a single event and still previews one frame later.
   */
  it('turns a burst on the terminal slider into one preview, once it settles', async () => {
    const { view } = await mount()
    const preview = vi.spyOn(UiSettingsStore, 'preview')
    const terminal = sliders(view.container)[2]

    for (const percent of [125, 130, 135]) {
      fireEvent.input(terminal, { target: { value: String(percent) } })
      fireEvent.change(terminal)
      await flush(60)
    }

    expect(preview).not.toHaveBeenCalled()

    await flush(200)

    expect(preview.mock.calls).toEqual([[{ ...storedConst, terminalFontScalePercent: 135 }]])
  })

  /**
   * The list has no drag, so there is nothing to settle and nothing to wait out: what makes the
   * terminal slider wait is a held arrow committing thirty times a second into a PTY reflow, and a
   * colour is not a reflow at all.
   */
  it('previews the palette the moment it is chosen', async () => {
    const { view } = await mount()
    const preview = vi.spyOn(UiSettingsStore, 'preview')
    const choice = themeChoice(view.container)

    expect([...choice.options].map((option) => option.value))
      .toEqual(['original', 'soft', 'vscodeDark'])
    // The name on screen and the name in the file are not the same word for `soft`, and that is the
    // point of the pair: the file keeps what was written in it, the list says which generation the
    // colours come from.
    expect([...choice.options].map((option) => option.textContent))
      .toEqual(['Jamat', 'Jamat v1', 'VS Code Dark'])
    expect(choice.value).toBe('soft')

    fireEvent.change(choice, { target: { value: 'vscodeDark' } })

    expect(choice.value).toBe('vscodeDark')
    expect(preview.mock.calls).toEqual([[{ ...storedConst, terminalTheme: 'vscodeDark' }]])
  })

  it('reports the palette upward and writes it with the two scales', async () => {
    const { onDirtyChange, stub, view } = await mount()

    fireEvent.change(themeChoice(view.container), { target: { value: 'original' } })
    expect(onDirtyChange.mock.calls).toEqual([[true]])

    fireEvent.click(buttonNamed(view.container, 'Save'))
    await stub.answersSave()

    expect(stub.saved).toEqual([{ ...storedConst, terminalTheme: 'original' }])
  })

  it('puts the palette back with the two scales when Reset is pressed', async () => {
    const { view } = await mount()

    fireEvent.click(buttonNamed(view.container, 'Reset to defaults'))

    expect(themeChoice(view.container).value).toBe('original')
    expect(sliders(view.container).map((slider) => slider.value))
      .toEqual(['100', '100', '100', '100', '100'])
  })

  it('lets go of the palette while its own write is out', async () => {
    const { view } = await mount()
    fireEvent.change(themeChoice(view.container), { target: { value: 'vscodeDark' } })

    fireEvent.click(buttonNamed(view.container, 'Save'))

    expect(themeChoice(view.container).disabled).toBe(true)
  })

  // The tab reports itself clean while the write is out, so nothing would ask before the card
  // closed over a scale moved into that gap. There is nothing to move: both sliders are dead.
  it('lets go of no slider while its own write is out', async () => {
    const { view } = await mount()
    const [interfaceSlider, fileViewer, terminal] = sliders(view.container)
    fireEvent.input(interfaceSlider, { target: { value: '130' } })
    expect(interfaceSlider.disabled).toBe(false)

    fireEvent.click(buttonNamed(view.container, 'Save'))

    expect(interfaceSlider.disabled).toBe(true)
    expect(fileViewer.disabled).toBe(true)
    expect(terminal.disabled).toBe(true)
    expect(buttonNamed(view.container, 'Reset to defaults').disabled).toBe(true)
    expect(buttonNamed(view.container, 'Saving…').disabled).toBe(true)
  })

  /** The one fact that flows up, and the window draws its mark and asks its question from it. */
  it('reports the edit upward, and reports itself clean from the click rather than the answer', async () => {
    const { onDirtyChange, stub, view } = await mount()

    fireEvent.input(sliders(view.container)[0], { target: { value: '130' } })
    expect(onDirtyChange.mock.calls).toEqual([[true]])

    fireEvent.click(buttonNamed(view.container, 'Save'))
    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])

    await stub.answersSave()

    expect(onDirtyChange.mock.calls).toEqual([[true], [false]])
    expect(buttonNamed(view.container, 'Save').disabled).toBe(true)
  })

  it('puts the stored size back when the tab is dropped with nothing saved', async () => {
    const { stub, view } = await mount()

    fireEvent.input(sliders(view.container)[0], { target: { value: '145' } })
    expect(scale()).toBe('1.45')

    view.unmount()

    expect(scale()).toBe('1.1')
    expect(UiSettingsStore.current()).toEqual(storedConst)
    expect(stub.saved).toEqual([])
  })
})
