# archify, vendored

Upstream: <https://github.com/tt-a1i/archify>, MIT (`LICENSE` beside this file).

**No upstream revision was recorded when this was imported**, which is the gap this file closes going
forward: nobody could tell what a rebase would land on. The import predates 2026-08-24 and the
V3 history does not name a commit, so the honest answer for what is here today is "an unknown
revision of `renderers/`". The next refresh records the commit it took, in the table below.

| Refreshed | Upstream commit | Taken |
|---|---|---|
| (unknown, before 2026-08-24) | not recorded | `renderers/{architecture,workflow,sequence,dataflow,lifecycle}` + a subset of `renderers/shared/utils.mjs` |

## What was changed on the way in

- **Ported to browser TypeScript.** Each renderer is a pure function taking the parsed diagram
  object and returning the `<svg>` string. Upstream's `fs`, HTML template, theme-toggle script,
  export menu and info cards are dropped.
- **Styling is ours.** Upstream ships `archify.css`; here the classes are styled from
  `renderer/mdExtRenderer.css`, which is what the comments in these files point at.
- **The layout maths, the validation, the routing and the SVG markup are archify's, unchanged.**

## What was deliberately NOT changed

- **`svgRootAttrs` is byte-identical in all five renderers** and `utils.ts` exists for exactly that
  kind of sharing. It stays duplicated: folding it in would be a local edit to five files that a
  rebase then has to unpick, and it is six lines each. The place to fix it is upstream.
- **The layout validators compare every pair of items**, which is quadratic, and an item with no
  `pos` has NaN coordinates where the overlap test answers true. Rather than edit five validators,
  the two ceilings that make that bounded live in `MdExtDiagramEngine.archify`:
  `FileViewerLimits.diagramItemsMax` refuses a spec before any validator runs, and
  `diagramProblemCharacters` shortens the complaint before it becomes DOM text.

## Refresh trigger

Refresh when upstream fixes a layout bug this tree hits, or when a new `diagram_type` is wanted.
A refresh re-applies the three changes above and records the commit it took in the table.
