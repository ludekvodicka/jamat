/* Vendored from archify — github.com/tt-a1i/archify, MIT (subset of renderers/shared/utils.mjs).
 * Only the SVG-building helpers are kept (esc / renderDefinitions / textUnits); archify's HTML
 * template, theme-toggle JS, export menu, and card rendering are dropped — our widget owns theming
 * (CSS vars) and injects the sanitized SVG inline. See ./LICENSE. */
/* eslint-disable @typescript-eslint/no-explicit-any */

const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function esc(value: any): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPE_MAP[c])
}

/** The shared `<defs>` (arrowhead markers per variant + the background grid pattern). The classes
 *  (m-default/grid/…) are styled by archify.css; the marker/pattern ids are referenced from the SVG. */
export function renderDefinitions(): string {
  return `        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" class="m-default" />
          </marker>
          <marker id="arrowhead-emphasis" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" class="m-emphasis" />
          </marker>
          <marker id="arrowhead-security" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" class="m-security" />
          </marker>
          <marker id="arrowhead-dashed" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" class="m-dashed" />
          </marker>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" class="c-grid" stroke-width="0.5"/>
          </pattern>
        </defs>`
}

// CJK / fullwidth glyphs render at ~2x the advance width of ASCII in monospace. Archify's ranges,
// written as explicit \u escapes (Hangul Jamo, CJK radicals→ext, Hangul syllables, CJK compat
// ideographs, compat forms, fullwidth/halfwidth forms, fullwidth signs, CJK symbols, emoji, CJK ext-B+).
const FULLWIDTH_RE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿]|[\u{1F000}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u

export function textUnits(text: any): number {
  let units = 0
  for (const ch of String(text ?? '')) units += FULLWIDTH_RE.test(ch) ? 2 : 1
  return units
}
