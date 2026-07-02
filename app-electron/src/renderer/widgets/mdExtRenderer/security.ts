import { defaultSchema } from 'rehype-sanitize'
import DOMPurify from 'dompurify'

// ── Markdown-native sanitization baseline ────────────────────────────────────────────────
// rehype-sanitize's defaultSchema is GitHub-flavored: raw HTML is dropped, event handlers and
// dangerous URL protocols are stripped, GFM tables / task-lists / footnotes are allowed, and
// `className="language-*"` survives on <code> (so language detection still works downstream).
// It is the always-on baseline; the URL-scheme allow-list below (enforced in the a/img renderers)
// is the defense-in-depth second layer.
//
// The typed-block transform (directives.ts, plan v2) emits a few extra elements
// (callout/status/details) carrying ONLY the marker classes below. We widen the schema by exactly
// those classes + `role="note"` — value-restricted, so nothing else slips through. These MUST stay
// in sync with the classes set in directives.ts.
const CALLOUT_CLASSES = [
  'mdext-callout',
  'mdext-callout-note',
  'mdext-callout-tip',
  'mdext-callout-warning',
  'mdext-callout-danger',
  'mdext-callout-important',
  'mdext-callout-title',
  'mdext-status',
]
const CHIP_CLASSES = [
  'mdext-chip',
  'mdext-chip-good',
  'mdext-chip-warn',
  'mdext-chip-bad',
  'mdext-chip-neutral',
]

export const MDEXT_SANITIZE: typeof defaultSchema = {
  ...defaultSchema,
  tagNames: Array.from(new Set([...(defaultSchema.tagNames ?? []), 'div', 'span', 'details', 'summary'])),
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', ...CALLOUT_CLASSES],
      ['role', 'note'],
    ],
    span: [...(defaultSchema.attributes?.span ?? []), ['className', ...CHIP_CLASSES]],
    details: [...(defaultSchema.attributes?.details ?? []), ['className', 'mdext-details']],
  },
}

// The raw-HTML escape hatch (plan v2) reuses MDEXT_SANITIZE — the GitHub schema already strips
// <script>/event handlers/<style>/dangerous URL protocols, which is exactly what untrusted raw HTML
// needs. The extra "no external resource" hardening for raw mode is enforced in the `img` component
// (safeImgSrc with blockExternal), not the schema — hast-util-sanitize keeps http(s) `src` and the
// component is the deterministic, tested chokepoint for external/`data:` resources.

// ── URL-scheme allow-list (a/img) ────────────────────────────────────────────────────────
// Only http(s), in-page anchors, and relative paths are allowed. javascript:/data:/vbscript:/
// file: and protocol-relative (//host) URLs are rejected. In the `remote` tier, external
// http(s) resources are dropped too (a peer's file must not auto-load or link out).

const hasScheme = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u)

/** Safe href for links, or undefined to neutralize the link. */
export function safeHref(u: string | undefined, remote = false): string | undefined {
  if (!u) return undefined
  const v = u.trim()
  if (!v) return undefined
  if (v.startsWith('//')) return undefined // protocol-relative → external
  if (!hasScheme(v)) return v // anchor (#…) or relative path — safe
  if (/^https?:/i.test(v)) return remote ? undefined : v
  return undefined // javascript:, data:, vbscript:, file:, mailto:, …
}

/** Safe image src, or undefined to block the image. Stricter than links: no data:, no external when remote. */
export function safeImgSrc(u: string | undefined, remote = false): string | undefined {
  if (!u) return undefined
  const v = u.trim()
  if (!v) return undefined
  if (v.startsWith('//')) return undefined
  if (!hasScheme(v)) return v // relative path
  if (/^https?:/i.test(v)) return remote ? undefined : v // external image: blocked in remote tier
  return undefined // data:, file:, javascript:, …
}

// ── Clipboard hygiene ────────────────────────────────────────────────────────────────────
// Strip control / C1 / bidi / zero-width / line-separator characters so a hidden destructive
// command can't ride a code copy into a terminal paste. Keep \t \n \r in the body; trim only
// trailing newlines. Built from explicit code points (literal control chars in source are
// invisible / fragile).
const CLIPBOARD_STRIP = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F' + // C0 controls except \t \n \r
    '\\u007F-\\u009F' + // DEL + C1 controls
    '\\u00AD' + // soft hyphen
    '\\u061C' + // arabic letter mark
    '\\u200B-\\u200F' + // zero-width space/non-joiner/joiner + LRM/RLM
    '\\u2028\\u2029' + // line / paragraph separators
    '\\u202A-\\u202E' + // bidi embeddings/overrides
    '\\u2066-\\u2069' + // bidi isolates
    '\\uFEFF' + // zero-width no-break space / BOM
    ']',
  'g',
)

export function sanitizeClipboard(s: string): string {
  return s.replace(CLIPBOARD_STRIP, '').replace(/[\r\n]+$/, '')
}

// ── Engine SVG sanitization (v1b diagrams) ───────────────────────────────────────────────
// Engine-produced SVG (Mermaid/viz-js) is a deterministic transform of UNTRUSTED input — it is NOT
// inherently inert, so it must be sanitized before `dangerouslySetInnerHTML`. DOMPurify (SVG profile)
// drops <script>/event handlers/`javascript:` by default; we additionally forbid <foreignObject>
// (can embed arbitrary HTML) and <use>/<image> (external-reference / resource-load vectors → keeps
// rendered diagrams from making outbound requests). Mermaid `securityLevel:'strict'` is kept upstream
// but is NOT relied on as the sanitizer.
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'use', 'image'],
  })
}
