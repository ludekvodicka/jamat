// Diagram engine dispatch — async, offline. Each engine is a registry entry
// `{ id, langs, render(source, theme) }`; `DIAGRAM_LANGS` derives from the registry, so adding an
// offline engine is one entry. Every engine returns a raw SVG string — the CALLER must DOMPurify it
// (sanitizeSvg) before injection. Engines are dynamic-imported so they code-split and only load when
// a diagram of that kind is actually rendered.
//
// Engines: Mermaid (needs a DOM) for `mermaid`; viz-js/Graphviz (pure SVG string) for
// `dot`/`gv`/`graphviz`; Vega-Lite (data charts → headless SVG, no DOM) for `vega-lite`.

/** Anti-DoS cap: refuse to hand huge sources to the layout engines (they can hang/OOM). */
export const MAX_DIAGRAM_SRC = 50_000

type DiagramTheme = 'light' | 'dark'

interface DiagramEngine {
  id: string
  /** fence languages (and aliases) that route to this engine */
  langs: string[]
  render(source: string, theme: DiagramTheme): Promise<string>
}

// ── Mermaid ────────────────────────────────────────────────────────────────────────────────
// Mermaid needs a unique id per render (it injects a temp measuring element). A module counter is
// deterministic and collision-free — no need for randomness.
let mermaidSeq = 0

// Mermaid uses GLOBAL/shared state (config + a shared sandbox DOM) and is NOT safe to call
// concurrently — several diagrams rendering at once race and surface as spurious "Syntax error in
// text" on perfectly valid sources. Serialize every mermaid render through one promise chain so they
// run strictly one-at-a-time. A rejected render must not break the chain.
let mermaidQueue: Promise<unknown> = Promise.resolve()

async function renderMermaidOnce(source: string, theme: DiagramTheme): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true, // reject on parse error instead of injecting mermaid's own "bomb" SVG
    theme: theme === 'dark' ? 'dark' : 'default',
  })
  const { svg } = await mermaid.render(`mdext-mermaid-${mermaidSeq++}`, source)
  return svg
}

function renderMermaid(source: string, theme: DiagramTheme): Promise<string> {
  const run = mermaidQueue.then(() => renderMermaidOnce(source, theme))
  // keep the chain alive regardless of this render's outcome
  mermaidQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

// ── Graphviz / DOT (viz-js) ──────────────────────────────────────────────────────────────────
async function renderDot(source: string): Promise<string> {
  const { instance } = await import('@viz-js/viz')
  const viz = await instance()
  return viz.renderString(source, { format: 'svg' })
}

// ── Vega-Lite (data charts) ────────────────────────────────────────────────────────────────
// Renders a Vega-Lite JSON spec to a headless SVG string (no DOM attach). ALL external resource
// loading is blocked (data `url`s, image marks) via a rejecting loader — offline + no-exfil, matching
// the untrusted-content threat model. Inline data still works. A minimal theme config keeps charts
// legible on a dark background; the spec's own `config` overrides it.
function vegaThemeConfig(spec: Record<string, unknown>, theme: DiagramTheme): Record<string, unknown> {
  const userCfg = (spec.config as Record<string, unknown> | undefined) ?? {}
  if (theme !== 'dark') {
    return { background: 'transparent', ...userCfg }
  }
  const dark: Record<string, Record<string, unknown>> = {
    title: { color: '#e0e0e0', subtitleColor: '#b8b8b8' },
    axis: { labelColor: '#cccccc', titleColor: '#e0e0e0', gridColor: '#3a3a3a', domainColor: '#666666', tickColor: '#666666' },
    legend: { labelColor: '#cccccc', titleColor: '#e0e0e0' },
    view: { stroke: '#3a3a3a' },
  }
  const sub = (k: string) => ({ ...dark[k], ...((userCfg[k] as Record<string, unknown> | undefined) ?? {}) })
  return {
    background: 'transparent',
    ...userCfg,
    title: sub('title'),
    axis: sub('axis'),
    legend: sub('legend'),
    view: sub('view'),
  }
}

async function renderVegaLite(source: string, theme: DiagramTheme): Promise<string> {
  let spec: Record<string, unknown>
  try {
    spec = JSON.parse(source)
  } catch {
    throw new Error('invalid Vega-Lite JSON spec')
  }
  if (!spec || typeof spec !== 'object') throw new Error('Vega-Lite spec must be a JSON object')

  const [vegaLite, vega] = await Promise.all([import('vega-lite'), import('vega')])
  const themed = { ...spec, config: vegaThemeConfig(spec, theme) }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vega-lite TopLevelSpec is a large union; the spec is validated by compile()
  const compiled = vegaLite.compile(themed as any).spec

  // Block every outbound resource fetch (data urls + image marks). Inline data is untouched.
  const blocked = vega.loader()
  blocked.load = () => Promise.reject(new Error('external resources are disabled'))
  blocked.sanitize = () => Promise.reject(new Error('external resources are disabled'))

  const view = new vega.View(vega.parse(compiled), { renderer: 'none', loader: blocked })
  try {
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

// ── archify (vendored deterministic spec→SVG, MIT) ───────────────────────────────────────────
// Theme-agnostic: the SVG carries CSS classes; the widget's light/dark switches them (archify.css),
// so the same SVG works in both themes (no `theme` baked in, unlike mermaid/vega).
async function renderArchify(source: string): Promise<string> {
  let diagram: unknown
  try {
    diagram = JSON.parse(source)
  } catch {
    throw new Error('invalid archify JSON spec')
  }
  const { renderArchify: render } = await import('./archify')
  return render(diagram)
}

// ── Raw SVG (hand-authored) ──────────────────────────────────────────────────────────────────
// The LLM authors the SVG directly in a ```svg fence. We only confirm it IS an <svg> element and hand
// it straight back — the Diagram leaf sanitizes it (sanitizeSvg) before injecting, exactly like every
// other engine's output. Same safety class as mermaid/archify/vega output (SVG-only, no raw HTML / no
// scripts / no foreignObject / no external resources) — P1-002 stays closed. This is the "let the model
// draw the visual directly" path: charts, reports, bespoke illustrations — anything.
async function renderRawSvg(source: string): Promise<string> {
  const s = source.trim()
  if (!/^<svg[\s>]/i.test(s)) throw new Error('svg fence: content must be an <svg> … </svg> element')
  return s
}

// ── Registry ─────────────────────────────────────────────────────────────────────────────────
const ENGINES: DiagramEngine[] = [
  { id: 'mermaid', langs: ['mermaid'], render: (s, t) => renderMermaid(s, t) },
  { id: 'dot', langs: ['dot', 'gv', 'graphviz'], render: (s) => renderDot(s) },
  { id: 'vega-lite', langs: ['vega-lite', 'vegalite'], render: (s, t) => renderVegaLite(s, t) },
  { id: 'archify', langs: ['archify'], render: (s) => renderArchify(s) },
  { id: 'svg', langs: ['svg'], render: (s) => renderRawSvg(s) },
]

const ENGINE_BY_LANG = new Map<string, DiagramEngine>()
for (const engine of ENGINES) for (const lang of engine.langs) ENGINE_BY_LANG.set(lang, engine)

/** Fence languages that route to a diagram engine (drives the code-vs-diagram dispatch). */
export const DIAGRAM_LANGS = new Set(ENGINE_BY_LANG.keys())

export async function renderDiagram(kind: string, source: string, theme: DiagramTheme): Promise<string> {
  const engine = ENGINE_BY_LANG.get(kind)
  if (!engine) throw new Error(`unknown diagram engine: ${kind}`)
  return engine.render(source, theme)
}
