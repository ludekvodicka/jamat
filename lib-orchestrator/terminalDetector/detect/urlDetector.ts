import { TerminalDetectorLimits } from '../terminalDetectorLimits'

/**
 * The second detector over the same capture, and the reason the capture carries `contextText` next
 * to the token: a URL breaks on different characters than a path, so it re-tokenises the region
 * itself instead of sharing the path scan's character class.
 */
export class UrlDetector {
  private static readonly patternConst = /https?:\/\/[^\s<>"'`]+/gi

  static find(contextText: string, limit = TerminalDetectorLimits.urlsMax): string[] {
    const found: string[] = []
    for (const match of contextText.matchAll(UrlDetector.patternConst)) {
      const url = UrlDetector.trimmed(match[0])
      if (url === null || found.includes(url)) continue
      found.push(url)
      if (found.length >= limit) break
    }
    return found
  }

  /** Terminal output puts URLs in sentences, so trailing punctuation is not part of them. */
  private static trimmed(candidate: string): string | null {
    const url = candidate.replace(/[.,;:!?)\]}>]+$/, '')
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
    } catch {
      return null
    }
  }
}
