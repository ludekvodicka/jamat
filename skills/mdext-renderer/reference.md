# mdext-renderer — reference

Companion to [SKILL.md](./SKILL.md). Details for authoring `.md` / `.mdext` that the `MdExtRenderer`
widget renders.

## The format is plain Markdown

There is no new syntax to learn for the prose layer — it is GitHub-Flavored Markdown. The
"extensions" are:
- **Fenced code languages** drive syntax highlighting (standard Markdown, just tag them).
- **YAML frontmatter** is lifted into a metadata strip instead of being rendered as body text.
- **Diagram fences** (`mermaid` / `dot` / `vega-lite` / `archify`) route to an engine → inline SVG.
- **Typed-block directives** (`:::callout`, `::status`, `:::details`) add structured boxes.

`.mdext` vs `.md`: identical rendering. `.mdext` only advertises "this file leans on the rich view."
Both degrade to readable source in a plain viewer (graceful degradation is a hard requirement).

## Syntax highlighting (Shiki, JS engine)

Highlighted languages (current bundle): `typescript`, `tsx`, `javascript`, `jsx`, `json`, `jsonc`,
`bash`, `python`, `go`, `rust`, `java`, `c`, `cpp`, `csharp`, `sql`, `yaml`, `toml`, `html`, `css`,
`markdown`, `diff`, `dockerfile`. An unknown/missing language falls back to a plain block (no error).
Highlighting is **dual-theme** (light/dark) — the colors follow the host theme via CSS variables.

