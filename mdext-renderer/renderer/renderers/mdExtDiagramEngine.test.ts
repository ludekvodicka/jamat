import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MdExtDiagramEngine } from './mdExtDiagramEngine'

const mermaidMock = vi.hoisted(() => ({
  /** Renders asked for, in order, each with the hook a test uses to finish it - or not. */
  calls: [] as { source: string; settle(svg: string): void; fail(reason: Error): void }[],
}))

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: (_id: string, source: string) => new Promise<{ svg: string }>((resolve, reject) => {
      mermaidMock.calls.push({
        source,
        settle: (svg) => resolve({ svg }),
        fail: (reason) => reject(reason),
      })
    }),
  },
}))

const vizMock = vi.hoisted(() => ({ instances: 0, rendered: [] as string[] }))

vi.mock('@viz-js/viz', () => ({
  instance: () => {
    vizMock.instances += 1
    return Promise.resolve({
      renderString: (source: string) => {
        vizMock.rendered.push(source)
        return '<svg></svg>'
      },
    })
  },
}))

/**
 * What one document can do to the thread that draws every panel of the window.
 *
 * The engine is a static, so the mermaid queue and the Graphviz heap outlive any single diagram -
 * which is the whole point of both, and also what made a single wedged render fatal.
 */
describe('mdext-renderer/renderer/renderers/mdExtDiagramEngine', () => {
  beforeEach(() => {
    mermaidMock.calls = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Lets the queued work reach mermaid without letting the deadline fire. Timer ticks rather than
   * bare microtasks, because the queued function starts with a dynamic `import`.
   */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 5; turn += 1) await vi.advanceTimersByTimeAsync(1)
  }

  describe('a render that never comes back', () => {
    /*
     * One queue for the whole window, because mermaid keeps global state. Rejection was handled and
     * a render that never RETURNS was not, so one wedged diagram left every later one waiting for
     * the life of the process.
     */
    it('stops waiting after the deadline and frees the queue for the next diagram', async () => {
      const wedged = MdExtDiagramEngine.render('mermaid', 'graph TD; A-->B')
      const wedgedAssertion = expect(wedged).rejects.toThrow(/did not finish within 15000 ms/)
      await settle()
      expect(mermaidMock.calls).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(15_001)
      await wedgedAssertion

      // The queue moved on, which is the whole point: the wedged render is still wedged.
      const next = MdExtDiagramEngine.render('mermaid', 'graph TD; C-->D')
      await settle()
      expect(mermaidMock.calls).toHaveLength(2)
      mermaidMock.calls[1]!.settle('<svg id="second"></svg>')
      expect(await next).toBe('<svg id="second"></svg>')
    })

    /*
     * The timer is what has to go, not the rejection: a settled promise ignores a later reject
     * anyway, so a deadline left running is invisible in the answer and real in the process - one
     * pending 15-second timer per diagram in the document.
     */
    it('clears the deadline for a render that did come back', async () => {
      const cleared = vi.spyOn(window, 'clearTimeout')
      const running = MdExtDiagramEngine.render('mermaid', 'graph TD; A-->B')
      await settle()
      const before = cleared.mock.calls.length

      mermaidMock.calls[0]!.settle('<svg id="first"></svg>')
      expect(await running).toBe('<svg id="first"></svg>')

      expect(cleared.mock.calls.length).toBeGreaterThan(before)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await running).toBe('<svg id="first"></svg>')
      cleared.mockRestore()
    })

    it('clears the deadline for a render that failed as well', async () => {
      const cleared = vi.spyOn(window, 'clearTimeout')
      const failing = MdExtDiagramEngine.render('mermaid', 'graph TD; A-->B')
      const failingAssertion = expect(failing).rejects.toThrow(/bad syntax/)
      await settle()
      const before = cleared.mock.calls.length

      mermaidMock.calls[0]!.fail(new Error('bad syntax'))
      await failingAssertion

      expect(cleared.mock.calls.length).toBeGreaterThan(before)
      cleared.mockRestore()
    })
  })

  describe('a diagram whose panel is gone', () => {
    /*
     * Closing a tab used to stop the component LISTENING and nothing else, so every queued render
     * still took its turn - on a queue every other panel is waiting on.
     */
    it('is dropped rather than rendered when its turn comes', async () => {
      const first = MdExtDiagramEngine.render('mermaid', 'graph TD; A-->B')
      const closed = new AbortController()
      const second = MdExtDiagramEngine.render('mermaid', 'graph TD; C-->D', closed.signal)
      const secondAssertion = expect(second).rejects.toThrow(/no longer on screen/)
      await settle()

      closed.abort()
      mermaidMock.calls[0]!.settle('<svg id="first"></svg>')
      expect(await first).toBe('<svg id="first"></svg>')
      await secondAssertion

      // Never reached mermaid at all.
      expect(mermaidMock.calls).toHaveLength(1)
    })
  })

  describe('how much one diagram may declare', () => {
    /*
     * Every archify validator compares each PAIR of items, and an item with no `pos` has NaN
     * coordinates where the overlap test answers true - so everything overlaps everything. About
     * 4 000 ids fit under the character cap and produce roughly 8 million sentences, joined into one
     * exception message and drawn into the DOM.
     */
    it('refuses a spec with more items than it will draw, before any validator runs', async () => {
      const nodes = Array.from({ length: 401 }, (_, index) => ({
        id: `n${index}`,
        type: 'frontend',
        label: `n${index}`,
        stage: 0,
        row: index,
      }))

      await expect(MdExtDiagramEngine.render('archify', JSON.stringify({
        schema_version: 1,
        diagram_type: 'dataflow',
        meta: { title: 'Too much', viewBox: [500, 400] },
        stages: [{ label: 'In' }, { label: 'Out' }],
        nodes,
        flows: [],
      }))).rejects.toThrow(/declares 403 items; at most 400 are drawn/)
    })

    it('shortens a validator complaint before it becomes DOM text', async () => {
      // Under the item ceiling, and every one of them overlapping every other: 100 nodes stacked on
      // one row is 4 950 sentences, which is what the quadratic loop behind the ceiling produces.
      const nodes = Array.from({ length: 100 }, (_, index) => ({
        id: `n${index}`,
        type: 'frontend',
        label: `node ${index}`,
        stage: 0,
        row: 0,
      }))

      const refusal = await MdExtDiagramEngine.render('archify', JSON.stringify({
        schema_version: 1,
        diagram_type: 'dataflow',
        meta: { title: 'Overlapping', viewBox: [500, 400] },
        stages: [{ label: 'In' }, { label: 'Out' }],
        nodes,
        flows: [],
      })).then(() => null, (error: unknown) => error as Error)

      expect(refusal).to.be.instanceOf(Error)
      expect(refusal!.message.length).toBeLessThan(4_200)
      expect(refusal!.message).toMatch(/\.\.\. and \d+ more characters$/)
    })
  })

  describe('the Graphviz heap', () => {
    /*
     * `instance()` from `@viz-js/viz` is not a singleton factory - its `dist/viz.js` is
     * `Module().then(m => new Viz(m))` - so calling it per fence allocated a WASM heap per fence.
     */
    it('is built once for the window, however many dot fences there are', async () => {
      vizMock.instances = 0
      vizMock.rendered = []

      expect(await MdExtDiagramEngine.render('dot', 'digraph { a -> b }')).toBe('<svg></svg>')
      expect(await MdExtDiagramEngine.render('gv', 'digraph { c -> d }')).toBe('<svg></svg>')
      expect(await MdExtDiagramEngine.render('graphviz', 'digraph { e -> f }')).toBe('<svg></svg>')

      expect(vizMock.rendered).toHaveLength(3)
      expect(vizMock.instances).toBe(1)
    })
  })
})
