import { FileViewerLimits } from '../../../lib-orchestrator/fileViewer/fileViewerLimits'
import { ErrorText } from '../../../lib-orchestrator/shared/errorText'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'

interface MdExtDiagramEngineEntry {
  languages: readonly string[]
  render(source: string, signal: AbortSignal | undefined): Promise<string>
}

export class MdExtDiagramEngine {
  static readonly maxSourceCharacters = FileViewerLimits.diagramSourceCharacters

  private static mermaidSequence = 0
  /**
   * One Graphviz heap for the window.
   *
   * `instance()` from `@viz-js/viz` is not a singleton factory - its `dist/viz.js` is
   * `Module().then(m => new Viz(m))` - so calling it per fence allocated a WASM heap per fence.
   * Kept here the way `FileHighlighter` keeps its one Shiki.
   */
  private static viz: Promise<{ renderString(source: string, options: { format: string }): string }>
    | null = null
  private static mermaidQueue: Promise<unknown> = Promise.resolve()
  private static readonly engines: readonly MdExtDiagramEngineEntry[] = [
    {
      languages: ['mermaid'],
      render: (source, signal) => MdExtDiagramEngine.mermaid(source, signal),
    },
    { languages: ['dot', 'gv', 'graphviz'], render: (source) => MdExtDiagramEngine.dot(source) },
    { languages: ['vega-lite', 'vegalite'], render: (source) => MdExtDiagramEngine.vegaLite(source) },
    { languages: ['archify'], render: (source) => MdExtDiagramEngine.archify(source) },
    { languages: ['svg'], render: (source) => MdExtDiagramEngine.rawSvg(source) },
  ]

  static supports(language: string): boolean {
    return MdExtDiagramEngine.engines.some((engine) => engine.languages.includes(language))
  }

  /**
   * `signal` is what a closed tab has to say. A diagram whose panel is gone used to keep its place
   * in the queue and render anyway, because the component only stopped LISTENING to the answer.
   */
  static render(language: string, source: string, signal?: AbortSignal): Promise<string> {
    const engine = MdExtDiagramEngine.engines.find((item) => item.languages.includes(language))
    if (!engine) throw new Error(`Unknown diagram engine: ${language}`)
    return engine.render(source, signal)
  }

