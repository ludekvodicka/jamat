import { parse as parseYaml } from 'yaml'

import { JsonShape } from '../../lib-orchestrator/shared/jsonShape'

export interface MdExtFrontmatterSplit {
  frontmatter: readonly (readonly [string, string])[] | null
  body: string
  bodyLineOffset: number
}

export class MdExtFrontmatter {
  private static readonly patternConst = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

  static split(source: string): MdExtFrontmatterSplit {
    const match = MdExtFrontmatter.patternConst.exec(source)
    if (!match) return { frontmatter: null, body: source, bodyLineOffset: 0 }
    try {
      const parsed = JsonShape.record(parseYaml(match[1]!))
      if (parsed !== null)
        return {
          frontmatter: Object.entries(parsed)
            .map(([key, value]) => [key, MdExtFrontmatter.format(value)]),
          body: source.slice(match[0].length),
          bodyLineOffset: (match[0].match(/\n/g) ?? []).length,
        }
    }
    catch {}
    return { frontmatter: null, body: source, bodyLineOffset: 0 }
  }

  private static format(value: unknown): string {
    if (Array.isArray(value)) return value.map((item) => MdExtFrontmatter.format(item)).join(', ')
    const record = JsonShape.record(value)
    if (record !== null)
      return Object.entries(record)
        .map(([key, item]) => `${key}: ${MdExtFrontmatter.format(item)}`)
        .join('\n')
    return String(value)
  }
}
