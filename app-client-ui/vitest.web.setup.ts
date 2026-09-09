import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// testing-library's 1 s waitFor default is an idle-machine number. This suite also runs inside the
// publish build gate and on a CI runner, where a mount plus an async panel open regularly takes
// longer, and the failure then reads as a missing element rather than a slow one. Raising the
// ceiling changes no passing test's outcome: waitFor returns the moment its assertion holds.
configure({ asyncUtilTimeout: 5000 })

// globals are off in this project, so testing-library does not clean up on its own: without this
// every test renders into the DOM the previous one left behind.
afterEach(cleanup)

// dockview asks jsdom for things jsdom does not implement. Stubbing them keeps the panel tests
// runnable without a canvas implementation; nothing under test reads what these return.
if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia

// jsdom implements neither PointerEvent nor the capture calls a pointer-driven widget makes on the
// element it drags. Without the event class testing-library falls back to a plain Event, clientX
// never arrives, and a drag test silently measures a gesture of zero length instead of failing.
const windowWithPointer = window as unknown as { PointerEvent?: unknown }
if (!windowWithPointer.PointerEvent)
  windowWithPointer.PointerEvent = class extends MouseEvent {
    readonly pointerId: number

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
HTMLElement.prototype.setPointerCapture = (): void => undefined
HTMLElement.prototype.releasePointerCapture = (): void => undefined

// jsdom has no layout, so it implements no scrolling either. Any list that keeps its cursor visible
// calls this, and without the stub the call is a TypeError rather than a no-op.
Element.prototype.scrollIntoView = (): void => undefined

// dockview measures its container through a ResizeObserver, which jsdom does not implement. The
// stub never reports a size, which is exactly right here: no test asserts on a measured layout.
const windowWithObserver = window as unknown as { ResizeObserver?: unknown }
if (!windowWithObserver.ResizeObserver)
  windowWithObserver.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

// jsdom has no SVG layout either, so a diagram renderer that measures its own labels gets a
// TypeError instead of a box. The numbers are arbitrary: no test asserts on a measured diagram,
// they only need the render to reach the end.
const svgLayout = SVGElement.prototype as unknown as Record<string, unknown>
svgLayout.getBBox = () => ({ x: 0, y: 0, width: 80, height: 20 })
svgLayout.getComputedTextLength = () => 80

HTMLCanvasElement.prototype.getContext = ((kind: string) => kind === '2d'
  ? {
      font: '',
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      canvas: document.createElement('canvas'),
    }
  : null) as typeof HTMLCanvasElement.prototype.getContext
