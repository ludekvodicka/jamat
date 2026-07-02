import { parse as parseYaml } from 'yaml'

// Leading YAML frontmatter (--- … ---). Without stripping it, react-markdown turns the opening
// `---` into an <hr> and renders the YAML as mangled body text.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export interface FrontmatterSplit {
  /** Parsed key→display-string pairs, or null when there is no valid frontmatter. */
  frontmatter: Array<[string, string]> | null
  /** The document body with any frontmatter block removed. */
  body: string
}

const formatValue = (v: unknown): string => {
  if (Array.isArray(v)) return v.map(formatValue).join(', ')
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${formatValue(val)}`)
      .join('\n')
  }
  return String(v)
}

/**
 * Detect + strip leading YAML frontmatter. The `yaml.parse` itself is the validity guard:
 * only a block that parses to a plain object is treated as frontmatter and removed — so a
 * document that legitimately starts with a `---` thematic break is left untouched.
 */
export function splitFrontmatter(source: string): FrontmatterSplit {
  const m = FRONTMATTER_RE.exec(source)
  if (!m) return { frontmatter: null, body: source }
  try {
    const data = parseYaml(m[1]) as unknown
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const frontmatter = Object.entries(data as Record<string, unknown>).map(
        ([k, v]) => [k, formatValue(v)] as [string, string],
      )
      return { frontmatter, body: source.slice(m[0].length) }
    }
  } catch {
    /* malformed frontmatter → leave the document untouched */
  }
  return { frontmatter: null, body: source }
}