  /**
   * One queue for the whole window, because mermaid keeps global state and two renders at once
   * corrupt each other. That is also what made a single wedged render fatal: rejection was handled,
   * a render that never RETURNS was not, and every mermaid diagram in every panel then waited on it
   * for the life of the process.
   *
   * The chain now waits on the BOUNDED promise, so the deadline frees it whatever the render does.
   */
  private static mermaid(source: string, signal: AbortSignal | undefined): Promise<string> {
    const run = MdExtDiagramEngine.mermaidQueue.then(async () => {
      // Asked after the wait, not before it: a tab can be closed while this sits in the queue, and
      // the whole point is not to render for a panel that is gone.
      if (signal?.aborted) throw new Error('The diagram is no longer on screen')
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'dark',
        // Mermaid's default label is HTML inside a foreignObject, and the sanitizer forbids that
        // tag, so every label arrived empty. Native `text` is what survives the boundary.
        htmlLabels: false,
      })
      const id = `jamat-mdext-mermaid-${MdExtDiagramEngine.mermaidSequence++}`
      return (await mermaid.render(id, source)).svg
    })
    const bounded = MdExtDiagramEngine.withDeadline(run, 'mermaid')
    MdExtDiagramEngine.mermaidQueue = bounded.then(() => undefined, () => undefined)
    return bounded
  }

  /**
   * The work, or a refusal once the deadline is past - whichever comes first.
   *
   * The work is not cancelled, because a synchronous render cannot be; what is bounded is how long
   * anything WAITS for it.
   */
  private static withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error(
          `The ${what} diagram did not finish within `
          + `${FileViewerLimits.diagramRenderMilliseconds} ms`)),
        FileViewerLimits.diagramRenderMilliseconds,
      )
      work.then(
        (value) => { window.clearTimeout(timer); resolve(value) },
        (reason: unknown) => { window.clearTimeout(timer); reject(reason as Error) },
      )
    })
  }

  private static async dot(source: string): Promise<string> {
    if (MdExtDiagramEngine.viz === null)
      MdExtDiagramEngine.viz = import('@viz-js/viz').then(({ instance }) => instance())
    return (await MdExtDiagramEngine.viz).renderString(source, { format: 'svg' })
  }

  private static async vegaLite(source: string): Promise<string> {
    let parsed: unknown
    try { parsed = JSON.parse(source) }
    catch { throw new Error('Invalid Vega-Lite JSON spec') }
    const spec = JsonShape.record(parsed)
    if (spec === null) throw new Error('Vega-Lite spec must be an object')
    const [vegaLite, vega] = await Promise.all([import('vega-lite'), import('vega')])
    const userConfig = JsonShape.record(spec.config) ?? {}
    const themed = {
      ...spec,
      config: {
        background: 'transparent',
        ...userConfig,
        title: MdExtDiagramEngine.vegaSection(userConfig, 'title', {
          color: MdExtDiagramEngine.token('--color-text-1'),
          subtitleColor: MdExtDiagramEngine.token('--color-text-3'),
        }),
        axis: MdExtDiagramEngine.vegaSection(userConfig, 'axis', {
          labelColor: MdExtDiagramEngine.token('--color-text-2'),
          titleColor: MdExtDiagramEngine.token('--color-text-1'),
          gridColor: MdExtDiagramEngine.token('--color-border-hairline'),
          domainColor: MdExtDiagramEngine.token('--color-border-frame'),
          tickColor: MdExtDiagramEngine.token('--color-border-frame'),
        }),
        legend: MdExtDiagramEngine.vegaSection(userConfig, 'legend', {
          labelColor: MdExtDiagramEngine.token('--color-text-2'),
          titleColor: MdExtDiagramEngine.token('--color-text-1'),
        }),
        view: MdExtDiagramEngine.vegaSection(userConfig, 'view', {
          stroke: MdExtDiagramEngine.token('--color-border-frame'),
        }),
      },
    }
    const compiled = vegaLite.compile(
      themed as unknown as Parameters<typeof vegaLite.compile>[0],
    ).spec
    const loader = vega.loader()
    loader.load = () => Promise.reject(new Error('External resources are disabled'))
    loader.sanitize = () => Promise.reject(new Error('External resources are disabled'))
    const view = new vega.View(vega.parse(compiled), { renderer: 'none', loader })
    try { return await view.toSVG() }
    finally { view.finalize() }
  }

  /**
   * The two ceilings the vendored archify tree has none of, held here so that tree stays a plain
   * vendor copy.
   *
   * Every archify validator compares each PAIR of items to find overlapping boxes, and an item with
   * no `pos` has NaN coordinates where the overlap test answers true - so everything overlaps
   * everything. About 4 000 ids fit under the character cap and produce roughly 8 million sentences,
   * joined into one exception message and drawn into the DOM.
   */
  private static async archify(source: string): Promise<string> {
    let parsed: unknown
    try { parsed = JSON.parse(source) }
    catch { throw new Error('Invalid archify JSON spec') }
    MdExtDiagramEngine.assertDiagramItems(parsed)
    const { renderArchify } = await import('./archify/index')
    try { return renderArchify(parsed) }
    catch (error) { throw new Error(MdExtDiagramEngine.shortened(error)) }
  }

  /** Everything the spec declares, whatever the diagram type calls its arrays. */
  private static assertDiagramItems(parsed: unknown): void {
    const spec = JsonShape.record(parsed)
    if (spec === null) return
    let count = 0
    for (const value of Object.values(spec))
      if (Array.isArray(value)) count += value.length
    if (count > FileViewerLimits.diagramItemsMax)
      throw new Error(
        `The diagram declares ${count} items; at most `
        + `${FileViewerLimits.diagramItemsMax} are drawn`)
  }

  private static shortened(error: unknown): string {
    const message = ErrorText.of(error)
    if (message.length <= FileViewerLimits.diagramProblemCharacters) return message
    const kept = message.slice(0, FileViewerLimits.diagramProblemCharacters)
    return `${kept}\n... and ${message.length - kept.length} more characters`
  }

  private static async rawSvg(source: string): Promise<string> {
    const trimmed = source.trim()
    if (!/^<svg[\s>]/i.test(trimmed))
      throw new Error('SVG fence content must be an svg element')
    return trimmed
  }

  private static vegaSection(
    config: Record<string, unknown>,
    key: string,
    defaults: Record<string, unknown>,
  ): Record<string, unknown> {
    return { ...defaults, ...(JsonShape.record(config[key]) ?? {}) }
  }

  private static token(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }
}
