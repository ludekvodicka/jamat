# Effective static-SVG style — authoring reference

A distilled visual style for **hand-authored, sanitize-safe static SVG** deliverables — the cases the
typed diagram engines (archify's 5 types, Mermaid, Vega-Lite) don't cover: status reports, concept
explainers, header illustrations, posters, dashboards.

> **Status — LIVE via the ` ```svg ` fence.** Author SVG directly inside a ` ```svg ` fenced block in
> any `.md`/`.mdext`; the widget runs it through `sanitizeSvg` and injects it inline — the **same safety
> pass as every diagram engine** (no raw HTML, no scripts, no `foreignObject`, no external resources →
> **P1-002 stays closed**). This is the **primary, free-hand way to visualize anything** — charts,
> reports, bespoke illustrations. A fence whose content isn't an `<svg>` shows an error + source (never
> a blank). For **data-heavy** or **auto-themed** cases a typed engine (vega-lite / archify) is cheaper
> and deterministic — see "When to use what" below. Everything here stays inside the `sanitizeSvg` safe
> set.

**Attribution.** The aesthetic is distilled (principles + token values, not copied markup) from the
*"unreasonable effectiveness of HTML"* corpus — `references/html-effectiveness/` in
`github.com/plannotator/effective-html` (corpus **Apache-2.0, © Anthropic PBC**; the wrapper skills are
MIT, © plannotator / Thariq Shihipar). Token values (hex, sizes) are facts, reused here with credit.

## The aesthetic in one paragraph

Editorial, restrained, token-driven. A real **type hierarchy** (a heavier display/heading + a calm
body + **monospace for labels/metadata/IDs**), a **warm-neutral surface** rather than stark
black/white, **one** accent color used sparingly to mark the one thing that matters, **hairline**
borders and generous **whitespace** instead of boxes-inside-boxes, and **low-alpha tinted** chips for
status rather than saturated fills. Dark mode is first-class. It reads like a well-set document, not a
dashboard.

## Design tokens (distilled)

The corpus's reference palette is **warm/light**. Our widget is **CSS-var themed** (dark default), so
**don't import the warm palette wholesale** — apply the *principles* in our tokens. The reference
values are here so you recognize the language; the right-hand column is what to actually use.

### Palette

| Role | Effective reference (light) | Use in our SVG |
|---|---|---|
| Surface / bg | ivory `#FAF9F5` | `var(--mdext-bg, #0d1117)` |
| Foreground | slate `#141413` | `var(--mdext-fg, #e6edf3)` |
| Muted text | gray-500 `#87867F` | `var(--mdext-muted, #8b949e)` |
| Hairline border | gray-300 `#D1CFC5`, 1.5px | `var(--mdext-border, #2d333b)`, 1–1.5px |
| **Accent** (the one highlight) | clay `#D97757` | one of: sky `#56c0f5` / teal `#2dd4bf` / amber `#fbbf24` |
| success / warning / danger / info | `#788C5D` / `#C78E3F` / `#B04A4A` / `#5C7CA3` | green `#4ade80` / amber `#fbbf24` / rose `#fb7185` / sky `#56c0f5` |

Use semantic colors **tinted** (fill at ~14–16% alpha, text at full) for chips/badges — never a solid
saturated block.

### Type scale, spacing, shape

- **Type:** display 32–48 / h1 24–32 / h2 19–24 / body 14–16 / caption 11–12. Headings heavier
  (600 / or serif 500 with `letter-spacing:-0.01em`); body 400–430; **captions & IDs in mono**,
  often **UPPERCASE with `letter-spacing:0.08em`**. In SVG: `font-family` sans for labels, mono for
  IDs/metrics/values.
- **Spacing scale:** 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64. Pick from it; don't free-hand gaps.
- **Radius:** xs 4 · sm 8 · md 12 · lg 20. Nodes/cards rx 8–12.
- **Elevation:** sm `0 1px 2px /6%` · md `0 4px 10px /8%` · lg `0 12px 28px /12%`. In SVG via
  `<feDropShadow dy="2" stdDeviation="3" flood-opacity="0.35">`.
- **Border:** 1–1.5px hairline. Boundaries/regions: dashed `stroke-dasharray:6 5` + an UPPERCASE label.

## Principles checklist

