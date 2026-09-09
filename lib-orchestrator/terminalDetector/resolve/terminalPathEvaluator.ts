import { stat } from 'node:fs/promises'

import { PathCompare } from '../../shared/pathCompare'
import { PathExtractors } from '../extract/pathExtractors'
import { TerminalPathExtractor, type PathCandidate } from '../extract/terminalPathExtractor'
import type {
  ChangedPathHint,
  TerminalDetectionOrigin,
  TerminalDetectorAgentId,
} from '../terminalDetectorApi.types'
import { TerminalDetectorLimits } from '../terminalDetectorLimits'
import { SuffixWalk } from './suffixWalk'

export interface ResolvedPath {
  path: string
  kind: 'file' | 'directory'
  line: number | null
  column: number | null
  via: TerminalDetectionOrigin
}

export interface TerminalPathEvaluatorContext {
  cwd: string | null
  agentId: TerminalDetectorAgentId | null
  changedPaths(): Promise<readonly ChangedPathHint[]>
}

/**
 * Three tiers, first non-empty wins: what the token literally names, then what the session's own
 * change log knows, then a bounded walk of the project. The log sits in the middle because a path
 * an agent just wrote about is a better guess than any name-shaped match found by walking.
 */
export class TerminalPathEvaluator {
  async evaluate(
    tokens: readonly string[],
    context: TerminalPathEvaluatorContext,
  ): Promise<readonly ResolvedPath[]> {
    const extractor = PathExtractors.of(context.agentId)
    const candidates = tokens.flatMap((token) => extractor.resolve(token, { projectDir: context.cwd }))

    const direct = await TerminalPathEvaluator.probeAll(candidates, context.cwd)
    if (direct.length > 0) return direct

    const searches = TerminalPathEvaluator.searchesOf(candidates)
    if (searches.length === 0) return []

    const changed = await TerminalPathEvaluator.againstChangeLog(await context.changedPaths(), searches)
    if (changed.length > 0) return changed

    if (context.cwd === null) return []
    return TerminalPathEvaluator.againstProject(context.cwd, searches)
  }

  private static async probeAll(
    candidates: readonly PathCandidate[],
    cwd: string | null,
  ): Promise<ResolvedPath[]> {
    const resolved: ResolvedPath[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      if (candidate.kind !== 'direct') continue
      if (!TerminalPathEvaluator.reachable(candidate.path, cwd)) continue
      const comparable = PathCompare.comparable(candidate.path)
      if (seen.has(comparable)) continue
      seen.add(comparable)
      const kind = await TerminalPathEvaluator.nodeKindOf(candidate.path)
      if (kind === null) continue
      resolved.push({ path: candidate.path, kind, line: candidate.line, column: candidate.column, via: 'direct' })
      if (resolved.length >= TerminalDetectorLimits.detectionsMax) break
    }
    return resolved
  }

  private static searchesOf(candidates: readonly PathCandidate[]): { partial: string; line: number | null }[] {
    const searches: { partial: string; line: number | null }[] = []
    const seen = new Set<string>()
    for (const candidate of candidates) {
      if (candidate.kind !== 'search') continue
      if (seen.has(candidate.partial)) continue
      seen.add(candidate.partial)
      searches.push({ partial: candidate.partial, line: candidate.line })
    }
    return searches
  }

  private static async againstChangeLog(
    hints: readonly ChangedPathHint[],
    searches: readonly { partial: string; line: number | null }[],
  ): Promise<ResolvedPath[]> {
    const files = hints.map((hint) => ({
      hint,
      segments: TerminalPathExtractor.segmentsOf(hint.path).map((segment) => segment.toLowerCase()),
    }))
    for (const search of searches) {
      const pattern = TerminalPathExtractor.segmentsOf(search.partial).map((segment) => segment.toLowerCase())
      if (pattern.length === 0) continue
      for (let length = pattern.length; length >= 1; length--) {
        const suffix = pattern.slice(pattern.length - length)
        const matches = files.filter((file) => TerminalPathExtractor.matchesSuffix(file.segments, suffix))
        if (matches.length === 0) continue
        // The change log lists what an agent touched, including what it deleted, so a hint is a
        // candidate rather than an answer. Offering a row that cannot open is worse than no row.
        const resolved: ResolvedPath[] = []
        for (const match of matches.slice(0, TerminalDetectorLimits.detectionsMax)) {
          const kind = await TerminalPathEvaluator.nodeKindOf(match.hint.path)
          if (kind === null) continue
          resolved.push({ path: match.hint.path, kind, line: search.line, column: null, via: 'changed' })
        }
        if (resolved.length > 0) return resolved
      }
    }
    return []
  }

  private static async againstProject(
    cwd: string,
    searches: readonly { partial: string; line: number | null }[],
  ): Promise<ResolvedPath[]> {
    for (const search of searches) {
      const hits = await SuffixWalk.find(cwd, search.partial)
      if (hits.length === 0) continue
      return hits.map((path) => ({ path, kind: 'file' as const, line: search.line, column: null, via: 'search' as const }))
    }
    return []
  }

  /**
   * A UNC path is the one candidate whose probe leaves this machine: on Windows a stat of
   * \host\share is an SMB connect with the user's credentials to a host named by text a foreign
   * process printed into the terminal. It is answered only when the session itself works on that
   * share, which is what makes it the user's own host rather than one the output chose.
   */
  private static reachable(path: string, cwd: string | null): boolean {
    if (!TerminalPathEvaluator.isUnc(path)) return true
    if (cwd === null || !TerminalPathEvaluator.isUnc(cwd)) return false
    return PathCompare.comparable(TerminalPathEvaluator.shareOf(path))
      === PathCompare.comparable(TerminalPathEvaluator.shareOf(cwd))
  }

  private static isUnc(path: string): boolean {
    return path.startsWith('\\\\') || path.startsWith('//')
  }

  /** `\\host\share` of a UNC path, which is as far as "the same place" is worth comparing. */
  private static shareOf(path: string): string {
    const parts = path.replace(/\//g, '\\').split('\\').filter((part) => part.length > 0)
    return parts.slice(0, 2).join('\\')
  }

  private static async nodeKindOf(path: string): Promise<'file' | 'directory' | null> {
    try {
      const info = await TerminalPathEvaluator.within(stat(path))
      if (info === null) return null
      if (info.isDirectory()) return 'directory'
      if (info.isFile()) return 'file'
      return null
    } catch {
      return null
    }
  }

  /**
   * The probe budget. Without it the caller's only bound is the filesystem's, and a disconnected
   * share or a dead mount holds the menu open and dead for tens of seconds.
   */
  private static async within<T>(work: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        work,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), TerminalDetectorLimits.probeMilliseconds)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}
