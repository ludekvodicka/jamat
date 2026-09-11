import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import type {
  TerminalFrame,
} from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { TerminalDetectResult } from '../../../../../lib-orchestrator/terminalDetector/terminalDetectorApi.types'
import type { IpcResult } from '../../../../shared/appClientUiIpc'
import { type TerminalTarget, TerminalTargetCodec } from '../../../../shared/terminalTarget'
import { UiSettings } from '../../../../shared/uiSettings'
import { UiSettingsStore } from '../../../uiSettings/uiSettingsStore'
import { TerminalBufferScan } from '../menu/terminalBufferScan'
import { TerminalClipboard } from '../input/terminalClipboard'
import { TerminalInterrupt } from '../input/terminalInterrupt'
import { TerminalKeyGate } from '../input/terminalKeyGate'
import { TerminalWheelRepeat } from '../input/terminalWheelRepeat'
import { type TerminalRefusalCode, TerminalTransports } from './terminalTransport'
import { type TerminalAgentId, TerminalPromptNewline } from '../input/terminalPromptNewline'
import { TerminalLinks } from '../view/terminalLinks'
import { TerminalTheme } from '../view/terminalTheme'
import { TerminalUnicode } from '../view/terminalUnicode'

export interface TerminalSurfaceState {
  /** `live` is the only one with nothing to say; the rest carry the reason in `detail`. */
  status: 'connecting' | 'live' | 'read-only' | 'lost'
  detail: string | null
  /** From the refused attach or from the status frame; null where neither had a code to give. */
  refusalCode: TerminalRefusalCode
  /**
   * The runtime behind this screen is over. Separate from `exitCode` because the two are different
   * facts and only one of them is always there: a session attached to AFTER it exited is told that
   * it ended, and told the code only where the Host has one.
   */
  ended: boolean
  /** Set once and never cleared: the end of a session is the end of this surface. */
  exitCode: number | null
}

/**
 * One right click, with everything a menu over it can do already bound to the attach it happened on.
 * The attach id stays inside the run of the effect that minted it: what leaves is closures over it,
 * which is also why this is built at the click rather than kept anywhere.
 */
interface TerminalMenuContextBase {
  /** This click. A menu drawn for the one before it is a component instance that has been dropped. */
  clickId: string
  position: { x: number; y: number }
  /** Read at the click: the menu is drawn once and does not ask again. */
  hasSelection: boolean
  paste(): void
  pasteAsText(): void
  copySelection(): void
}

export type TerminalMenuContext = TerminalMenuContextBase & (
  /**
   * `detect` is what was under the click, sent to be given meaning. The buffer scan happened at the
   * click; the selection is read at the call, so a menu opened over one carries whatever it holds by
   * then. A remote screen has no detector to ask, which is why the two arms differ at all.
   */
  | { kind: 'local'; detect(): Promise<IpcResult<TerminalDetectResult>> }
  | { kind: 'remote' }
)

export interface TerminalAttachmentHandle {
  state: TerminalSurfaceState
  focus(): void
  /**
   * Bytes into this attach that nobody typed - what the bar's Compact button sends. False is a
   * surface that is not `live`, and nothing is written for it: a read-only, connecting or lost
   * screen is one whose keystrokes are not travelling either.
   */
  sendCommand(data: string): boolean
  setActive(active: boolean): void
}

class TerminalSurfaceConst {
  /** V1's value, and the reason it is not larger: this is a second copy of what the Host already rings. */
  static readonly scrollback = 10_000
  /** V1's value. One frame of settling is not enough and two are not noticeable. */
  static readonly fitDebounceMilliseconds = 50
}

