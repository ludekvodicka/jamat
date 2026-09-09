import { act, cleanup, render, waitFor } from '@testing-library/react'
import { StrictMode, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalFrame } from '../../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type { AppClientUiBridge } from '../../../../shared/appClientUiIpc'
import type { TerminalTarget } from '../../../../shared/terminalTarget'
import { UiSettings } from '../../../../shared/uiSettings'
import { UiSettingsStore } from '../../../uiSettings/uiSettingsStore'
import { TerminalTheme } from '../view/terminalTheme'
import type { TerminalAgentId } from '../input/terminalPromptNewline'
import { type TerminalMenuContext, useTerminalAttachment } from './useTerminalAttachment'

/**
 * xterm measures the DOM and draws into a canvas jsdom does not have, so what is under test here is
 * everything around it: which frames become which calls, in what order, and what the attach asked
 * for. That it renders is xterm's own business.
 */
const xtermMock = vi.hoisted(() => ({
  instances: [] as {
    cols: number
    rows: number
    calls: { method: string; args: unknown[] }[]
    keyHandler: ((event: KeyboardEvent) => boolean) | null
    selection: string
    /** What the surface writes to when a setting changes, the way real xterm carries them. */
    options: { fontSize: number; theme: unknown }
    /** Buffer rows a test seeded, so a click can be scanned into a token. */
    lines: string[]
    type(data: string): void
    select(text: string): void
    sendOsc52(data: string): void
  }[],
  fits: 0,
  /**
   * Mouse events that reached the element xterm draws into, which is where its mouse-reporting
   * forwarder listens. Anything in here is something a TUI would have been told about.
   */
  forwarded: [] as string[],
  resizeObservers: [] as ResizeObserverCallback[],
}))

/** One cell of the fake buffer: what `getCell` fills in, in the shape xterm's own cell answers. */
class FakeCell {
  chars = ' '
  width = 1

  getChars(): string { return this.chars }
  getWidth(): number { return this.width }
}

vi.mock('@xterm/xterm', () => {
  /** One cell of the fake screen, so a click at (55, 5) is column 5 of row 0. */
  const cellPixels = 10
  return {
    Terminal: class {
      cols = 80
      rows = 24
      /** Real xterm carries these and the surface writes to them; without them the block that does
       *  could not have run at all, which is why nothing noticed it was unreached. */
      options: { fontSize: number; theme: unknown }
      /** The width table the surface registers before it writes anything into the buffer. */
      readonly unicode = { activeVersion: '6' }
      readonly calls: { method: string; args: unknown[] }[] = []
      keyHandler: ((event: KeyboardEvent) => boolean) | null = null
      /** What a drag would have left behind; a test sets it through `select`. */
      selection = ''
      lines: string[] = []
      private data: ((data: string) => void) | null = null
      private selectionChange: (() => void) | null = null
      private screen: HTMLElement | null = null
      private readonly oscHandlers = new Map<number, (data: string) => boolean>()

      readonly parser = {
        registerOscHandler: (identifier: number, handler: (data: string) => boolean) => {
          this.oscHandlers.set(identifier, handler)
        },
      }

      constructor(options?: { fontSize?: number; theme?: unknown }) {
        // Taken from the constructor, the way the real one does: a mock that ignored them would
        // start out disagreeing with the surface about the font size, and the first settings frame
        // would then look like a change and refit for nothing.
        this.options = { fontSize: options?.fontSize ?? 14, theme: options?.theme ?? null }
        xtermMock.instances.push(this)
      }

      /**
       * Rows the way xterm hands them out: padded to `cols`, and read cell by cell, because the scan
       * maps a grid column onto a string index and back. Plain ASCII only here - one cell, one code
       * unit - which is what these rows are; a row of wide or astral characters is driven through
       * the real thing in `terminalBufferReader.test.ts`.
       */
      get buffer(): {
        active: {
          getLine(row: number): {
            translateToString(): string
            getCell(column: number, cell: FakeCell): void
          } | undefined
          getNullCell(): FakeCell
          viewportY: number
          length: number
        }
      } {
        return {
          active: {
            getLine: (row: number) => {
              const text = this.lines[row]
              if (text === undefined) return undefined
              const padded = text.padEnd(this.cols, ' ')
              return {
                translateToString: () => padded,
                getCell: (column: number, cell: FakeCell) => {
                  cell.chars = padded[column] ?? ' '
                  cell.width = 1
                },
              }
            },
            getNullCell: () => new FakeCell(),
            viewportY: 0,
            length: this.lines.length,
          },
        }
      }

      attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
        this.keyHandler = handler
      }

      onData(listener: (data: string) => void): void { this.data = listener }
      onSelectionChange(listener: () => void): void { this.selectionChange = listener }
      getSelection(): string { return this.selection }

      clearSelection(): void {
        this.selection = ''
        this.calls.push({ method: 'clearSelection', args: [] })
        this.selectionChange?.()
      }

      /** What xterm would have emitted for a keystroke it kept. */
      type(data: string): void { this.data?.(data) }
      /** A finished selection, announced the way xterm announces one. */
      select(text: string): void {
        this.selection = text
        this.selectionChange?.()
      }

      /** What a TUI would have sent to copy its own selection out. */
      sendOsc52(data: string): void { this.oscHandlers.get(52)?.(data) }
      loadAddon(): void {}

      /**
       * The screen element, measured by the scan and listened on by the mouse-reporting forwarder.
       * The listeners are in the bubble phase, exactly where xterm's own are, so a right click that
       * lands here is one the block above it failed to take.
       */
      open(holder: HTMLElement): void {
        this.calls.push({ method: 'open', args: [] })
        const screen = holder.ownerDocument.createElement('div')
        screen.className = 'xterm-screen'
        const width = this.cols * cellPixels
        const height = this.rows * cellPixels
        screen.getBoundingClientRect = (): DOMRect => ({
          left: 0,
          top: 0,
          right: width,
          bottom: height,
          width,
          height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        })
        screen.addEventListener('mousedown', (event) => {
          xtermMock.forwarded.push(`mousedown:${event.button}`)
        })
        screen.addEventListener('mouseup', (event) => {
          xtermMock.forwarded.push(`mouseup:${event.button}`)
        })
        holder.appendChild(screen)
        this.screen = screen
      }

      reset(): void { this.calls.push({ method: 'reset', args: [] }) }
      write(data: string): void { this.calls.push({ method: 'write', args: [data] }) }
      focus(): void { this.calls.push({ method: 'focus', args: [] }) }

      dispose(): void {
        this.screen?.remove()
        this.screen = null
        this.calls.push({ method: 'dispose', args: [] })
      }

      resize(cols: number, rows: number): void {
        this.cols = cols
        this.rows = rows
        this.calls.push({ method: 'resize', args: [cols, rows] })
      }
    },
  }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void { xtermMock.fits += 1 }
  },
}))

