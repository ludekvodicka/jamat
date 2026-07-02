/**
 * App-side Shiki singleton for the FileViewer's plain-code view and the diff
 * (DiffView) syntax overlay — the same engine the mdExtRenderer widget uses for
 * markdown fenced code, so the whole viewer highlights through ONE highlighter
 * family (replaces the old highlight.js path).
 *
 * Deliberately NOT shared with the widget's own Shiki instance: the widget is a
 * vendored `svn:external` (render-only, canonical elsewhere) and must not gain
 * app-side coupling. The cost is a second highlighter instance in memory; the
 * Shiki code itself is shared in the bundle.
 *
 * - JS RegExp engine (no Oniguruma WASM → no `file://` bundling risk), same as
 *   the widget.
 * - Single `github-dark` theme: the FileViewer runs dark, so tokens carry inline
 *   `color`/font-style and need no CSS-var theme wiring.
 * - Async: the highlighter builds lazily on first use. Callers render plain text
 *   until the returned promise resolves, then upgrade.
 */

// Lang modules loaded with explicit static `import()` (a fixed list) so the
// bundler can statically analyse them. Each loads via Promise.allSettled so one
// JS-engine-incompatible grammar can't fail the whole highlighter.
const langImports = (): Array<Promise<unknown>> => [
  import('shiki/langs/typescript.mjs'),
  import('shiki/langs/tsx.mjs'),
  import('shiki/langs/javascript.mjs'),
  import('shiki/langs/jsx.mjs'),
  import('shiki/langs/json.mjs'),
  import('shiki/langs/jsonc.mjs'),
  import('shiki/langs/html.mjs'),
  import('shiki/langs/xml.mjs'),
  import('shiki/langs/css.mjs'),
  import('shiki/langs/scss.mjs'),
  import('shiki/langs/less.mjs'),
  import('shiki/langs/markdown.mjs'),
  import('shiki/langs/python.mjs'),
  import('shiki/langs/yaml.mjs'),
  import('shiki/langs/toml.mjs'),
  import('shiki/langs/bash.mjs'),
  import('shiki/langs/powershell.mjs'),
  import('shiki/langs/bat.mjs'),
  import('shiki/langs/sql.mjs'),
  import('shiki/langs/go.mjs'),
  import('shiki/langs/rust.mjs'),
  import('shiki/langs/java.mjs'),
  import('shiki/langs/c.mjs'),
  import('shiki/langs/cpp.mjs'),
  import('shiki/langs/csharp.mjs'),
  import('shiki/langs/dockerfile.mjs'),
  import('shiki/langs/diff.mjs'),
]

interface ThemedToken {
  content: string
  color?: string
  fontStyle?: number
}

interface Highlighter {
  codeToTokensBase: (code: string, options: { lang: string; theme: string }) => ThemedToken[][]
  getLoadedLanguages: () => string[]
  loadLanguage: (lang: unknown) => Promise<void>
}

// VS Code Dark+ — colorful (orange strings, green numbers), matches the old
// highlight.js `vs2015` look the viewer had before. The markdown widget keeps
// its own github-dark; this theme governs only the app-side code/diff surface.
const THEME = 'dark-plus'

let highlighterP: Promise<Highlighter> | null = null
// Set once the lazy highlighter has finished building. Its presence is what
// lets the *Sync helpers below highlight in-render with no async flash — every
// view after the first in a session goes through that path.
let warmHighlighter: Highlighter | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterP) {
    const p = (async () => {
      const { createHighlighterCore } = await import('shiki/core')
      const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript')
      const hl = (await createHighlighterCore({
        themes: [import('shiki/themes/dark-plus.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })) as unknown as Highlighter
      await Promise.allSettled(langImports().map((q) => hl.loadLanguage(q)))
      warmHighlighter = hl
      return hl
    })()
    // Don't cache a rejected build — a transient failure (e.g. a chunk that
    // didn't load yet) would otherwise leave the viewer plain for the whole
    // session. Null it so the next call retries, and surface the cause.
    p.catch((err) => {
      console.warn('[shiki] highlighter build failed; will retry on next use', err)
      if (highlighterP === p) highlighterP = null
    })
    highlighterP = p
  }
  return highlighterP
}

// Eager-warm shortly after load so the FIRST file/diff after an app restart
// highlights without a cold wait (and so the common path is the synchronous,
// no-flash one). Deferred a tick so it doesn't compete with initial render;
// failure is non-fatal (callers fall back to plain text and retry).
if (typeof window !== 'undefined') {
  setTimeout(() => {
    void getHighlighter()
  }, 400)
}

function tokensToLines(hl: Highlighter, code: string, lang: string): string[] {
  return hl.codeToTokensBase(code, { lang, theme: THEME }).map((line) => line.map(tokenSpan).join(''))
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

// Shiki FontStyle bit flags (Italic=1, Bold=2, Underline=4).
function tokenSpan(t: ThemedToken): string {
  const styles: string[] = []
  if (t.color) styles.push(`color:${t.color}`)
  if (t.fontStyle) {
    if (t.fontStyle & 1) styles.push('font-style:italic')
    if (t.fontStyle & 2) styles.push('font-weight:bold')
    if (t.fontStyle & 4) styles.push('text-decoration:underline')
  }
  const style = styles.length ? ` style="${styles.join(';')}"` : ''
  return `<span${style}>${escapeHtml(t.content)}</span>`
}

/**
 * Highlight `code` and return one inner-HTML string per line (token `<span>`s,
 * no outer `<pre>`/`<code>`). Each line is independently valid HTML, so callers
 * can interleave their own per-line chrome (diff gutters/markers). Returns
 * `null` when the language isn't loaded or highlighting throws — callers then
 * fall back to plain text.
 */
export async function highlightToLines(code: string, lang: string | null | undefined): Promise<string[] | null> {
  if (!lang) return null
  try {
    const hl = await getHighlighter()
    if (!hl.getLoadedLanguages().includes(lang)) return null
    return tokensToLines(hl, code, lang)
  } catch {
    return null
  }
}

/**
 * Synchronous fast-path of {@link highlightToLines}. Returns the per-line HTML
 * immediately when the highlighter is already warm (built on an earlier view),
 * else `null` — so a caller can highlight in-render with no async flash and
 * fall back to the async path only on the first use in a session. Does NOT
 * build the highlighter (that would block render); kick it off via the async
 * helper when this returns `null`.
 */
export function highlightToLinesSync(code: string, lang: string | null | undefined): string[] | null {
  if (!lang || !warmHighlighter) return null
  try {
    if (!warmHighlighter.getLoadedLanguages().includes(lang)) return null
    return tokensToLines(warmHighlighter, code, lang)
  } catch {
    return null
  }
}

/** Synchronous fast-path of {@link highlightToInnerHtml}; see {@link highlightToLinesSync}. */
export function highlightToInnerHtmlSync(code: string, lang: string | null | undefined): string | null {
  const lines = highlightToLinesSync(code, lang)
  return lines === null ? null : lines.join('\n')
}

/**
 * Highlight `code` and return a single inner-HTML string (lines joined by `\n`),
 * suitable for writing into a `<code>` element. Returns `null` on the same
 * fallback conditions as {@link highlightToLines}.
 */
export async function highlightToInnerHtml(code: string, lang: string | null | undefined): Promise<string | null> {
  const lines = await highlightToLines(code, lang)
  return lines === null ? null : lines.join('\n')
}
