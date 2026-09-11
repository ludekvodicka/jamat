import { useEffect, useId, useRef, useState } from 'react'

import {
  type TerminalThemeName,
  UiSettings,
  type UiSettingsRange,
} from '../../../../../shared/uiSettings'
import { UiSettingsStore } from '../../../../uiSettings/uiSettingsStore'
import { ConfigurationSection } from '../../configurationSection'
import type { ConfigurationTabProps } from '../../configurationTab.types'
import './uiSettings.css'
import { UiSettingsEffects, type UiSettingsPorts } from './uiSettingsEffects'
import { UiSettingsModel, type UiSettingsModelState } from './uiSettingsModel'

/**
 * The three font scales, the two scroll speeds and the terminal's colours: how big this shell draws
 * its own text, how big a file viewer and a terminal draw theirs, how far one turn of the wheel
 * moves each of them, and which palette the terminal draws in.
 *
 * It saves itself, and only when Save is pressed. Everything before that is a PREVIEW: the store
 * applies it to the live document so the answer to "is 115 % too big" is the window itself rather
 * than a number, and nothing has been written while the question is open. Leaving the tab drops the
 * preview, whichever way it is left.
 */
export function UiSettingsTab(props: ConfigurationTabProps): React.JSX.Element {
  const [start] = useState(() => UiSettingsModel.initial())
  const [state, setState] = useState<UiSettingsModelState>(start.state)
  // Read through a ref rather than through the rendered state: a preview has to apply what the
  // dispatch just decided, not what React has drawn.
  const stateRef = useRef<UiSettingsModelState>(start.state)
  const reportedDirty = useRef(false)
  const dirtyChange = useRef(props.onDirtyChange)
  dirtyChange.current = props.onDirtyChange
  const terminalSlider = useRef<HTMLInputElement | null>(null)
  const uiSliderId = useId()
  const fileViewerSliderId = useId()
  const terminalSliderId = useId()
  const terminalThemeId = useId()
  const scrollSliderId = useId()
  const terminalScrollSliderId = useId()

  const [ports] = useState<UiSettingsPorts>(() => {
    const self: UiSettingsPorts = {
      dispatch: (input) => {
        const step = UiSettingsModel.transition(stateRef.current, input)
        stateRef.current = step.state
        setState(step.state)
        // A write of our own is handed to the store rather than waited for: see `committed`. Until
        // that call, `persisted` is still the size before this save, and everything that falls back
        // to it - leaving the tab, switching group - would drop the window there and jump back.
        if (input.input === 'saved' && input.ok && step.state.loaded !== null)
          UiSettingsStore.committed(step.state.loaded)
        // The one fact the window is told, and only when it changes: it draws a mark and it asks
        // before leaving, and both are about whether anything would be lost.
        const modified = UiSettingsModel.isModified(step.state)
        if (modified !== reportedDirty.current) {
          reportedDirty.current = modified
          dirtyChange.current(modified)
        }
        for (const effect of step.effects)
          void UiSettingsEffects.run(effect, self)
      },
    }
    return self
  })

  useEffect(() => {
    for (const effect of start.effects)
      void UiSettingsEffects.run(effect, ports)
  }, [start, ports])

  /**
   * The terminal's half of the preview, and the reason it is the NATIVE `change` event: React raises
   * its own `onChange` on every `input`, so it fires on each step of a drag - and each step there
   * renegotiates the PTY geometry, which is the one thing that must wait until the size has been
   * settled on. For the mouse the native event IS the release.
   *
   * For a key it is not: Chromium commits a range input per keydown, so a held arrow fires `change`
   * about thirty times a second, and three of every four of those steps land on a different pixel
   * size. Each one would reach every open terminal as a resize, and the Host applies each resize as
   * a ConPTY reflow that corrupts wide and box-drawing characters. The trailing timer is what makes
   * a burst of keypresses one preview; a mouse release is a single event and still previews at once,
   * one frame later.
   */
  useEffect(() => {
    const node = terminalSlider.current
    if (node === null)
      return
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    const released = (): void => {
      if (settleTimer !== null) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        UiSettingsPreview.of(stateRef.current)
      }, UiSettingsPreview.settleMillisecondsConst)
    }
    node.addEventListener('change', released)
    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer)
      node.removeEventListener('change', released)
    }
  }, [])

  /**
   * The one place the preview is dropped, and it covers every way out of this screen: switching
   * settings group unmounts the tab, so does closing the card - by Escape, by the close button, by
   * the backdrop, or by answering the window's question about unsaved work. What comes back is what
   * the store last read from disk, so a size that was tried and not saved leaves with the tab.
   *
   * A save that succeeded has already dropped its own preview, in `UiSettingsStore.committed`: the
   * store is TOLD what this window wrote rather than left to hear it back, because the broadcast
   * returns through a reader that coalesces for 100 ms and `persisted` holds the pre-save size until
   * that read lands. Clearing the preview here without that call would apply the old size for that
   * tenth of a second, the whole window jumping back and then forward again. What this cleanup is
   * left to drop is a size that was tried and not saved.
   */
  useEffect(() => () => UiSettingsStore.clearPreview(), [])

  const buffer = state.buffer
  // Both sliders are dead while a write is out, not only Reset and Save. The tab reports itself
  // clean for those milliseconds - a value already on its way into the file is not unsaved work -
  // so a scale moved into that gap would leave with the card without the window asking about it.
  const saving = state.saving !== null
  return (
    <div className="jamat-configuration-ui">
      {state.problem !== null && (
        <p className="jamat-configuration__problem" role="alert">{state.problem}</p>
      )}
      {buffer === null && (
        <p className="jamat-configuration-ui__note">Reading config.json…</p>
      )}
      <ConfigurationSection title="Text size">
        <UiSettingsSlider
          disabled={buffer === null || saving}
          hint="Everything this window draws except the status bar, which is chrome of a fixed height."
          id={uiSliderId}
          label="Interface text size"
          percent={buffer?.fontScalePercent ?? UiSettings.fontRangeConst.defaultPercent}
          range={UiSettings.fontRangeConst}
          // Live while the thumb moves: the window behind this card is the answer to how big 115 % is.
          onSlide={(percent) => {
            ports.dispatch({ input: 'ui-scale', percent })
            UiSettingsPreview.of(stateRef.current)
          }}
        />
        <UiSettingsSlider
          disabled={buffer === null || saving}
          hint="The document a file viewer draws: markdown, source, hex and diff. Its toolbar above them keeps the interface size."
          id={fileViewerSliderId}
          label="File viewer text size"
          percent={buffer?.fileViewerFontScalePercent ?? UiSettings.fontRangeConst.defaultPercent}
          range={UiSettings.fontRangeConst}
          // Live, like the interface scale and unlike the terminal's: a viewer is styled by the same
          // document this card sits in, so a step of the drag is a repaint and nothing more.
          onSlide={(percent) => {
            ports.dispatch({ input: 'file-viewer-scale', percent })
            UiSettingsPreview.of(stateRef.current)
          }}
        />
        <UiSettingsSlider
          disabled={buffer === null || saving}
          hint="The terminal alone. It follows once the slider is let go, not while it is dragged."
          id={terminalSliderId}
          label="Terminal text size"
          percent={buffer?.terminalFontScalePercent ?? UiSettings.fontRangeConst.defaultPercent}
          range={UiSettings.fontRangeConst}
          sliderRef={terminalSlider}
          onSlide={(percent) => ports.dispatch({ input: 'terminal-scale', percent })}
        />
      </ConfigurationSection>
      <ConfigurationSection title="Scrolling">
        <UiSettingsSlider
          disabled={buffer === null || saving}
          hint="How far one turn of the wheel moves a list, a tree or a document. 100 % is what the window does on its own."
          id={scrollSliderId}
          label="Interface scroll speed"
          percent={buffer?.scrollSpeedPercent ?? UiSettings.scrollRangeConst.defaultPercent}
          range={UiSettings.scrollRangeConst}
          // Live, like the two scales this card applies at once: the window behind the card is
          // scrollable, so the answer to how fast 250 % is comes from turning the wheel on it.
          onSlide={(percent) => {
            ports.dispatch({ input: 'scroll-speed', percent })
            UiSettingsPreview.of(stateRef.current)
          }}
        />
        <UiSettingsSlider
          disabled={buffer === null || saving}
          hint="The terminal alone, which scrolls a buffer of its own. It takes this while it is dragged; no resize is involved."
          id={terminalScrollSliderId}
          label="Terminal scroll speed"
          percent={
            buffer?.terminalScrollSpeedPercent ?? UiSettings.scrollRangeConst.defaultPercent
          }
          range={UiSettings.scrollRangeConst}
          // Live, unlike the terminal's font size: a multiplier on the wheel changes no cell, so
          // nothing renegotiates the PTY geometry and there is no drag to settle.
          onSlide={(percent) => {
            ports.dispatch({ input: 'terminal-scroll-speed', percent })
            UiSettingsPreview.of(stateRef.current)
          }}
        />
      </ConfigurationSection>
      <ConfigurationSection title="Terminal colours">
        <UiSettingsThemeChoice
          disabled={buffer === null || saving}
          hint="What the terminal paints in. Jamat is the window's own pair and today's look; Jamat v1 is what V1 drew in."
          id={terminalThemeId}
          label="Terminal colours"
          name={buffer?.terminalTheme ?? UiSettings.defaultTerminalThemeConst}
          // At once, and with no timer between: a list has no drag to settle, so the one choice made
          // is the one preview applied.
          onChoose={(name) => {
            ports.dispatch({ input: 'terminal-theme', name })
            UiSettingsPreview.of(stateRef.current)
          }}
        />
      </ConfigurationSection>
      <div className="jamat-configuration__actions">
        <button
          className="jamat-configuration__button"
          disabled={buffer === null || saving}
          type="button"
          onClick={() => {
            ports.dispatch({ input: 'reset' })
            UiSettingsPreview.of(stateRef.current)
          }}
        >
          Reset to defaults
        </button>
        <button
          className="jamat-configuration__button jamat-configuration__button--primary"
          disabled={!UiSettingsModel.isModified(state) || saving}
          type="button"
          onClick={() => ports.dispatch({ input: 'save' })}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/**
 * What the three themes are called on screen. `soft` was offered under V1's own name for it,
 * "Windows Terminal", and nobody looking for the colours V1 drew in found it there; it is the
 * generation it comes from that is worth reading, so it is named after that. The value in
 * `config.json` stays `soft` - a file written by hand keeps the name it was written with.
 */
class UiSettingsThemeConst {
  static readonly labels: Record<TerminalThemeName, string> = {
    original: 'Jamat',
    soft: 'Jamat v1',
    vscodeDark: 'VS Code Dark',
  }
}

/** What a control shows the moment it is touched, applied to this document and written nowhere. */
class UiSettingsPreview {
  /** Long enough to swallow a held arrow key at Chromium's repeat rate, short enough to read as
   *  immediate after a mouse release, which arrives as one event and waits out exactly one of these. */
  static readonly settleMillisecondsConst = 200

  static of(state: UiSettingsModelState): void {
    if (state.buffer !== null)
      UiSettingsStore.preview(state.buffer)
  }
}

/**
 * One percentage. The bounds and the step are the caller's `range` - one of the two `UiSettings`
 * holds, the same numbers the main process validates a write against - so a slider cannot offer a
 * value the store would then refuse. A scale and a scroll speed want different ones: a size is
 * nudged 5 % at a time inside a narrow band, a multiplier is moved in quarters up to four times.
 *
 * `onInput` rather than `onChange`, for all of them: the buffer has to follow the thumb, or the
 * readout beside it and the position of the thumb would disagree while it is dragged. Whether a
 * MOVE is also a preview is the caller's decision, and the terminal's font size says no.
 */
function UiSettingsSlider(props: {
  disabled: boolean
  hint: string
  id: string
  label: string
  percent: number
  range: UiSettingsRange
  sliderRef?: React.Ref<HTMLInputElement>
  onSlide: (percent: number) => void
}): React.JSX.Element {
  return (
    <div className="jamat-configuration-ui__row">
      <div className="jamat-configuration-ui__heading">
        {/* A real `for`/`id` pair, which is what makes the label the control's accessible name:
            clicking the words moves the thumb, and nothing here depends on the two sitting next
            to each other in the markup. */}
        <label className="jamat-configuration-ui__label" htmlFor={props.id}>{props.label}</label>
        <span className="jamat-configuration-ui__hint">{props.hint}</span>
      </div>
      <input
        className="jamat-configuration-ui__slider"
        disabled={props.disabled}
        id={props.id}
        max={props.range.maxPercent}
        min={props.range.minPercent}
        ref={props.sliderRef}
        step={props.range.stepPercent}
        type="range"
        value={props.percent}
        // The readout beside it is a second copy of the value, not the only one: without this a
        // screen reader says "115" for a control whose unit appears nowhere in what it announces.
        aria-valuetext={`${props.percent} %`}
        onInput={(event) => props.onSlide(Number(event.currentTarget.value))}
      />
      <span className="jamat-configuration-ui__value">{`${props.percent} %`}</span>
    </div>
  )
}

/**
 * The palette, in the same row shape as a slider. The three names come from `UiSettings`, the list
 * the main process refuses a write against, so the list cannot offer one the store would then turn
 * down.
 *
 * `onChange` rather than `onInput`, unlike the sliders: a list is chosen once and there is nothing
 * to settle, so the terminal slider's trailing timer has no work to do here.
 */
function UiSettingsThemeChoice(props: {
  disabled: boolean
  hint: string
  id: string
  label: string
  name: TerminalThemeName
  onChoose: (name: TerminalThemeName) => void
}): React.JSX.Element {
  return (
    <div className="jamat-configuration-ui__row">
      <div className="jamat-configuration-ui__heading">
        <label className="jamat-configuration-ui__label" htmlFor={props.id}>{props.label}</label>
        <span className="jamat-configuration-ui__hint">{props.hint}</span>
      </div>
      <select
        className="jamat-configuration-ui__select"
        disabled={props.disabled}
        id={props.id}
        value={props.name}
        onChange={(event) => props.onChoose(event.currentTarget.value as TerminalThemeName)}
      >
        {UiSettings.terminalThemesConst.map((name) => (
          <option key={name} value={name}>{UiSettingsThemeConst.labels[name]}</option>
        ))}
      </select>
    </div>
  )
}