class TerminalBridgeStub {
  readonly calls: { method: string; args: unknown[] }[] = []
  /** Set to make the library refuse the attach; a refusal publishes no frame, so it is all there is. */
  refusal: { code: 'not-live' | 'host-unreachable' | 'unknown-session'; detail: string } | null = null
  /** What the main process's clipboard holds, written by a copy and read by a paste. */
  /** Parks every clipboard read until it is let go, so a test can be inside that await. */
  private heldClipboard: Promise<void> | null = null
  private releaseHeld: (() => void) | null = null

  clipboard = ''
  private listener: ((attachId: string, frame: TerminalFrame) => void) | null = null
  private remoteListener: ((
    remoteEndpointId: string,
    attachId: string,
    frame: TerminalFrame,
  ) => void) | null = null

  holdClipboard(): void {

    this.heldClipboard = new Promise((resolve) => { this.releaseHeld = () => resolve() })

  }


  releaseClipboard(): void {

    this.releaseHeld?.()

    this.heldClipboard = null

  }


  install(): void {
    const bridge = {
      terminal: {
        attach: (attachId: string, spec: unknown) => {
          this.calls.push({ method: 'attach', args: [attachId, spec] })
          if (this.refusal)
            return Promise.resolve({ ok: true as const, value: { ok: false as const, ...this.refusal } })
          return Promise.resolve({ ok: true as const, value: { ok: true as const } })
        },
        input: (attachId: string, data: string) => {
          this.calls.push({ method: 'input', args: [attachId, data] })
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        resize: (attachId: string, cols: number, rows: number) => {
          this.calls.push({ method: 'resize', args: [attachId, cols, rows] })
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        active: (attachId: string, active: boolean) => {
          this.calls.push({ method: 'active', args: [attachId, active] })
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        detach: (attachId: string) => {
          this.calls.push({ method: 'detach', args: [attachId] })
          return Promise.resolve({ ok: true as const, value: undefined })
        },
        clipboardRead: (attachId: string) => {
          this.calls.push({ method: 'clipboardRead', args: [attachId] })
          const answer = { ok: true as const, value: this.clipboard }
          if (this.heldClipboard === null) return Promise.resolve(answer)
          return this.heldClipboard.then(() => answer)
        },
        clipboardWrite: (attachId: string, text: string) => {
          this.calls.push({ method: 'clipboardWrite', args: [attachId, text] })
          this.clipboard = text
          return Promise.resolve({ ok: true as const, value: true })
        },
      },
      remote: {
        terminalAttach: (remoteEndpointId: string, attachId: string, spec: unknown) => {
          this.calls.push({ method: 'remoteAttach', args: [remoteEndpointId, attachId, spec] })
          return Promise.resolve({
            ok: true as const,
            value: {
              ok: true as const,
              value: { attachId, sessionId: String((spec as { sessionId: string }).sessionId) },
            },
          })
        },
        terminalInput: (remoteEndpointId: string, attachId: string, data: string) => {
          this.calls.push({ method: 'remoteInput', args: [remoteEndpointId, attachId, data] })
          return Promise.resolve({ ok: true as const, value: { ok: true as const, value: {} } })
        },
        terminalResize: (
          remoteEndpointId: string,
          attachId: string,
          cols: number,
          rows: number,
        ) => {
          this.calls.push({
            method: 'remoteResize',
            args: [remoteEndpointId, attachId, cols, rows],
          })
          return Promise.resolve({ ok: true as const, value: { ok: true as const, value: {} } })
        },
        terminalActive: (remoteEndpointId: string, attachId: string, active: boolean) => {
          this.calls.push({ method: 'remoteActive', args: [remoteEndpointId, attachId, active] })
          return Promise.resolve({ ok: true as const, value: { ok: true as const, value: {} } })
        },
        terminalDetach: (remoteEndpointId: string, attachId: string) => {
          this.calls.push({ method: 'remoteDetach', args: [remoteEndpointId, attachId] })
          return Promise.resolve({ ok: true as const, value: { ok: true as const, value: {} } })
        },
      },
      clipboard: {
        writeText: (text: string) => {
          this.calls.push({ method: 'clipboardWriteText', args: [text] })
          this.clipboard = text
          return Promise.resolve({ ok: true as const, value: undefined })
        },
      },
      terminalMenu: {
        detect: (attachId: string, capture: unknown) => {
          this.calls.push({ method: 'menuDetect', args: [attachId, capture] })
          return Promise.resolve({
            ok: true as const,
            value: { requestId: 'request-1', detections: [] },
          })
        },
      },
      onTerminalFrame: (callback: (attachId: string, frame: TerminalFrame) => void) => {
        this.listener = callback
        return () => { this.listener = null }
      },
      onRemoteTerminalFrame: (callback: (
        remoteEndpointId: string,
        attachId: string,
        frame: TerminalFrame,
      ) => void) => {
        this.remoteListener = callback
        return () => { this.remoteListener = null }
      },
    }
    ;(window as unknown as { appClient: AppClientUiBridge })
      .appClient = bridge as unknown as AppClientUiBridge
  }

  /** What the main process would have published for the attach that is live. */
  serve(frame: TerminalFrame, attachId = this.attachIds().at(-1)): void {
    if (attachId === undefined) throw new Error('nothing has attached yet')
    this.listener?.(attachId, frame)
  }

  serveRemote(
    remoteEndpointId: string,
    frame: TerminalFrame,
    attachId = this.remoteAttachIds().at(-1),
  ): void {
    if (attachId === undefined) throw new Error('nothing has attached remotely yet')
    this.remoteListener?.(remoteEndpointId, attachId, frame)
  }

  attachIds(): string[] {
    return this.calls.filter((call) => call.method === 'attach').map((call) => String(call.args[0]))
  }

  remoteAttachIds(): string[] {
    return this.calls
      .filter((call) => call.method === 'remoteAttach')
      .map((call) => String(call.args[1]))
  }

  subscribed(): boolean {
    return this.listener !== null
  }
}

/**
 * What the panel would have read out of the sessions document. It is a variable rather than a prop
 * because a test setting it AFTER the render proves the agent is read at the keystroke rather than
 * captured at the attach.
 */
let attachedAgent: TerminalAgentId | null = null
function readAgent(): TerminalAgentId | null {
  return attachedAgent
}

/** What `sendCommand` answered, in the order it was asked - the boolean is the whole contract. */
const sends: boolean[] = []

/** Every byte the hook reported as typed, in order. What `sendCommand` writes is not among them. */
const typed: string[] = []
function onTyped(data: string): void {
  typed.push(data)
}

/** Every menu the hook asked for, in order, and how often it took one back. */
const menus: TerminalMenuContext[] = []
let menuClears = 0
function onMenu(context: TerminalMenuContext | null): void {
  if (context === null) {
    menuClears += 1
    return
  }
  menus.push(context)
}

function Harness(props: {
  sessionId: string
  attachEpoch?: number
  remoteEndpointId?: string
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const target: TerminalTarget = props.remoteEndpointId === undefined
    ? { kind: 'local', sessionId: props.sessionId }
    : { kind: 'remote', remoteEndpointId: props.remoteEndpointId, sessionId: props.sessionId }
  const { state, focus, sendCommand, setActive } = useTerminalAttachment(
    target,
    holder,
    props.attachEpoch ?? 0,
    readAgent,
    onMenu,
    onTyped,
  )
  return (
    <div>
      <div data-testid="holder" ref={holder} />
      <p data-testid="status">{state.status}</p>
      <p data-testid="detail">{state.detail ?? ''}</p>
      <p data-testid="code">{state.refusalCode ?? ''}</p>
      <p data-testid="exit">{state.exitCode === null ? '' : String(state.exitCode)}</p>
      <button type="button" data-testid="focus" onClick={focus}>focus</button>
      <button type="button" data-testid="active" onClick={() => setActive(true)}>active</button>
      <button type="button" data-testid="inactive" onClick={() => setActive(false)}>inactive</button>
      <button
        type="button"
        data-testid="send"
        onClick={() => sends.push(sendCommand('/compact'))}
      >
        send
      </button>
    </div>
  )
}

/**
 * A caller that makes its callback during the render, which is what the ref exists for: the effect
 * writes state as it runs, so an `onMenu` in its keys would re-run it for every one of those writes.
 */
function InlineMenuHarness(props: { sessionId: string }): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const [draws, setDraws] = useState(0)
  useTerminalAttachment(
    { kind: 'local', sessionId: props.sessionId },
    holder,
    0,
    readAgent,
    (context) => { if (context !== null) menus.push(context) },
    onTyped,
  )
  return (
    <div>
      <div data-testid="holder" ref={holder} />
      <button type="button" data-testid="draw" onClick={() => setDraws(draws + 1)}>{draws}</button>
    </div>
  )
}

function InlineAgentHarness(props: {
  sessionId: string
  agent: TerminalAgentId | null
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  useTerminalAttachment(
    { kind: 'local', sessionId: props.sessionId },
    holder,
    0,
    () => props.agent,
    onMenu,
    onTyped,
  )
  return <div data-testid="holder" ref={holder} />
}

describe('app-client-ui/renderer/panels/terminal/useTerminalAttachment', () => {
  let bridge: TerminalBridgeStub

  /** jsdom lays nothing out, so a holder is 0x0 unless a test says otherwise. */
  function sizeHolders(width: number, height: number): void {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: width })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: height })
  }

  function terminal(index = -1): (typeof xtermMock.instances)[number] {
    const found = xtermMock.instances.at(index)
    if (!found) throw new Error('no terminal was built')
    return found
  }

  function snapshotFrame(screen: string, cols = 100, rows = 30): TerminalFrame {
    return {
      type: 'terminal.snapshot',
      projection: {
        runtimeSessionId: 'session-1',
        generation: 1,
        outputEpoch: 1,
        outputSeq: 12,
        raw: screen,
        screen,
        cols,
        rows,
        alive: true,
        lastOutputAt: null,
      },
    }
  }

  /** The frame that makes a surface live and writable, which is what the ordinary attach answers. */
  function attachedFrame(writer: boolean): TerminalFrame {
    return {
      type: 'terminal.attached',
      writer,
      session: {
        runtimeSessionId: 'session-1',
        generation: 1,
        alive: true,
        cols: 80,
        rows: 24,
        outputSeq: 0,
        outputEpoch: 1,
        lastOutputAt: null,
        startedAt: 1,
      },
    }
  }

  /** The element xterm draws into, and where its mouse-reporting forwarder would be listening. */
  function screen(): HTMLElement {
    const element = document.querySelector('.xterm-screen')
    if (element === null) throw new Error('the terminal never opened')
    return element as HTMLElement
  }

  /** A mouse event on the screen element, which is where a real one would land. */
  function mouse(type: 'mousedown' | 'mouseup' | 'contextmenu', init: MouseEventInit = {}): void {
    screen().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
  }

  beforeEach(() => {
    xtermMock.instances.length = 0
    xtermMock.fits = 0
    xtermMock.forwarded.length = 0
    xtermMock.resizeObservers.length = 0
    window.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        xtermMock.resizeObservers.push(callback)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    menus.length = 0
    menuClears = 0
    sends.length = 0
    typed.length = 0
    attachedAgent = null
    sizeHolders(800, 400)
    bridge = new TerminalBridgeStub()
    bridge.install()
  })

  afterEach(() => {
    // Everything on this store is static and outlives a test, so without this the next one
    // reads what the previous one previewed as if it had come from disk.
    UiSettingsStore.reset()
    cleanup()
    sizeHolders(0, 0)
    delete (window as unknown as { appClient?: unknown }).appClient
  })

  it('attaches with the size it measured, once, under an id of its own', () => {
    render(<Harness sessionId="session-1" />)
    expect(bridge.calls).toHaveLength(1)
    const [attachId, spec] = bridge.calls[0].args
    expect(typeof attachId).toBe('string')
    expect(spec).toEqual({ sessionId: 'session-1', size: { cols: 80, rows: 24 } })
    expect(xtermMock.fits).toBe(1)
  })

  it('routes a remote screen through its endpoint for attach, frames, input, size and activity', async () => {
    const endpointId = 'remote-pc::default::stable'
    const view = render(
      <Harness sessionId="remote-session" remoteEndpointId={endpointId} />,
    )
    const attachId = bridge.remoteAttachIds()[0]

    expect(bridge.calls[0]).toEqual({
      method: 'remoteAttach',
      args: [endpointId, attachId, { sessionId: 'remote-session', size: { cols: 80, rows: 24 } }],
    })
    bridge.serveRemote(endpointId, snapshotFrame('remote> '))
    expect(terminal().calls.filter((call) => call.method === 'write')).toEqual([
      { method: 'write', args: ['remote> '] },
    ])

    bridge.serveRemote(endpointId, attachedFrame(true))
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))
    terminal().type('hello')
    view.getByTestId('active').click()
    view.getByTestId('inactive').click()
    xtermMock.resizeObservers[0]?.([], {} as ResizeObserver)
    await waitFor(() => expect(
      bridge.calls.some((call) => call.method === 'remoteResize'),
    ).toBe(true))

    expect(bridge.calls).toContainEqual({
      method: 'remoteInput',
      args: [endpointId, attachId, 'hello'],
    })
    expect(bridge.calls).toContainEqual({
      method: 'remoteActive',
      args: [endpointId, attachId, true],
    })
    expect(bridge.calls).toContainEqual({
      method: 'remoteActive',
      args: [endpointId, attachId, false],
    })

    view.unmount()
    expect(bridge.calls.at(-1)).toEqual({
      method: 'remoteDetach',
      args: [endpointId, attachId],
    })
    expect(bridge.calls.some((call) => call.method === 'attach')).toBe(false)
  })

  /*
   * A paired computer going away is the ONE case where the row and the tab disagree, and both are
   * right: the sessions tree draws connected computers only, so the row goes, while the tab holds
   * the same target, says what happened and takes the reattach when the connection comes back. It
   * asks for nothing itself - the connector reopens the attach - so what is pinned here is that
   * losing the connection neither detaches nor throws the screen away.
   */
  it('holds a remote screen through an outage and takes the reattach', async () => {
    const endpointId = 'remote-pc::default::stable'
    const view = render(<Harness sessionId="remote-session" remoteEndpointId={endpointId} />)
    bridge.serveRemote(endpointId, attachedFrame(true))
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))
    const attachId = bridge.remoteAttachIds()[0]

    bridge.serveRemote(endpointId, {
      type: 'terminal.status',
      status: 'connecting',
      detail: 'Remote AppClientUI disconnected',
    })

    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('connecting'))
    expect(view.getByTestId('detail').textContent).toBe('Remote AppClientUI disconnected')
    expect(bridge.calls.some((call) => call.method === 'remoteDetach')).toBe(false)

    bridge.serveRemote(endpointId, attachedFrame(true), attachId)
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))
    expect(bridge.remoteAttachIds()).toEqual([attachId])
  })

  // dockview keeps a hidden panel at display:none, and fitting a terminal to 0x0 shrinks the PTY to
  // about two columns. V1 measured that; V2 dropped the guard.
  it('asks for no size at all when the holder has none, and does not fit', () => {
    sizeHolders(0, 0)
    render(<Harness sessionId="session-1" />)
    expect(bridge.calls[0].args[1]).toEqual({ sessionId: 'session-1', size: null })
    expect(xtermMock.fits).toBe(0)
  })

  describe('handing the geometry over', () => {
    /*
     * A session can be open in two windows - a dragged tab makes that ordinary - and one attach owns
     * the PTY's size. An attach that goes inactive hands that over, and a LOCAL attach had nothing
     * to hand it over with: `activeRef` had its whole body under the remote arm, and there was no
     * channel for it at all. So a local attach was created active and stayed active for its whole
     * life, and a hidden panel - which measures 0x0 and sends no further resize - kept holding the
     * size of the terminal somebody else was reading.
     */
    it('says so when its tab becomes active and when it stops being', () => {
      const view = render(<Harness sessionId="session-1" />)
      const before = bridge.calls.filter((call) => call.method === 'active').length

      view.getByTestId('active').click()
      view.getByTestId('inactive').click()

      const said = bridge.calls.filter((call) => call.method === 'active')
      expect(said.length).toBe(before + 2)
      expect(said.at(-2)?.args[1]).toBe(true)
      expect(said.at(-1)?.args[1]).toBe(false)
    })

    // The remote arm is unchanged and still goes through the endpoint: a remote attach is not this
    // process's to speak for.
    it('routes a remote screen through its endpoint instead', async () => {
      const endpointId = 'remote-pc::default::stable'
      const view = render(<Harness sessionId="remote-session" remoteEndpointId={endpointId} />)

      view.getByTestId('active').click()

      await waitFor(() => expect(
        bridge.calls.some((call) => call.method === 'remoteActive'),
      ).toBe(true))
      expect(bridge.calls.some((call) => call.method === 'active')).toBe(false)
    })
  })

  describe('the observer path the 0x0 guard was written for', () => {
    /*
     * The guard's stated reason is dockview holding a hidden panel at `display: none`, and that
     * happens HERE - through the observer, not at mount. The mount case was covered and this one was
     * not, so the whole reason the guard exists went unproven: a regression shrinks a real PTY to
     * about two columns whenever a tab is hidden, which is the V1 measurement V2 lost.
     */
    function fireObserver(): void {
      xtermMock.resizeObservers[0]?.([], {} as ResizeObserver)
    }

    it('resizes once after the debounce, however many times the observer fires', async () => {
      vi.useFakeTimers()
      try {
        render(<Harness sessionId="session-1" />)
        const before = bridge.calls.filter((call) => call.method === 'resize').length

        fireObserver()
        fireObserver()
        fireObserver()
        expect(bridge.calls.filter((call) => call.method === 'resize')).toHaveLength(before)

        await vi.advanceTimersByTimeAsync(50)

        expect(bridge.calls.filter((call) => call.method === 'resize')).toHaveLength(before + 1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('sends nothing when the holder was hidden between the fire and the debounce', async () => {
      vi.useFakeTimers()
      try {
        render(<Harness sessionId="session-1" />)
        const before = bridge.calls.filter((call) => call.method === 'resize').length
        const fitsBefore = xtermMock.fits

        // What dockview does to a panel behind another tab.
        sizeHolders(0, 0)
        fireObserver()
        await vi.advanceTimersByTimeAsync(50)

        expect(bridge.calls.filter((call) => call.method === 'resize')).toHaveLength(before)
        // And nothing was fitted either, or xterm would have been sized to the hidden holder.
        expect(xtermMock.fits).toBe(fitsBefore)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('builds the screen out of a snapshot, in the order that keeps the wrapping', () => {
    render(<Harness sessionId="session-1" />)
    bridge.serve(snapshotFrame('prompt> ', 100, 30))
    expect(terminal().calls.filter((call) => call.method !== 'open')).toEqual([
      { method: 'reset', args: [] },
      { method: 'resize', args: [100, 30] },
      { method: 'write', args: ['prompt> '] },
    ])
  })

  it('writes live output and follows a resize the Host reports', () => {
    render(<Harness sessionId="session-1" />)
    bridge.serve({
      type: 'terminal.data',
      runtimeSessionId: 'session-1',
      generation: 1,
      outputEpoch: 1,
      delta: 'hello',
      outputSeq: 20,
      lastOutputAt: 2,
    })
    bridge.serve({
      type: 'terminal.resize',
      runtimeSessionId: 'session-1',
      generation: 1,
      cols: 120,
      rows: 40,
    })
    expect(terminal().calls.filter((call) => call.method !== 'open')).toEqual([
      { method: 'write', args: ['hello'] },
      { method: 'resize', args: [120, 40] },
    ])
  })

  /**
   * A refused attach publishes no frame at all - the library decides before it builds an attachment
   * - so the answer to the call is the only thing that will ever be said about it. `not-live` is the
   * ordinary one: a tab opened straight after create is a session that is still installing.
   */
  it('says why when the library refuses the attach, instead of waiting for a frame', async () => {
    bridge.refusal = { code: 'not-live', detail: 'session-1 has no live runtime' }
    const view = render(<Harness sessionId="session-1" />)

    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('lost'))
    // The code rides in front of the sentence, the same way the tree and the status bar say it.
    expect(view.getByTestId('detail').textContent).toBe('not-live: session-1 has no live runtime')
  })

  it('reads the attach answer and every status the library sends', async () => {
    const view = render(<Harness sessionId="session-1" />)
    expect(view.getByTestId('status').textContent).toBe('connecting')

    bridge.serve({
      type: 'terminal.attached',
      writer: true,
      session: {
        runtimeSessionId: 'session-1',
        generation: 1,
        alive: true,
        cols: 80,
        rows: 24,
        outputSeq: 0,
        outputEpoch: 1,
        lastOutputAt: null,
        startedAt: 1,
      },
    })
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))

    bridge.serve({ type: 'terminal.status', status: 'read-only', detail: 'the lease is gone' })
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('read-only'))
    expect(view.getByTestId('detail').textContent).toBe('the lease is gone')
  })

  it('holds on to an exit, which is where this surface stops', async () => {
    const view = render(<Harness sessionId="session-1" />)
    bridge.serve({
      type: 'terminal.exit',
      runtimeSessionId: 'session-1',
      generation: 1,
      exitCode: 130,
    })
    await waitFor(() => expect(view.getByTestId('exit').textContent).toBe('130'))
    // Nothing is asked of the main process about it: no reopen, no snapshot read.
    expect(bridge.calls.map((call) => call.method)).toEqual(['attach'])
  })

  it('ignores a frame addressed to another attach', () => {
    render(<Harness sessionId="session-1" />)
    bridge.serve(snapshotFrame('not mine'), 'someone-else')
    expect(terminal().calls.filter((call) => call.method === 'write')).toEqual([])
  })

  it('detaches and disposes when the surface goes, and unsubscribes with it', () => {
    const view = render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]
    view.unmount()

    expect(bridge.calls.at(-1)).toEqual({ method: 'detach', args: [attachId] })
    expect(terminal().calls.at(-1)).toEqual({ method: 'dispose', args: [] })
    expect(bridge.subscribed()).toBe(false)
  })

  /**
   * The reason the id is minted per run of the effect. Both older trees turned StrictMode off to get
   * past this; here the two mounts simply never meet, and the first cleanup cannot close the second
   * attach because it does not know its id.
   */
  it('survives a double mount without the first cleanup touching the second attach', () => {
    render(<StrictMode><Harness sessionId="session-1" /></StrictMode>)

    const ids = bridge.attachIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
    expect(bridge.calls.map((call) => `${call.method}:${call.args[0] === ids[0] ? 'first' : 'second'}`))
      .toEqual(['attach:first', 'detach:first', 'attach:second'])
    expect(bridge.subscribed()).toBe(true)
  })

  it('sends what was typed to the session it is attached to', () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]
    terminal().type('ls\r')
    expect(bridge.calls.at(-1)).toEqual({ method: 'input', args: [attachId, 'ls\r'] })
  })

  /**
   * What counts a half-written prompt is fed from here, so all three paths a person's keys take have
   * to reach it - the two that bypass xterm as much as xterm's own - and the one path nobody typed
   * must not, or a compact would erase the evidence against the next one.
   */
  it('reports every key a person pressed, and nothing a command wrote', async () => {
    const view = render(<Harness sessionId="session-1" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    bridge.serve(attachedFrame(true))
    await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))

    terminal().type('ls')
    attachedAgent = 'claude'
    gate(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true }))
    attachedAgent = 'codex'
    gate(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    view.getByTestId('send').click()

    expect(typed).toEqual(['ls', '\x1b[13;2u', '\x1b[27;1;27;1;0;1_'])
  })

  // The gate is installed before the terminal opens, so no keystroke can reach xterm unfiltered.
  it('hands every keystroke to the gate before xterm sees it', () => {
    render(<Harness sessionId="session-1" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    expect(gate(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }))).toBe(false)
    expect(gate(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true }))).toBe(true)
  })

  it('sends Codex a bare Escape as one console key record, and keeps xterm out of it', () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    attachedAgent = 'codex'

    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    expect(gate(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.calls.at(-1))
      .toEqual({ method: 'input', args: [attachId, '\x1b[27;1;27;1;0;1_'] })
  })

  /**
   * xterm has one spelling of Enter, so the CR it would send is the one that submits the prompt. The
   * agent is read here and not at the attach: the record that names it arrives on its own schedule.
   */
  it('sends the agent its own newline for Shift+Enter, and keeps xterm out of it', () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    attachedAgent = 'claude'

    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true })
    expect(gate(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.calls.at(-1)).toEqual({ method: 'input', args: [attachId, '\x1b[13;2u'] })
  })

  it('keeps one attach while its agent reader changes, and reads the newest answer', () => {
    const view = render(<InlineAgentHarness sessionId="session-1" agent={null} />)
    const attachId = bridge.attachIds()[0]
    const first = terminal()

    view.rerender(<InlineAgentHarness sessionId="session-1" agent="claude" />)

    expect(bridge.attachIds()).toEqual([attachId])
    expect(xtermMock.instances).toEqual([first])
    expect(first.calls.filter((call) => call.method === 'dispose')).toEqual([])
    const gate = first.keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    expect(gate(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))).toBe(false)
    expect(bridge.calls.at(-1)).toEqual({ method: 'input', args: [attachId, '\x1b[13;2u'] })
  })

  it('leaves Shift+Enter to the terminal when no agent is behind the session', () => {
    render(<Harness sessionId="session-1" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')

    expect(gate(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }))).toBe(true)
    expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)
  })

  /**
   * Without this the key is a control byte and nothing else: xterm spells Ctrl+V as \x16 and cancels
   * the event, so the browser's own paste never fires either and the agent gets a byte it ignores.
   */
  it('pastes the clipboard in bracketed form and keeps xterm out of it', async () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    bridge.clipboard = 'd:\\shots\\one.png'

    const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true })
    expect(gate(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(bridge.calls.at(-1)).toEqual({
      method: 'input',
      args: [attachId, '\x1b[200~d:\\shots\\one.png\x1b[201~'],
    }))
    expect(typed).toEqual(['\x1b[200~d:\\shots\\one.png\x1b[201~'])
  })

  /**
   * The clipboard read is the one await between the key and the write, and the surface can go away
   * inside it. The write then went to an attach id main had already released, which refuses it and
   * says nothing; for Paste as text a whole line sequence kept firing into it for seconds.
   */
  it('writes nothing when the surface went away while the clipboard was being read', async () => {
    const view = render(<Harness sessionId="session-1" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    bridge.clipboard = 'd:\\shots\\one.png'
    bridge.holdClipboard()

    gate(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true }))
    view.unmount()
    await act(async () => {
      bridge.releaseClipboard()
      await Promise.resolve()
    })

    expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)
  })

  /**
   * A remote attach has no channel for reading the clipboard, so there is nothing to paste. Taking
   * the key anyway left Ctrl+V doing nothing at all and not even reaching the agent as a byte, with
   * no sign that a channel was missing rather than a paste failing.
   */
  it('leaves Ctrl+V to xterm on a remote screen, where there is no clipboard to read', () => {
    render(<Harness sessionId="remote-session" remoteEndpointId="remote-pc::default::stable" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')

    const event = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true })

    expect(gate(event)).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(bridge.calls.some((call) => call.method === 'clipboardRead')).toBe(false)
  })

  /**
   * What makes a font-scale change refit a running terminal and a theme change repaint it without
   * a re-attach. Both were applied by a block no test reached - and could not have reached, because
   * the mock carried no `options` for it to write to, so the first line of it would have thrown.
   */
  describe('settings that change while a terminal is open', () => {
    it('resizes the glyphs and refits the screen when the font scale moves', async () => {
      render(<Harness sessionId="session-1" />)
      const before = terminal().options.fontSize
      const fits = xtermMock.fits

      await act(async () => {
        UiSettingsStore.preview({
          ...UiSettings.defaultValue(),
          terminalFontScalePercent: 150,
        })
      })

      expect(terminal().options.fontSize).to.equal(TerminalTheme.fontSizeOf(150))
      expect(terminal().options.fontSize).to.not.equal(before)
      // The PTY has to be told the new geometry, or the glyphs change size under an unchanged grid.
      expect(xtermMock.fits).to.equal(fits + 1)
    })

    it('repaints on a theme change and asks for no refit, because a colour is not a size', async () => {
      render(<Harness sessionId="session-1" />)
      const before = terminal().options.theme
      const fits = xtermMock.fits

      await act(async () => {
        UiSettingsStore.preview({
          ...UiSettings.defaultValue(),
          terminalTheme: 'vscodeDark',
        })
      })

      expect(terminal().options.theme).to.not.equal(before)
      expect(xtermMock.fits).to.equal(fits)
    })
  })

  it('sends nothing for a paste with an empty clipboard', async () => {
    render(<Harness sessionId="session-1" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')

    expect(gate(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true })))
      .toBe(false)
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'clipboardRead'))
      .toBe(true))
    expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)
  })

  it('copies the selection on Ctrl+C and clears it, taking the key from the terminal', () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')
    terminal().selection = '│ quoted line'

    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    expect(gate(event)).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.calls.at(-1))
      .toEqual({ method: 'clipboardWrite', args: [attachId, 'quoted line'] })
    expect(terminal().calls.filter((call) => call.method === 'clearSelection')).toHaveLength(1)
  })

  // The interrupt stays whole: with nothing selected the key is the agent's, not the clipboard's.
  it('leaves Ctrl+C to the terminal when nothing is selected', () => {
    render(<Harness sessionId="session-1" />)
    const gate = terminal().keyHandler
    if (gate === null) throw new Error('no key handler was attached')

    expect(gate(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true)
    expect(bridge.calls.filter((call) => call.method === 'clipboardWrite')).toHaveLength(0)
  })

  it('copies a finished selection by itself, once, and never an empty one', () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]

    terminal().select('picked with the mouse')
    terminal().select('picked with the mouse')
    terminal().select('')

    expect(bridge.calls.filter((call) => call.method === 'clipboardWrite'))
      .toEqual([{ method: 'clipboardWrite', args: [attachId, 'picked with the mouse'] }])
  })

  /**
   * The copy path while a TUI tracks the mouse: xterm makes no selection of its own there, so the
   * application selects for itself and sends the copy as an escape xterm's core does not handle.
   */
  it('writes what an OSC 52 escape carried, and ignores a query', () => {
    render(<Harness sessionId="session-1" />)
    const attachId = bridge.attachIds()[0]

    terminal().sendOsc52(`c;${btoa('from inside the TUI')}`)
    expect(bridge.calls.at(-1))
      .toEqual({ method: 'clipboardWrite', args: [attachId, 'from inside the TUI'] })

    terminal().sendOsc52('c;?')
    expect(bridge.calls.filter((call) => call.method === 'clipboardWrite')).toHaveLength(1)
  })

  it('focuses the terminal when asked, and never on its own', () => {
    const view = render(<Harness sessionId="session-1" />)
    expect(terminal().calls.filter((call) => call.method === 'focus')).toHaveLength(0)
    view.getByTestId('focus').click()
    expect(terminal().calls.filter((call) => call.method === 'focus')).toHaveLength(1)
  })

  /**
   * The one path into a session that nobody typed, and the layer of the Compact button that lives
   * here: what is written goes through THIS surface's own attach, so a command can only ever reach
   * the session this attachment is holding.
   */
  describe('a command sent from outside the screen', () => {
    it('writes it through the attach it holds once the surface is live', async () => {
      const view = render(<Harness sessionId="session-1" />)
      const attachId = bridge.attachIds()[0]
      bridge.serve(attachedFrame(true))
      await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))

      view.getByTestId('send').click()

      expect(sends).toEqual([true])
      expect(bridge.calls.at(-1)).toEqual({ method: 'input', args: [attachId, '/compact'] })
    })

    it('writes nothing while the surface is still connecting', () => {
      const view = render(<Harness sessionId="session-1" />)

      view.getByTestId('send').click()

      expect(sends).toEqual([false])
      expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)
    })

    // An attach that is not the writer: the keystrokes of whoever is looking at it are not
    // travelling either, and a command is no more entitled to than they are.
    it('writes nothing for a read-only surface', async () => {
      const view = render(<Harness sessionId="session-1" />)
      bridge.serve(attachedFrame(false))
      await waitFor(() => expect(view.getByTestId('status').textContent).toBe('read-only'))

      view.getByTestId('send').click()

      expect(sends).toEqual([false])
      expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)
    })

    it('writes nothing once the terminal has been lost', async () => {
      const view = render(<Harness sessionId="session-1" />)
      bridge.serve(attachedFrame(true))
      await waitFor(() => expect(view.getByTestId('status').textContent).toBe('live'))
      bridge.serve({ type: 'terminal.status', status: 'lost', detail: 'the Host went away' })
      await waitFor(() => expect(view.getByTestId('status').textContent).toBe('lost'))

      view.getByTestId('send').click()

      expect(sends).toEqual([false])
      expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)
    })
  })

  /**
   * The half of this that makes the feature safe rather than useful. While a TUI tracks the mouse,
   * xterm forwards the press to the PTY and the application reads a right click as
   * paste-from-clipboard: unblocked, a right click inside a live agent empties the clipboard into
   * its prompt. The block is in the capture phase, and `contextmenu` is a different event that has
   * to survive it.
   */
  describe('the right button', () => {
    it('reaches neither xterm nor the PTY, while the context menu still fires', () => {
      render(<Harness sessionId="session-1" />)

      mouse('mousedown', { button: 2 })
      mouse('mouseup', { button: 2 })

      expect(xtermMock.forwarded).toEqual([])
      expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(0)

      mouse('contextmenu', { button: 2 })
      expect(menus).toHaveLength(1)
    })

    /**
     * A remote screen has no detector to ask and no clipboard channel to read, so the only thing a
     * menu could offer is a copy of what is selected - and with nothing selected there is nothing
     * to offer at all. The arm that decides this was entered by no test: replacing its body with a
     * throw left the whole terminal folder green.
     */
    it('opens a remote menu only over a selection, and says which kind it is', () => {
      render(<Harness sessionId="remote-session" remoteEndpointId="remote-pc::default::stable" />)

      mouse('contextmenu', { button: 2 })

      expect(menus).toEqual([])

      terminal().selection = 'picked with the mouse'
      mouse('contextmenu', { button: 2, clientX: 30, clientY: 8 })

      expect(menus).toHaveLength(1)
      expect(menus[0].kind).to.equal('remote')
      expect(menus[0].hasSelection).to.equal(true)
      expect(menus[0].position).toEqual({ x: 30, y: 8 })
    })

    // Selection, scrolling and everything else the left button does is xterm's, and stays xterm's.
    it('leaves every other button alone', () => {
      render(<Harness sessionId="session-1" />)

      mouse('mousedown', { button: 0 })
      mouse('mouseup', { button: 0 })

      expect(xtermMock.forwarded).toEqual(['mousedown:0', 'mouseup:0'])
    })

    it('pastes on Shift+right click and opens no menu, the way V1 did', async () => {
      render(<Harness sessionId="session-1" />)
      const attachId = bridge.attachIds()[0]
      bridge.clipboard = 'd:\\shots\\one.png'

      mouse('contextmenu', { button: 2, shiftKey: true })

      await waitFor(() => expect(bridge.calls.at(-1)).toEqual({
        method: 'input',
        args: [attachId, '\x1b[200~d:\\shots\\one.png\x1b[201~'],
      }))
      expect(menus).toEqual([])
    })

    it('hands over where the click was, what was under it and what was selected', async () => {
      render(<Harness sessionId="session-1" />)
      const attachId = bridge.attachIds()[0]
      terminal().lines = ['open Q:\\notes\\report.md now']
      terminal().selection = 'picked with the mouse'

      mouse('contextmenu', { button: 2, clientX: 55, clientY: 5 })

      expect(menus).toHaveLength(1)
      expect(menus[0].position).toEqual({ x: 55, y: 5 })
      expect(menus[0].hasSelection).toBe(true)

      // The one promise the menu has, and the attach id never left the effect to make it.
      const menu = menus[0]
      if (menu.kind !== 'local') throw new Error(`Unexpected terminal menu: ${menu.kind}`)
      const answer = await menu.detect()
      expect(answer).toEqual({ ok: true, value: { requestId: 'request-1', detections: [] } })
      expect(bridge.calls.at(-1)).toEqual({
        method: 'menuDetect',
        args: [attachId, {
          token: 'Q:\\notes\\report.md',
          selection: 'picked with the mouse',
          contextText: 'open Q:\\notes\\report.md now',
          fallbackToken: null,
        }],
      })
    })

    it('says there is nothing to copy when nothing is selected', () => {
      render(<Harness sessionId="session-1" />)

      mouse('contextmenu', { button: 2 })

      expect(menus[0].hasSelection).toBe(false)
      menus[0].copySelection()
      expect(bridge.calls.filter((call) => call.method === 'clipboardWrite')).toHaveLength(0)
    })

    // The document half goes through the attach-bound clipboard channels and nothing else: there is
    // one way to the clipboard from this surface and the menu is not a second one.
    it('binds paste and copy to the attach the click happened on', async () => {
      render(<Harness sessionId="session-1" />)
      const attachId = bridge.attachIds()[0]
      bridge.clipboard = 'first\nsecond'
      terminal().selection = '│ quoted line'

      mouse('contextmenu', { button: 2 })
      menus[0].paste()

      await waitFor(() => expect(bridge.calls.at(-1)).toEqual({
        method: 'input',
        args: [attachId, '\x1b[200~first\nsecond\x1b[201~'],
      }))

      menus[0].copySelection()
      expect(bridge.calls.at(-1))
        .toEqual({ method: 'clipboardWrite', args: [attachId, 'quoted line'] })
    })

    /**
     * A menu is bound to the attach the click happened on: every item it holds writes through that
     * attach. Once the attach is replaced - a restart, an epoch bump - the menu can only fail, so
     * the run that replaces it takes the menu with it.
     */
    it('takes back the menu when the attach it was bound to is replaced', () => {
      const view = render(<Harness sessionId="session-1" attachEpoch={0} />)
      mouse('contextmenu', { button: 2 })
      expect(menus).toHaveLength(1)
      const cleared = menuClears

      view.rerender(<Harness sessionId="session-1" attachEpoch={1} />)

      expect(menuClears).toBe(cleared + 1)
      expect(bridge.attachIds()).toHaveLength(2)
    })

    // A callback made during the render is not part of the attach's identity. Held in the keys it
    // would be: the effect writes state as it runs, and each write would mint another attach.
    it('attaches once for a caller that hands over a new callback every render', () => {
      const view = render(<InlineMenuHarness sessionId="session-1" />)

      view.getByTestId('draw').click()
      view.getByTestId('draw').click()

      expect(bridge.attachIds()).toHaveLength(1)
      mouse('contextmenu', { button: 2 })
      expect(menus).toHaveLength(1)
    })

    it('pastes as text one line at a time, off a single clipboard read', async () => {
      render(<Harness sessionId="session-1" />)
      const attachId = bridge.attachIds()[0]
      bridge.clipboard = 'alpha\nbeta'

      mouse('contextmenu', { button: 2 })
      menus[0].pasteAsText()

      await waitFor(() => expect(bridge.calls.filter((call) => call.method === 'input')).toEqual([
        { method: 'input', args: [attachId, '\x1b[200~alpha\n\x1b[201~'] },
        { method: 'input', args: [attachId, '\x1b[200~beta\x1b[201~'] },
      ]))
      expect(bridge.calls.filter((call) => call.method === 'clipboardRead'))
        .toEqual([{ method: 'clipboardRead', args: [attachId] }])
      expect(typed).toEqual(['\x1b[200~alpha\n\x1b[201~', '\x1b[200~beta\x1b[201~'])
    })

    // The lines are spaced out over seconds, so the run outlives the surface easily. Every write
    // after this point would be addressed to an attach that has been detached.
    it('writes no further line once the surface it was pasting into is gone', async () => {
      vi.useFakeTimers()
      try {
        const view = render(<Harness sessionId="session-1" />)
        bridge.clipboard = 'alpha\nbeta\ngamma'

        mouse('contextmenu', { button: 2 })
        menus[0].pasteAsText()
        await vi.advanceTimersByTimeAsync(0)
        expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(1)

        view.unmount()
        await vi.advanceTimersByTimeAsync(1000)

        expect(bridge.calls.filter((call) => call.method === 'input')).toHaveLength(1)
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('leaves no listener behind, so a second mount answers one click once', () => {
      render(<StrictMode><Harness sessionId="session-1" /></StrictMode>)

      mouse('mousedown', { button: 2 })
      mouse('contextmenu', { button: 2 })

      expect(xtermMock.forwarded).toEqual([])
      expect(menus).toHaveLength(1)
    })
  })
})
