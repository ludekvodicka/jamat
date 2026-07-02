// Public API for the mdExtRenderer widget.
//
// The surface stays small: { source, theme?, className?, remote?, allowRawHtml? }.
// Typed blocks (callouts / status / collapsible) are auto-detected from the source — no prop.
// There is deliberately NO public renderer registry (premature-abstraction guard); the blocks
// are built in.

export type MdExtTheme = 'light' | 'dark' | 'auto'

export interface MdExtRendererProps {
  /** Raw `.md` / `.mdext` source text. */
  source: string
  /**
   * Color theme. `'auto'` (default) inherits the host's CSS variables / colour scheme;
   * `'light'`/`'dark'` force a token set via a wrapper class.
   */
  theme?: MdExtTheme
  /** Extra class on the root element (e.g. the host's scoping class). */
  className?: string
  /**
   * Stricter sanitization tier for UNTRUSTED peer content (remote file viewer).
   * When true, external `http(s)`/`file:` resources (links + images) are dropped,
   * not just dangerous schemes. Default false.
   */
  remote?: boolean
  /**
   * Opt-in, DISCOURAGED raw-HTML escape hatch. When true, raw HTML embedded in the markdown is
   * parsed (rehype-raw) and rendered through a STRICTER sanitize tier (GitHub schema + no external
   * resource `src`); `<script>`/event handlers/`javascript:`/`data:` are still stripped. Prefer the
   * typed blocks over raw HTML. **Hard-disabled when `remote` is true** (untrusted peer content
   * never gets the hatch), regardless of this flag. Default false. Loaded lazily — when off, the
   * raw-HTML parser is never bundled into the host's hot path.
   */
  allowRawHtml?: boolean
}