The **Copy** button copies the exact code, stripped of control / bidi / zero-width characters and
trailing newlines (so a hidden command can't ride a paste into a terminal).

> Token-boundary caveat: in-file search inside a highlighted block matches within a single token; a
> query that spans two highlighted tokens may not match. Searching the raw view always works.

## Frontmatter

Leading `---` … `---` YAML parsed to a plain object → a collapsible `metadata (N)` strip. Arrays /
nested maps are flattened for display. Malformed YAML, or a non-object (e.g. a list), is left as-is
(the document is rendered untouched — a leading `---` that is really a thematic break still works).

## Theming

MUI-free; themed entirely through CSS variables (`--mdext-fg`, `--mdext-code-bg`, …). The host sets
them: a MUI/Next host maps its palette → the vars; the Jamat (plain React) sets them on the
file-viewer scope and passes `theme="dark"`. `theme="auto"` follows `prefers-color-scheme`. Diagrams
recolor on a light/dark switch.

## Diagram engines — overview

Engines live in a small registry (`renderers/renderDiagram.ts`); each fence language routes to one
engine, each returns an SVG string that is sanitized before injection. Adding an offline engine is one
registry entry. All are lazy-loaded (the engine's code only loads when a diagram of that kind appears).

- ` ```svg ` — **hand-authored SVG**: the model draws the visual directly; the source is validated as an
  `<svg>` then passed through `sanitizeSvg` and injected (same safety class as engine output). See
  [svg-style.md](./svg-style.md).
- ` ```mermaid ` — Mermaid (flowcharts, sequence, state, gantt, class, …), rendered client-side.
- ` ```dot ` / ` ```gv ` / ` ```graphviz ` — Graphviz DOT via viz-js → SVG.
- ` ```vega-lite ` (alias ` ```vegalite `) — Vega-Lite JSON spec → headless SVG.
- ` ```archify ` — vendored deterministic spec→SVG renderer, five `diagram_type`s (see below).

100% offline; every engine-produced SVG is sanitized before injection; a render error (or a ` ```svg `
fence whose content isn't an `<svg>`) falls back to a readable "show source" view; oversized inputs
(>50 KB source) show source instead of hanging.

### When to use which engine

See the decision table in [SKILL.md](./SKILL.md#diagrams--charts--pick-the-right-engine). In short:
**hand-authored ` ```svg ` is the default for bespoke visuals** (charts, reports, illustrations — you
draw it, full control). Reach for a typed engine when you want determinism, cheap tokens on big data,
or auto-theming: **Archify** for the architecture-family (architecture / workflow / sequence /
dataflow / lifecycle), **Vega-Lite** for data-heavy/repeatable charts, **Mermaid** for quick
auto-layout flows, **Graphviz** for custom graph layout. The roster is extensible.

### Vega-Lite (data charts)

A ` ```vega-lite ` fence holds a [Vega-Lite](https://vega.github.io/vega-lite/) JSON spec → headless
SVG (bar / line / scatter / area / heatmap …). For real data-driven charts; Mermaid is for
flow/structure. **Data must be inline** (`"data": { "values": [...] }`): remote/`file:` `data.url`s
and image marks are blocked by a rejecting loader (offline + no-exfil), so a spec that fetches a URL
renders an error rather than reaching the network. The chart recolors for light/dark; the spec's own
`config` overrides the theme defaults.

## Archify — the five diagram types

A ` ```archify ` fence holds a JSON object. **Common fields (every type):**

| Field | Meaning |
|---|---|
| `schema_version` | `1` |
| `diagram_type` | one of `architecture` / `workflow` / `sequence` / `dataflow` / `lifecycle` (selects the renderer) |
| `meta` | `{ title, subtitle?, viewBox?: [w, h] }` — `viewBox` sets the SVG canvas; omit to let the type default it |

**Semantic node `type`** (colors a box consistently via CSS): `external`, `frontend`, `backend`,
`database`, `cloud`, `security`, `messagebus`. **Connection `variant`**: `default`, `emphasis`,
`security`, `dashed` (sequence also has `return` for replies).

**Layout is explicit and validated.** Renderers compute nothing automatic for positions — you place
nodes — and they `throw` (→ leaf shows error + source) when boxes overlap, a node falls off the
canvas, or labels collide. Author coordinates deliberately; widen `meta.viewBox` if things are tight.
Routing hints (`fromSide`/`toSide`, `route`, `via`, `labelAt`/`labelDx`/`labelDy`/`labelSegment`) let
you steer edges and place labels precisely.

### `architecture` — components, boundaries, connections

| Field | Shape |
|---|---|
| `components[]` | `{ id, type, label, sublabel?, pos: [x, y], size: [w, h], tag? }` |
| `boundaries[]` | `{ kind: "region" \| "security-group", label, wraps: [id, …] }` — a labeled box drawn around the wrapped components |
| `connections[]` | `{ from, to, label?, variant?, fromSide?, toSide?, labelDx?, labelDy? }` — `from`/`to` are component `id`s |

`fromSide`/`toSide` ∈ `top` / `bottom` / `left` / `right` (or `auto`). `tag` is a small corner badge.

### `workflow` — swimlanes, anchored nodes, orthogonal edges

| Field | Shape |
|---|---|
| `lanes[]` | `{ id, label }` — horizontal bands, top-to-bottom in array order |
| `nodes[]` | `{ id, lane, col, type, label, sublabel?, tag? }` — `lane` = a lane `id`; `col` = integer column (0-based) for horizontal position |
| `edges[]` | `{ from, to, label?, variant?, fromSide?, toSide?, route?, labelSegment?, labelDx?, labelDy?, labelAt? }` |

`route` hints the edge path: `drop` (vertical between lanes), `outside-right`, `bottom-channel`,
`return-left`, etc. `labelSegment` chooses which segment of a multi-bend edge carries the label;
`labelAt: [x, y]` pins it absolutely.

### `sequence` — participants, lifelines, messages, activations

| Field | Shape |
|---|---|
| `participants[]` | `{ id, type, label, sublabel? }` — columns left-to-right in array order |
| `messages[]` | `{ from, to, y, label, variant? }` — `y` is the vertical pixel position of the arrow; `variant: "return"` draws a dashed reply |
| `activations[]` | `{ participant, from, to, type }` — an activation bar on a lifeline from `y=from` to `y=to` |
| `segments[]` | `{ from, to, label }` — an optional labeled time band spanning `y=from`..`to` |

Order messages by ascending `y`; size the canvas with `meta.viewBox` so the lowest `y` fits.

### `dataflow` — staged pipeline with classification

| Field | Shape |
|---|---|
| `stages[]` | `{ label }` — vertical columns left-to-right (stage index = array position) |
| `nodes[]` | `{ id, type, label, sublabel?, stage, row, tag? }` — `stage` = stage index; `row` = vertical slot within the stage |
| `flows[]` | `{ from, to, label?, classification?, variant?, fromSide?, toSide?, route?, via?, labelAt? }` |

`classification` is a free-text data tag shown on the flow (e.g. `PII touch`, `non-PII`, `encrypted`).
`via: [[x, y], …]` gives explicit waypoints for an orthogonal route.

### `lifecycle` — state machine in bands

| Field | Shape |
|---|---|
| `lanes[]` | `{ id, label }` — bands: typically a main phase lane plus interruption / recovery / terminal lanes |
| `states[]` | `{ id, type, label, sublabel?, lane, col, step?, tag?, yOffset? }` |
| `transitions[]` | `{ from, to, variant?, fromSide?, toSide?, route?, via? }` |

State `type` drives the visual: `start`, `active`, `decision`, `waiting`, `success`, `failure`,
`neutral`, `external`. `step` is a small ordinal badge (e.g. `"01"`); `yOffset` nudges a state
vertically within its lane to avoid a collision.

Full worked specs for all five live in
[examples/archify-showcase.mdext](./examples/archify-showcase.mdext).

## Hand-authored static SVG (the ` ```svg ` fence)

For bespoke visuals the typed engines don't cover (charts, status reports, concept explainers, header
illustrations), author SVG directly in a ` ```svg ` fence — it is validated as an `<svg>`, run through
`sanitizeSvg`, and injected inline (same safety class as engine output; P1-002 stays closed). The
distilled **effective static-SVG style** guide [svg-style.md](./svg-style.md) has the tokens,
principles, **chart recipes** (bars / line+area / donut, scale mapping), and the `sanitizeSvg`-safe
element set. This is the **default for bespoke visuals**; use a typed engine for data-heavy,
deterministic, or auto-themed cases.

## Typed blocks

[remark-directive](https://github.com/remarkjs/remark-directive) syntax — still valid Markdown
(degrades to source in a plain viewer).

### Callouts (`:::type` … `:::`)

Types: `note`, `tip`, `warning`, `danger`, `important`. Optional `[Title]` after the type overrides
the default (capitalized type). The body is full Markdown (paragraphs, lists, code, links).

```
:::tip[Optional title]
Body **markdown**.
:::
```

### Status chips (`::status{…}`)

A single leaf directive whose attributes become a row of colored pills, one per `key=value`. Quote
values containing spaces or `%` (`coverage="82%"`). Tone is inferred from the value:

| Tone | Matches (case-insensitive) |
|---|---|
| green (`good`) | pass/passed/passing, ok, done, success, complete(d), active, yes, up, healthy |
| amber (`warn`) | warn/warning, partial, medium, pending, wip, in-progress, degraded, review |
| red (`bad`) | fail/failed/failing, error, danger, high, critical, blocked, down, no, stale |
| neutral | anything else (numbers, percentages, free text) |

```
::status{build=passing tests=passing coverage="82%" risk=high review=pending}
```

### Collapsible (`:::details[Title]` … `:::`)

A native `<details>`/`<summary>`, collapsed by default. Title from `[Title]` (default "Details").
Body is full Markdown. Use for alternatives-considered, raw logs, long optional context.

### Graceful fallback

An unrecognized directive name (`:::whatever`) renders its content as a plain block — no styling, no
error. Author-supplied attributes/classes on a block are ignored (the widget owns its markup).

## Not supported (by design)

- **Raw/embedded HTML** — stripped by default (never executed). Use Markdown or the typed blocks
  instead. (A host *can* opt into a sanitized raw-HTML hatch — see below — but don't author for it:
  it's off in the app's file viewer and always off for remote content.)
- **Interactivity / scripts / forms** — the widget is render-only.
- **Auto-loading external resources from remote/peer files** — blocked in the remote tier.

## Raw-HTML escape hatch (host opt-in, discouraged)

A host may pass `allowRawHtml` to render embedded HTML through a stricter sanitize tier (GitHub
schema + no external resource `src`): useful formatting tags (`<kbd>`, `<sub>`, `<sup>`, `<div>`,
`<details>`…) survive; `<script>`, event handlers (`on*`), `<style>`, `javascript:`/`data:` URLs,
and external/`data:` `src` are stripped. It is **off by default**, **hard-disabled when `remote`**,
and lazy-loaded. Prefer the typed blocks — this is an escape hatch for legacy/embedded HTML, not a
feature to author toward.

## Host integration (for app developers)

The widget's canonical source is `atomix_shared_frontend/widgets/mdExtRenderer` (consumed via SVN
`svn:external`; runtime deps declared in `widgets/.dependencies.json`, exact-pinned). Public API:
`<MdExtRenderer source={text} theme="auto|light|dark" remote={boolean} allowRawHtml={boolean} className? />`.

**This skill lives in the consuming app** (`claudeJamatV2/skills/mdext-renderer/`), not in
the widget — it is the *authoring* guidance (what to emit + which engine to prefer), which belongs
with the app whose agents generate these files. It is junctioned into `~/.claude/skills/mdext-renderer`
by `ensure-skill-links.ts` (the repo's `skills/` container). When the widget gains a capability,
update this skill in the same change so the authoring guidance stays in step with what renders.