/**
 * One xterm, attached to one session, for as long as this surface is mounted.
 *
 * **The whole thing is one effect on purpose.** The terminal, the subscriptions, the observer and the
 * attach are one lifetime: anything that split them would let a frame arrive for a terminal that had
 * been disposed. It is also what makes a React double mount harmless - each run mints its own attach
 * id, so the cleanup of the first can never close the second, and no exclusive resource is taken
 * that the two could fight over. V1 and V2 both turned StrictMode off to avoid this; this surface
 * does not need it off, whatever the root ends up doing.
 *
 * **Nothing here is remembered across attaches.** The screen is rebuilt from whatever snapshot the
 * library sends, which is also the answer to a stream that outran its cursor: the library re-attaches
 * without one and this sees another snapshot, so there is a single path to a drawn screen.
 */
export function useTerminalAttachment(
  target: TerminalTarget,
  holderRef: RefObject<HTMLDivElement | null>,
  /**
   * Bumped to attach again into the same panel, which is what starting an interrupted session back
   * up means here. A new run of the effect IS a new attach, so the state it describes goes with it.
   */
  attachEpoch: number,
  /**
   * Which agent is behind this screen, read at the keystroke rather than at the attach: the record
   * that says so arrives on its own schedule, and a value captured here would be the null a snapshot
   * had not filled in yet. Null is a session with no agent, where the shell owns the key.
   */
  readAgent: () => TerminalAgentId | null,
  /**
   * A right click that was not `Shift`+right click, and null where the attach a menu was bound to
   * has been replaced. Read lazily like `readAgent` and NOT an effect key: who receives the menu is
   * no part of the attach's identity, and a callback made during the render would otherwise
   * re-attach the terminal - through a state write of its own, without end.
   */
  onMenu: (context: TerminalMenuContext | null) => void,
  /**
   * Every byte this person's keys produced, told to whoever counts what stands in the prompt. The
   * synthetic path beside it, `sendCommand`, deliberately reports nothing: nobody typed that.
   */
  onTyped: (data: string) => void,
): TerminalAttachmentHandle {
  const [state, setState] = useState<TerminalSurfaceState>({
    status: 'connecting',
    detail: null,
    refusalCode: null,
    ended: false,
    exitCode: null,
  })
  const terminalRef = useRef<Terminal | null>(null)
  /**
   * The attach id lives in the run of the effect that minted it, so the way to write into it does
   * too. Held here and cleared by that run's own cleanup: a command sent after the surface is gone
   * finds nothing rather than an id that has been detached.
   */
  const senderRef = useRef<((data: string) => void) | null>(null)
  const activeRef = useRef<((active: boolean) => void) | null>(null)
  const readAgentRef = useRef(readAgent)
  const onMenuRef = useRef(onMenu)
  const onTypedRef = useRef(onTyped)
  // Committed rather than written mid-render. A render can be started and thrown away, and a
  // discarded one would leave these pointing at callbacks belonging to a tree that was never
  // committed - which in this surface means a wrong `readAgent` answer becoming wrong bytes, since
  // Shift+Enter is spelled differently per agent. Nothing here discards a render today; the rule is
  // cheap and the day it stops being true is not one anybody would notice.
  useEffect(() => {
    readAgentRef.current = readAgent
    onMenuRef.current = onMenu
    onTypedRef.current = onTyped
  })

  useEffect(() => {
    const holder = holderRef.current
    if (holder === null) return
    setState({
      status: 'connecting',
      detail: null,
      refusalCode: null,
      ended: false,
      exitCode: null,
    })
    onMenuRef.current(null)
    const attachId = crypto.randomUUID()
    /*
     * Local or remote, decided here and nowhere else in this file. It used to be decided again at
     * every use - eleven `remoteEndpointId === null` in this effect - and nothing tied those
     * branches together, so one of them was left unfinished and compiled: paste took the key from
     * xterm and then returned at once for a remote screen.
     */
    const transport = TerminalTransports.of(target).attachment(attachId)
    const settings = UiSettingsStore.current()
    const appearance = TerminalTheme.current(settings)
    const terminal = new Terminal({
      scrollback: TerminalSurfaceConst.scrollback,
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      theme: appearance.theme,
      // The terminal's own half of the scroll setting, for the half of it xterm scrolls: its own
      // viewport over its own scrollback. No event of ours is involved and the window's
      // `WheelSpeed` leaves this surface alone. An agent that takes the mouse scrolls ITSELF and
      // never sees this option, which is what `TerminalWheelRepeat` below is for.
      scrollSensitivity: UiSettings.scrollFactorOf(settings.terminalScrollSpeedPercent),
      // An OSC 8 hyperlink is opened by us, or by xterm's own dialog that cannot open anything here.
      linkHandler: TerminalLinks.handlerConst,
      // Not for win32 key encoding, whatever it used to say: that rides on `vtExtensions`, which
      // this constructor leaves at its default, so DECSET 9001 is ignored either way. It is kept
      // because the proposed surface is what `terminal.parser` and `terminal.buffer` were behind,
      // and both are read here.
      allowProposedApi: true,
    })
    // Before anything is written: a table registered after the first frame would leave what is
    // already in the buffer measured the old way.
    TerminalUnicode.apply(terminal)
    // The other half of the same speed, read per event rather than applied: the agent that scrolls
    // itself is sent as many notches as the setting asks for. Nothing to undo - xterm holds one
    // handler for the life of the terminal, and the terminal is disposed with this attachment.
    TerminalWheelRepeat.install(
      terminal,
      () => UiSettings.scrollFactorOf(UiSettingsStore.current().terminalScrollSpeedPercent),
    )
    /**
     * Every copy leaves through here, so the gutter is stripped in one place. The write goes to the
     * main process because `navigator.clipboard` is gated on a secure origin and on focus: under the
     * packaged `file://` renderer it rejects silently, which is a copy that works all through
     * development and stops working in the release.
     */
    const copyOut = (text: string): void => {
      transport.clipboardWrite(TerminalClipboard.withoutQuoteGutter(text))
    }

    // Set by the cleanup below. Everything that awaits between a key and a write reads it after the
    // await: the surface can be gone by then.
    let disposed = false

    const pasteIn = async (): Promise<void> => {
      const read = transport.clipboardRead
      if (read === undefined) return
      const text = await read()
      // The clipboard read is the one await between the key and the write, and the surface can go
      // away inside it: the tab closes, or a restart mints a new attach. Without this the write goes
      // to an attach id main has already released, which refuses it and says nothing.
      if (disposed || text === null) return
      const bytes = TerminalClipboard.pasteOf(text)
      if (bytes === null) return
      onTypedRef.current(bytes)
      transport.input(bytes)
    }

    // The same clipboard, through the same attach-bound channel, laid out as lines the agent will
    // let you edit. There is one way to the clipboard from here and this is not a second one.
    let pasteAsTextRun: (() => void) | null = null
    const pasteAsText = async (): Promise<void> => {
      const read = transport.clipboardRead
      if (read === undefined) return
      const text = await read()
      // Same as above, and worse: a run started after the cleanup keeps firing writes into a dead
      // attach for as long as the line sequence lasts, because the cleanup cancelled a run that had
      // not started yet.
      if (disposed || text === null) return
      // The lines are spaced out over seconds, so a run outlives the click that started it: whatever
      // replaces it - a second paste, or this attach going away - stops it first.
      pasteAsTextRun?.()
      pasteAsTextRun = TerminalClipboard.pasteAsTextByLines(text, (data) => {
        onTypedRef.current(data)
        transport.input(data)
      })
    }

    // Before `open`, so no keystroke can reach xterm unfiltered: a command's accelerator would
    // otherwise become bytes as well as running the command. The gate answers first, because a key
    // it takes away is not this terminal's to spell at all.
    terminal.attachCustomKeyEventHandler((event) => {
      if (!TerminalKeyGate.allowXterm(event)) return false
      // Taken from xterm rather than left to it: xterm spells Ctrl+V as the control byte \x16 and
      // cancels the event, which also stops the browser's own paste from ever firing. Left alone,
      // the key reaches the agent as a byte it does nothing with and nothing is pasted at all.
      if (TerminalClipboard.isPasteKey(event)) {
        // A transport with no clipboard read has nothing to paste, so the key is left to xterm
        // rather than swallowed into a handler that returns at once. The remote one is that
        // transport today - `remote:terminal-*` carries attach, input, resize, active and detach and
        // nothing else - and it says so by not having the member at all. Copying out works, so this
        // is half a pair; the trigger for the other half is a clipboard read on the peer protocol.
        if (transport.clipboardRead === undefined) return true
        event.preventDefault()
        void pasteIn()
        return false
      }
      // Only ever a copy while there IS something selected. Without a selection Ctrl+C is the
      // interrupt and stays whole - it falls through to xterm and the agent gets its \x03.
      if (TerminalClipboard.isCopyKey(event)) {
        const selected = terminal.getSelection()
        if (selected.length === 0) return true
        event.preventDefault()
        copyOut(selected)
        terminal.clearSelection()
        return false
      }
      const interrupt = TerminalInterrupt.sequenceOf(event, readAgentRef.current())
      if (interrupt !== null) {
        event.preventDefault()
        onTypedRef.current(interrupt)
        transport.input(interrupt)
        return false
      }
      const newline = TerminalPromptNewline.sequenceOf(event, readAgentRef.current())
      if (newline === null) return true
      // Sent here rather than through xterm, which has one spelling of Enter and would send the CR
      // that submits the prompt. `preventDefault` is what stops the browser adding one as well.
      event.preventDefault()
      onTypedRef.current(newline)
      transport.input(newline)
      return false
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(holder)
    terminal.onData((data) => {
      onTypedRef.current(data)
      transport.input(data)
    })
    senderRef.current = (data) => transport.input(data)
    /*
     * Both arms, and the local one is why this exists at all: an attach that goes inactive hands
     * the PTY's geometry over, and a local attach had nothing to hand it over WITH. One session
     * open in two windows - which a dragged tab makes ordinary - left the hidden panel owning
     * the size, because a hidden panel measures 0x0 and sends no further resize, so the terminal
     * somebody was actually reading stayed at the hidden one's size until its window was resized.
     */
    activeRef.current = (active) => { transport.setActive(active) }

    /*
     * Copy-on-select, and immediately rather than debounced: a selection made with the mouse and
     * pasted with the next keystroke must not outrun its own write. Deduped by the raw selection so
     * a redraw does not write it again, and an empty selection is never copied - clearing a
     * selection would otherwise wipe the clipboard.
     *
     * This fires only where xterm makes a LOCAL selection: a plain shell, or a Shift-drag past an
     * application's mouse tracking. While a TUI tracks the mouse it does its own selecting and the
     * OSC 52 handler below is the copy path instead.
     */
    let lastCopied = ''
    terminal.onSelectionChange(() => {
      const selected = terminal.getSelection()
      if (selected.length === 0 || selected === lastCopied) return
      lastCopied = selected
      copyOut(selected)
    })

    /*
     * OSC 52 is the only way a selection made INSIDE a TUI comes out. With mouse tracking on, the
     * drag is forwarded to the application, xterm makes no selection of its own and the handler
     * above never fires; the application selects for itself and sends the copy as an escape. xterm
     * has no handler for it in core and the clipboard addon is not loaded, so without this the copy
     * is dropped without a sound.
     */
    terminal.parser.registerOscHandler(52, (data) => {
      const text = TerminalClipboard.textOfOsc52(data)
      if (text !== null) copyOut(text)
      return true
    })

    /*
     * The right button, taken off xterm's mouse-reporting forwarder before it can reach it. While a
     * TUI tracks the mouse - Claude Code turns it on with \x1b[?1000h - xterm forwards the press to
     * the PTY, and the application reads a right click as paste-from-clipboard: without this block,
     * a right click inside a live agent dumps the clipboard into its prompt instead of opening a
     * menu. Capture phase and `stopPropagation`, never `preventDefault`: the forwarder listens on a
     * descendant of the holder in the bubble phase, so this has to run before it, and `contextmenu`
     * is a separate event that must still fire.
     */
    const blockRightMouse = (event: MouseEvent): void => {
      if (event.button === 2) event.stopPropagation()
    }
    holder.addEventListener('mousedown', blockRightMouse, true)
    holder.addEventListener('mouseup', blockRightMouse, true)

    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      // V1 parity, and the way past the menu for someone who only ever wanted to paste.
      if (event.shiftKey) {
        void pasteIn()
        return
      }
      const capture = TerminalBufferScan.capture(
        TerminalBufferScan.readerOf(terminal, holder),
        event.clientX,
        event.clientY,
      )
      const common: TerminalMenuContextBase = {
        clickId: crypto.randomUUID(),
        position: { x: event.clientX, y: event.clientY },
        hasSelection: terminal.getSelection().length > 0,
        paste: () => { void pasteIn() },
        pasteAsText: () => { void pasteAsText() },
        copySelection: () => {
          const selected = terminal.getSelection()
          if (selected.length > 0) copyOut(selected)
        },
      }
      // Which menu is which is the transport's own answer: only a transport with a detector can
      // offer the items that need one, and the selection is read at the call rather than at the
      // click. A transport without one has Copy and nothing else, so it is drawn only over a
      // selection.
      const detect = transport.detect
      if (detect !== undefined)
        onMenuRef.current({
          ...common,
          kind: 'local',
          detect: () => detect({ ...capture, selection: terminal.getSelection() || null }),
        })
      else if (common.hasSelection)
        onMenuRef.current({ ...common, kind: 'remote' })
    }
    holder.addEventListener('contextmenu', onContextMenu)

    terminalRef.current = terminal

    const onFrame = (frame: TerminalFrame): void => {
      if (frame.type === 'terminal.snapshot') {
        // In this order: a write into a terminal of the wrong width wraps where the Host did not.
        terminal.reset()
        terminal.resize(frame.projection.cols, frame.projection.rows)
        terminal.write(frame.projection.screen)
      }
      else if (frame.type === 'terminal.data') terminal.write(frame.delta)
      else if (frame.type === 'terminal.delta') terminal.write(frame.data)
      else if (frame.type === 'terminal.resize') terminal.resize(frame.cols, frame.rows)
      else if (frame.type === 'terminal.attached')
        // A runtime the Host still has and no longer runs answers an attach with the screen it died
        // on. There is no exit event coming - that already happened - so what it says about itself
        // in the ack is the only place this learns it is over.
        setState((current) => ({
          ...current,
          status: frame.writer ? 'live' : 'read-only',
          detail: null,
          ended: current.ended || !frame.session.alive,
          exitCode: frame.session.alive ? current.exitCode : frame.session.exitCode ?? null,
        }))
      else if (frame.type === 'terminal.status')
        setState((current) => ({
          ...current,
          status: frame.status,
          detail: frame.detail,
          refusalCode: frame.code ?? null,
        }))
      // The end of the session, and the end of this surface: the library has already closed the
      // attach, so nothing more is addressed to it.
      else if (frame.type === 'terminal.exit')
        setState((current) => ({ ...current, ended: true, exitCode: frame.exitCode }))
      else
        throw new Error(`Unknown terminal frame: ${JSON.stringify(frame)}`)
    }

    const offFrames = transport.onFrame(onFrame)

    /**
     * The guard that has to hold everywhere a fit can be reached. dockview keeps a hidden panel at
     * `display: none`, where a holder measures 0x0 and fitting to it shrinks the terminal to about
     * two columns; V1 measured that and V2 dropped the guard.
     */
    const measure = (): { cols: number; rows: number } | null => {
      const element = holderRef.current
      if (element === null || element.offsetWidth === 0 || element.offsetHeight === 0) return null
      fit.fit()
      return { cols: terminal.cols, rows: terminal.rows }
    }

    /**
     * Every fit is offered to the PTY, including one that lands on the size it already has. Whether
     * it travels is decided in the main process, where the last size actually sent is kept: a second
     * opinion here would be a second thing to keep right, and the reason the answer matters is a
     * ConPTY reflow that corrupts wide characters, which is not this side's to judge.
     */
    const applyFit = (): void => {
      const size = measure()
      if (size === null) return
      transport.resize(size.cols, size.rows)
    }

    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (fitTimer !== null) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        fitTimer = null
        applyFit()
      }, TerminalSurfaceConst.fitDebounceMilliseconds)
    })
    observer.observe(holder)

    /*
     * The size and the colours change the terminal in place rather than through the effect's keys: a
     * dependency on either would re-attach, and a re-attach is a reset, another snapshot and a
     * visible flash for something xterm does on its own.
     *
     * The step is 5 % on a 13px base, so neighbouring steps land on the same pixel size - 105 % and
     * 110 % are both 14px. Those change nothing here, or every step of a dragged slider would
     * renegotiate the PTY geometry for a screen that looks identical. A size that did change IS a
     * resize, the same one a window resize sends, and the main process dedupes it against what it
     * last sent.
     *
     * The theme takes no fit: a colour does not change the cell size, so a refit after it would ask
     * the PTY to reflow for nothing. The name it is compared against lives in THIS run of the
     * effect, beside the terminal it describes - a ref outliving them both would answer for a
     * terminal that has been disposed.
     */
    let appliedTheme = settings.terminalTheme
    const offSettings = UiSettingsStore.subscribe((value) => {
      const fontSize = TerminalTheme.fontSizeOf(value.terminalFontScalePercent)
      if (terminal.options.fontSize !== fontSize) {
        terminal.options.fontSize = fontSize
        applyFit()
      }
      // No fit: a multiplier on the wheel changes nothing about the cell, so the PTY is not told.
      // Only the xterm half is written here; the repeat reads the store itself, per event.
      const sensitivity = UiSettings.scrollFactorOf(value.terminalScrollSpeedPercent)
      if (terminal.options.scrollSensitivity !== sensitivity)
        terminal.options.scrollSensitivity = sensitivity
      if (appliedTheme !== value.terminalTheme) {
        appliedTheme = value.terminalTheme
        terminal.options.theme = TerminalTheme.current(value).theme
      }
    })

    /*
     * The geometry rides the attach frame rather than following it: a resize sent afterwards races
     * the snapshot, and the snapshot would then describe a screen of the wrong width.
     *
     * The answer is read rather than dropped. A refused attach publishes NO frame - the library
     * decides before it builds an attachment - so this is the only thing that will ever be said
     * about it, and a surface left on `connecting` waits for a frame that is not coming. `not-live`
     * is the ordinary one: a session opened straight after create is still installing.
     */
    void transport.attach(measure()).then((refusal) => {
      if (disposed || refusal === null) return
      setState((current) => ({
        ...current,
        status: 'lost',
        detail: refusal.detail,
        refusalCode: refusal.code,
      }))
    })

    return () => {
      disposed = true
      senderRef.current = null
      activeRef.current = null
      offFrames()
      offSettings()
      observer.disconnect()
      holder.removeEventListener('mousedown', blockRightMouse, true)
      holder.removeEventListener('mouseup', blockRightMouse, true)
      holder.removeEventListener('contextmenu', onContextMenu)
      if (fitTimer !== null) clearTimeout(fitTimer)
      pasteAsTextRun?.()
      // Ordered after the attach on the same channel, so it always finds it. Nothing is stopped by
      // it: a closed tab is not a decision about a PTY.
      transport.detach()
      terminalRef.current = null
      terminal.dispose()
    }
  }, [TerminalTargetCodec.key(target), holderRef, attachEpoch])

  const focus = useCallback(() => {
    terminalRef.current?.focus()
  }, [])

  /**
   * Re-made when the status moves and at no other time, so what registers this keeps one identity
   * for as long as the answer would be the same one.
   */
  const sendCommand = useCallback((data: string): boolean => {
    const send = senderRef.current
    if (send === null || state.status !== 'live') return false
    send(data)
    return true
  }, [state.status])

  const setActive = useCallback((active: boolean): void => {
    activeRef.current?.(active)
  }, [])

  return { state, focus, sendCommand, setActive }
}