- **One accent, one focus.** Color the single most important node/number with the accent; everything
  else is neutral. (In the corpus's queue illustration, only the head-of-queue job is clay.)
- **Hierarchy by type, not by box.** Lead with size/weight/family; avoid nested borders.
- **Mono for the machine, sans for the prose.** IDs, counts, timestamps, code → mono. Titles,
  descriptions → sans/serif.
- **Tinted semantics.** status = low-alpha fill + colored text pill, not a loud rectangle.
- **Whitespace is structure.** Generous padding; hairline rules to separate, not heavy frames.
- **Palette-locked.** Flat fills, 1.5–2px strokes, no gradients-for-decoration (a single subtle
  drop-shadow for depth is fine).
- **Annotate quietly.** Helper notes in muted gray, small.

## Sanitize-safe SVG recipe

Survives `sanitizeSvg` (DOMPurify `USE_PROFILES {svg, svgFilters}`): `svg g rect circle ellipse line
path polygon polyline text tspan defs linearGradient radialGradient stop marker filter feDropShadow
clipPath`; presentation attributes; `stroke-dasharray`; `marker-end`. **Stripped:** `script`,
`foreignObject`, `use`, `image`, `on*` handlers, `javascript:`/external URLs. ⇒ arrowheads via
`<marker>`, depth via `<feDropShadow>`, **never `<foreignObject>`** for HTML-in-SVG.

**Theming — two ways:**
1. **CSS classes + host stylesheet (preferred, theme-reactive).** Author the SVG with classes
   (`class="c-node"`, `class="t-title"`, …) and **no inline colors**; a host stylesheet scoped under
   the diagram container (e.g. `.mdext-diagram-<kind> .c-node { fill: var(--mdext-...) }`) drives
   light/dark — exactly how the archify engine themes its output. Best for an engine or an in-app
   render path. (Note: an inline `<style>` inside `<defs>` may or may not survive `sanitizeSvg` —
   don't rely on it; put the CSS in the host instead.)
2. **Inline presentation attributes (standalone sidecar).** For a self-contained `.svg` with no host
   CSS, set `fill`/`stroke` inline (bake one theme). This is what `svg-demos/*.svg` do.

**Minimal worked example** (status card, dark, inline — sanitize-safe):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 132" width="360" height="132" font-family="'Inter','Segoe UI',system-ui">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dy="2" stdDeviation="3" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="1" y="1" width="358" height="130" rx="12" fill="#0d1117" stroke="#2d333b" filter="url(#sh)"/>
  <rect x="1" y="1" width="4" height="130" rx="2" fill="#56c0f5"/>
  <text x="22" y="34" fill="#e6edf3" font-size="15" font-weight="600">Nightly build</text>
  <text x="22" y="54" fill="#8b949e" font-size="11" font-family="ui-monospace,Menlo,monospace">PIPELINE #4821 · 6m 12s</text>
  <!-- tinted status pill -->
  <rect x="22" y="74" width="74" height="22" rx="11" fill="#4ade8026"/>
  <text x="59" y="89" fill="#4ade80" font-size="12" font-weight="600" text-anchor="middle">passing</text>
  <!-- metric -->
  <text x="250" y="40" fill="#8b949e" font-size="10" font-family="ui-monospace,Menlo,monospace" text-anchor="end">COVERAGE</text>
  <text x="250" y="64" fill="#e6edf3" font-size="22" font-weight="700" text-anchor="end" font-family="ui-monospace,Menlo,monospace">82%</text>
</svg>
```

## Charts & visuals in SVG (recipes)

You draw the chart directly — no library. These recipes make it repeatable (and good) every time.

**Scale mapping** (value → pixel). Pick a plot box: `baseline` (bottom y), `top` (top y), `vmin`/`vmax`.
Then `y = baseline - (v - vmin) * (baseline - top) / (vmax - vmin)`. Keep everything inside the
`viewBox` (self-check: no negative/over-max y).

**Axes & gridlines.** A stronger baseline `<line>` (`stroke="#3a4350" stroke-width="1.5"`); a few dim
horizontal gridlines (`stroke="#1f2630"`) at round values, each with a right-anchored mono label; x
labels mono, `text-anchor="middle"`, under each tick/category.

**Bars.** One `<rect rx="3">` per value: `height = (v-vmin)*scale`, `y = baseline - height`, `x` by
slot. Grouped = two rects per slot, offset; muted (`#6b7280`) vs accent (`#56c0f5`). Legend = swatch
`<rect>` + label. Highlight the one bar that matters with the accent; rest muted.

**Line + area.** Line = `<polyline points="x,y x,y …" fill="none" stroke="#56c0f5" stroke-width="2.5"
stroke-linejoin="round" stroke-linecap="round"/>`. Area under it = `<path d="M x0,baseline L …pts…
L xN,baseline Z" fill="url(#grad)"/>` with a `<linearGradient>` (accent `stop-opacity` 0.35 → 0).
Points = small `<circle r="3">`; emphasize the last with a solid accent dot + a mono value label.

**Donut / pie via `stroke-dasharray`** (no arc math). Circumference `C = 2·π·r`. Each segment is a
`<circle fill="none" stroke-width="W" stroke-dasharray="<segLen> <C>" stroke-dashoffset="-<cumStart>"/>`
where `segLen = fraction·C` and `cumStart` accumulates prior segment lengths. Wrap all segments in
`<g transform="rotate(-90 cx cy)">` so the ring starts at 12 o'clock. Put the total in centered text;
legend rows alongside. (Worked example: `report-demos`/`chart-demos` in the harness.)

**Legend.** A small `<rect rx="3">` swatch + label; numeric values right-anchored, mono.

**Self-check (charts):** everything inside the `viewBox`; labels don't overlap; only the sanitize-safe
element set; one accent; mono for all numbers; theme baked (inline hex) for a one-off, or CSS classes
→ `--mdext-*` if it must follow light/dark.

## Pattern catalog (report / stat building blocks)

Mined from the corpus's report archetypes (status report, incident report, implementation plan, triage
board, design system, svg illustrations). These are the recurring **composition patterns** — the
vocabulary for statistics / previews / reports. The right column says how each is produced: an existing
mdext feature, a **planned typed engine** (data → deterministic SVG, see the Phase B plan), or
hand-authored SVG.

### Header & chrome (composition — no engine)

- **Eyebrow** — mono, UPPERCASE, `letter-spacing:0.08em`, muted — a kicker above the title.
- **Title** — serif/heavy, `-0.01em`. **Meta row** — a row of pills + an ID/date/repo line in mono.
- **Section** — serif h2 + a hairline rule; or a `sec-head` = a numbered mono chip (on `oat`/tinted bg)
  + h2 + a muted one-line intro.
- **Hintline** — mono, prefixed with a colored `›` — a quiet tip/aside.

### Building blocks

| Pattern | What it is | Key structure | Produced by |
|---|---|---|---|
| **Stat card / summary band** | KPI grid (the `05-status-report` top row) | grid of cards: big value + UPPERCASE label + mono delta (up=green / flat=muted); optional 4px left accent on the one that matters | **→ `statcards` engine (Phase B)** |
| **K/V summary strip** | definition cells | grid of `mono UPPERCASE key` + bold value (accent variant) | → `statcards` (kv variant) or hand-SVG |
| **Status board / check rows** | labeled rows with status | name (600) + mono detail + right-aligned **tinted** status pill + hairline between rows | **→ `statusboard` engine (Phase B)** |
| **Timeline** | ordered events | `when` (mono) + dot (outline / done = filled) + connector line + content; horizontal segments variant | **→ `timeline` engine (Phase B)** |
| **Board / kanban** | columns of cards | grid of columns, each: top accent stripe (by lane) + sticky head w/ count + cards | → `board` engine (later — more layout) |
| **Emphasis band (TL;DR)** | inverted highlight | dark (slate) bg + light text + mono label; code chips inside | ~ existing **callout** typed block (`:::important`) |
| **Quote / prompt box** | bordered aside | tinted/gray bg + border + mono label | ~ existing **callout** typed block |
| **Pills / badges** | status tokens | sev = solid; resolved = solid green; neutral = border + mono value; status = **tinted** (low-alpha fill + colored text) | existing **status chips** (`::status`) |
| **Highlights list** | scannable bullets | custom square accent bullet | plain markdown list |
| **Charts** | quantitative data | bar/line/scatter/area | existing **vega-lite** fence |
| **Diagrams** | structure/flow/sequence | typed | existing **archify** / **mermaid** fences |

**Takeaway for Phase B:** the genuinely *new* report-composition gap is **`statcards`, `statusboard`,
`timeline`** (start here) and later **`board`**. Everything else is already covered (charts → vega-lite,
callouts/status → typed blocks, diagrams → archify). Don't rebuild what exists.

## When to use what

| Want | Do |
|---|---|
| Bespoke chart / report / illustration / **anything custom** | **hand-author a ` ```svg ` fence** (this guide) — renders inline today, sanitized |
| **Data-heavy** chart, or you want it cheap + **auto-themed** | `vega-lite` fence (compact data → SVG) |
| Typed architecture-family diagram, deterministic + themed | `archify` fence |
| Quick auto-laid-out flow / graph | `mermaid` / `dot` fence |

**Hand-SVG is the default for visuals** — you draw it, full control, looks best. Reach for a typed
engine only when you need determinism, cheap tokens on a big dataset, or automatic light/dark. See the
full preference table in [SKILL.md](./SKILL.md).

Worked SVGs in the harness: `toolMdExtRenderer/{svg-demos,report-demos,chart-demos}/` (gallery tabs
"SVG demo" / "Reports" / "Charts (SVG)") + `svg-demos/AUTHORING.md` for the mechanical render path.
