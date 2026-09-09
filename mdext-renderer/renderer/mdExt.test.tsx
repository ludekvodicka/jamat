import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FileViewerLimits } from '../../lib-orchestrator/fileViewer/fileViewerLimits'
import { MdExtBudget } from './mdExtBudget'
import { MdExtNames } from './mdExtNames'
import { MdExtRenderer } from './mdExtRenderer'
import { MdExtSecurity } from './mdExtSecurity'
import { MdExtCode } from './renderers/mdExtCode'
import { MdExtDiagramEngine } from './renderers/mdExtDiagramEngine'
import { renderArchify } from './renderers/archify/index'

describe('mdext-renderer/renderer', () => {
  afterEach(cleanup)

  /*
   * The per-call ceilings bound ONE fence: 64 KiB of source to highlight, 50 000 characters of
   * diagram spec. Nothing bounded how many. A generated API report with 500 fences is 500
   * synchronous Shiki calls chained through the microtask queue with no yield, on the thread that
   * draws the terminal and the sessions tree as well.
   */
  /*
   * The confirmation timer had no cleanup, while the pattern with one is twenty lines above it in
   * the same component. A fence copied and then scrolled out of a long document left a timer holding
   * a setter for a tree that is gone.
   */
  it('clears the copy confirmation timer when the fence goes away', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    })
    const cleared = vi.spyOn(window, 'clearTimeout')
    const view = render(<MdExtCode language="text" source="hello" highlight={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument())
    const before = cleared.mock.calls.length

    view.unmount()

    expect(cleared.mock.calls.length).toBeGreaterThan(before)
    cleared.mockRestore()
  })

  it('gives one document a fixed number of highlighted fences and drawn diagrams', () => {
    const budget = new MdExtBudget()

    const highlighted = Array.from({ length: 200 }, (_, line) => budget.allowsHighlight(line))
    expect(highlighted.filter(Boolean)).toHaveLength(FileViewerLimits.highlightedFencesMax)
    expect(highlighted.slice(0, FileViewerLimits.highlightedFencesMax).every(Boolean)).toBe(true)

    const drawn = Array.from({ length: 200 }, (_, line) => budget.allowsDiagram(line))
    expect(drawn.filter(Boolean)).toHaveLength(FileViewerLimits.diagramsMax)

    // The two are counted apart: a document full of diagrams still highlights its fences.
    expect(new MdExtBudget().allowsHighlight(0)).toBe(true)
  })

  /*
   * Decided once per fence and remembered, or a re-render would move a fence in and out of the
   * budget while somebody read it - a diagram rendering again from the top each time.
   */
  it('gives the same fence the same answer however often it is asked', () => {
    const budget = new MdExtBudget()
    for (let line = 0; line < FileViewerLimits.diagramsMax; line += 1) budget.allowsDiagram(line)

    expect(budget.allowsDiagram(0)).toBe(true)
    expect(budget.allowsDiagram(0)).toBe(true)
    expect(budget.allowsDiagram(999)).toBe(false)
    expect(budget.allowsDiagram(999)).toBe(false)
  })

  /*
   * Its near-twin in `fileViewerContent` clears first. Keeping the previous block's HTML while the
   * new source highlighted put one text on screen and another behind Copy, and the remount that used
   * to hide it is gone.
   */
  it('does not leave the previous fence highlighted under a new source', async () => {
    const view = render(<MdExtCode language="ts" source="const first = 1" highlight />)
    // Drawn by shiki, which is the state that used to survive the source change.
    await waitFor(() => expect(view.container.querySelector('.mdext-code-shiki')).not.toBeNull())

    view.rerender(<MdExtCode language="ts" source="const second = 2" highlight />)

    // Immediately, before the new highlight comes back: the old text is gone and the new source is
    // on screen as plain text. Kept, the fence showed one text and Copy carried another.
    expect(view.container.textContent).not.toContain('const first = 1')
    expect(view.container.textContent).toContain('const second = 2')
    await waitFor(() => expect(view.container.querySelector('.mdext-code-shiki')).not.toBeNull())
  })

  it('keeps the V1 mdext blocks and five offline diagram families', () => {
    const onLink = vi.fn()
    const view = render(
      <MdExtRenderer
        source={'---\ntitle: Demo\n---\n:::warning[Watch]\nBody\n:::\n\n[bad](javascript:alert(1))'}
        resolveImage={() => Promise.resolve(null)}
        onLink={onLink}
      />,
    )
    expect(view.container.querySelector('.mdext-frontmatter')?.textContent).toContain('metadata')
    expect(view.container.querySelector('.mdext-callout-warning')?.textContent).toContain('Watch')
    expect(view.container.querySelector('.mdext-blocked-link')?.textContent).toBe('bad')
    fireEvent.click(view.getByText('bad'))
    expect(onLink).not.toHaveBeenCalled()
    for (const language of ['mermaid', 'dot', 'vega-lite', 'archify', 'svg'])
      expect(MdExtDiagramEngine.supports(language), language).toBe(true)
  })

  const newlineConst = String.fromCharCode(10)

  it('keeps the class of every callout and every chip tone past the sanitizer', () => {
    const source = [
      ...MdExtNames.calloutsConst
        .map((name) => [`:::${name}[Title]`, 'Body', ':::'].join(newlineConst)),
      '::status{build=passing review=pending release=blocked owner=someone}',
    ].join(`${newlineConst}${newlineConst}`)

    const view = render(
      <MdExtRenderer source={source} resolveImage={() => Promise.resolve(null)} onLink={vi.fn()} />,
    )

    for (const className of [...MdExtNames.calloutClassesConst, ...MdExtNames.chipClassesConst])
      expect(view.container.querySelector(`.${className}`), className).not.toBeNull()
  })

  it('renders every supported mdext directive and GFM extension', () => {
    const source = [
      ':::note[Note title]\nNote body\n:::',
      ':::tip[Tip title]\nTip body\n:::',
      ':::warning[Warning title]\nWarning body\n:::',
      ':::danger[Danger title]\nDanger body\n:::',
      ':::important[Important title]\nImportant body\n:::',
      ':::details[More]\nHidden body\n:::',
      '::status{build=passing review=pending release=blocked}',
      '| name | value |\n| --- | --- |\n| one | two |',
      '- [x] complete\n- [ ] open',
    ].join('\n\n')
    const view = render(
      <MdExtRenderer
        source={source}
        resolveImage={() => Promise.resolve(null)}
        onLink={() => undefined}
      />,
    )
    for (const kind of ['note', 'tip', 'warning', 'danger', 'important'])
      expect(view.container.querySelector(`.mdext-callout-${kind}`), kind).not.toBeNull()
    expect(view.container.querySelector('.mdext-details summary')?.textContent).toBe('More')
    expect(view.container.querySelectorAll('.mdext-status .mdext-chip')).toHaveLength(3)
    expect(view.container.querySelector('.mdext-chip-good')?.textContent).toBe('build: passing')
    expect(view.container.querySelector('.mdext-chip-warn')?.textContent).toBe('review: pending')
    expect(view.container.querySelector('.mdext-chip-bad')?.textContent).toBe('release: blocked')
    expect(view.container.querySelector('table')?.textContent).toContain('one')
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
  })

  it('renders all five archify diagram types to SVG', () => {
    const diagrams = [
      {
        schema_version: 1,
        diagram_type: 'architecture',
        meta: { title: 'Architecture', viewBox: [360, 240] },
        components: [
          { id: 'web', type: 'frontend', label: 'Web', pos: [40, 80], size: [80, 50] },
          { id: 'api', type: 'backend', label: 'API', pos: [220, 80], size: [80, 50] },
        ],
        boundaries: [],
        connections: [{ from: 'web', to: 'api' }],
      },
      {
        schema_version: 1,
        diagram_type: 'workflow',
        meta: { title: 'Workflow' },
        lanes: [{ id: 'main', label: 'Main' }],
        nodes: [
          { id: 'start', lane: 'main', col: 0, type: 'frontend', label: 'Start' },
          { id: 'finish', lane: 'main', col: 3, type: 'backend', label: 'Finish' },
        ],
        edges: [{ from: 'start', to: 'finish' }],
      },
      {
        schema_version: 1,
        diagram_type: 'sequence',
        meta: { title: 'Sequence', viewBox: [360, 360] },
        participants: [
          { id: 'user', type: 'external', label: 'User' },
          { id: 'api', type: 'backend', label: 'API' },
        ],
        messages: [{ from: 'user', to: 'api', y: 200, label: 'call' }],
      },
      {
        schema_version: 1,
        diagram_type: 'dataflow',
        meta: { title: 'Data flow', viewBox: [500, 400] },
        stages: [{ label: 'Input' }, { label: 'Output' }],
        nodes: [
          { id: 'source', type: 'frontend', label: 'Source', stage: 0, row: 0 },
          { id: 'sink', type: 'database', label: 'Sink', stage: 1, row: 0 },
        ],
        flows: [{ from: 'source', to: 'sink', label: 'data' }],
      },
      {
        schema_version: 1,
        diagram_type: 'lifecycle',
        meta: { title: 'Lifecycle', viewBox: [980, 660] },
        lanes: [{ id: 'main', label: 'Main' }],
        states: [
          { id: 'start', type: 'start', label: 'Start', lane: 'main', col: 0 },
          { id: 'done', type: 'success', label: 'Done', lane: 'main', col: 2 },
        ],
        transitions: [{ from: 'start', to: 'done' }],
      },
    ]
    for (const diagram of diagrams) {
      const svg = renderArchify(diagram)
      expect(svg, diagram.diagram_type).toMatch(/^\s*<svg\b/)
      expect(svg, diagram.diagram_type).toContain(diagram.meta.title)
    }
  })

  /*
   * The image half of the pair the link half already had. Both mdExt tests passed
   * `resolveImage: () => null` and neither source held an image, so reducing the guard to
   * `value.trim() || null` - `data:`, `javascript:` and `//host/x` all reaching the resolver, which
   * is a main-process call taking a string a document author wrote - left every web suite green.
   */
  it('sends only a relative reference to the image resolver', async () => {
    const asked: string[] = []
    const view = render(
      <MdExtRenderer
        source={[
          '![data](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
          '![script](javascript:alert(1))',
          '![host](//example.test/x.png)',
          '![absolute](https://example.test/x.png)',
          '![relative](./pictures/x.png)',
        ].join('\n\n')}
        resolveImage={(reference) => {
          asked.push(reference)
          return Promise.resolve(null)
        }}
        onLink={vi.fn()}
      />,
    )

    expect(asked).toEqual(['./pictures/x.png'])
    // Four blocked, and each keeps its alt text so the reader sees something was there.
    expect([...view.container.querySelectorAll('.mdext-blocked-img')].map((node) => node.textContent))
      .toEqual(['data', 'script', 'host', 'absolute', 'relative'])
  })

  /*
   * The pair the component actually uses, rather than the renderer on its own: a label the engine
   * failed to escape makes invalid XML, and `MdExtSecurity.svg` answers `''` for that - so the
   * symptom of a broken escape is diagrams silently disappearing, not markup getting through.
   * Changing `esc` to `String(value ?? '')` left every web suite green, because the archify test
   * asserted `/^\s*<svg\b/` and `toContain(title)`, which almost any output satisfies.
   */
  it('keeps a diagram legible when its labels carry XML characters', async () => {
    const title = 'A & B <needs> "escaping"'
    const rendered = await MdExtDiagramEngine.render('archify', JSON.stringify({
      schema_version: 1,
      diagram_type: 'dataflow',
      meta: { title, viewBox: [500, 400] },
      stages: [{ label: 'In & out' }, { label: 'Done' }],
      nodes: [
        { id: 'source', type: 'frontend', label: '<script>', stage: 0, row: 0 },
        { id: 'sink', type: 'database', label: '"quoted"', stage: 1, row: 0 },
      ],
      flows: [{ from: 'source', to: 'sink', label: 'a & b' }],
    }))

    const safe = MdExtSecurity.svg(rendered)

    // Not empty: a label the two sides spell differently makes the XML unparseable, and this
    // method answers '' for that - a diagram that vanishes rather than one that leaks.
    expect(safe).toMatch(/^\s*<svg\b/)
    expect(safe).toContain('&amp;')
    expect(safe).not.toContain('<script>')
    const parsed = new DOMParser().parseFromString(safe, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    // The words survive for a reader, escaped rather than dropped.
    expect(parsed.documentElement.getAttribute('aria-label')).toContain(title)
    expect(parsed.documentElement.textContent).toContain('<script>')
    expect(parsed.documentElement.textContent).toContain('"quoted"')
  })

  it('keeps a mermaid diagram legible once the sanitizer has run', async () => {
    const raw = await MdExtDiagramEngine.render('mermaid', `flowchart TD
      A[Start] --> B{Choice}
      B --> C[End]
    `)
    // The labels have to be native text: the sanitizer forbids foreignObject, so an HTML label
    // reaches the page as an empty box.
    expect(raw).not.toContain('foreignObject')
    const safe = MdExtSecurity.svg(raw)
    expect(safe).toContain('Start')
    expect(safe).toContain('Choice')
    // Mermaid paints itself through one stylesheet that reaches for its own gradient. Dropping
    // the sheet over that url leaves every node filled the SVG default black.
    const style = safe.match(/<style>([^<]*)</)?.[1] ?? ''
    expect(style).toContain('.node rect')
    expect(style).toContain('url(#')
  }, 30_000)

  /**
   * The frame the answer goes into is sandboxed and inherits the app's CSP, so none of this could
   * have run anyway. It is checked here because that frame is one attribute away from allowing
   * scripts, and a sanitizer nobody measures is the half of a pair that quietly stops working.
   */
  it('takes what acts or fetches out of a whole page and leaves the page itself', () => {
    const safe = MdExtSecurity.page(
      '<html><head><base href="https://x/"><meta http-equiv="refresh" content="0;url=https://x">'
      + '<link rel="stylesheet" href="https://x/a.css"><style>.card{color:red}</style></head>'
      + '<body><h1 onclick="alert(1)">Report</h1><script>alert(1)</script>'
      + '<iframe src="https://x"></iframe><object data="x.swf"></object>'
      + '<a href="javascript:alert(1)">go</a><a href="https://x/page">out</a>'
      + '<p>Body text</p></body></html>',
    )

    expect(safe).not.toMatch(/script|iframe|object|<base|<meta|<link|onclick/i)
    // What a page IS survives: its own styling, its headings, its text and its ordinary links.
    expect(safe).toContain('.card{color:red}')
    expect(safe).toContain('Report')
    expect(safe).toContain('Body text')
    expect(safe).toContain('href="https://x/page"')
    expect(safe).not.toContain('javascript:')
  })

  it('sanitizes scripts, foreign objects and external SVG references', () => {
    const safe = MdExtSecurity.svg(
      '<svg><style>@import url(https://x)</style><script>alert(1)</script>'
      + '<foreignObject>x</foreignObject><image href="https://x"/>'
      + '<filter><feImage href="https://x"/></filter>'
      + '<style>.x{background-image:image-set("https://x")}</style>'
      + '<style>.y{fill:url(#grad)}</style>'
      + '<path onload="x" style="fill:url(https://x)"/><path marker-end="url(#arrow)"/>'
      + '<circle /></svg>',
    )
    expect(safe).not.toMatch(/script|foreignObject|feImage|image-set|https:|onload|@import/)
    expect(safe).toContain('marker-end="url(#arrow)"')
    expect(safe).toContain('.y{fill:url(#grad)}')
    expect(safe).toContain('circle')
  })
})
