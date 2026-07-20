/**
 * Terminal file-path extraction — the universal base both `ClaudeFilePathExtractor` and
 * `CodexFilePathExtractor` extend. It turns a raw token a user right-clicked in a terminal into the
 * on-disk candidates the context menu should probe, and carries the character class the renderer's
 * buffer scan uses to grow that token.
 *
 * Pure — no fs, no DOM, no electron (same rule as `core/agents/renderer.ts`). The DOM buffer scan
 * stays in the renderer and reads `pathChars` off the selected extractor; the async disk probes
 * (`file:type`, `file:find-by-suffix`) run in the menu over IPC. Consumed by BOTH the renderer
 * (selection by agent) and the main process (`file:find-by-suffix` reuses the pure suffix matcher).
 */

import type { AgentId } from '../types/contracts.js'

export type PathCandidate =
  | { kind: 'direct'; path: string }                       // probe on disk via file:type
  | { kind: 'search'; baseDir: string; partial: string }   // project-tree suffix search; hits are viaSearch

export interface ResolveContext {
  projectDir: string | null
}

export abstract class TerminalFilePathExtractor {
  abstract readonly agent: AgentId

  /** Character class the renderer buffer scan uses to grow the token at the cursor. Base = the
   *  historical PATH_CHAR set; Claude widens it to keep its `…` truncation marker inside the token. */
  readonly pathChars: RegExp = /[a-zA-Z0-9._\-\\/:~]/

  /** Strip surrounding quotes, a trailing `:line[:col]`, and trailing punctuation from a raw token. */
  clean(raw: string): string {
    let p = raw.replace(/["`']/g, '').trim()
    p = p.replace(/:\d+(?::\d+)?$/, '')
    p = p.replace(/[.,;:!?\s]+$/, '')
    return p.trim()
  }

  /**
   * On-disk candidates for a raw token, in priority order. The menu probes them in order and stops at
   * the first that yields hits, so a direct hit wins and the project-tree search is only a fallback —
   * the same cost profile as before the refactor. Subclasses override to add agent-specific handling.
   */
  resolve(token: string, ctx: ResolveContext): PathCandidate[] {
    const cleaned = this.clean(token)
    if (!cleaned) return []
    const out: PathCandidate[] = []
    const direct = this.directPath(cleaned, ctx.projectDir)
    if (direct) out.push({ kind: 'direct', path: direct })
    if (ctx.projectDir && TerminalFilePathExtractor.looksSearchable(cleaned))
      out.push({ kind: 'search', baseDir: ctx.projectDir, partial: cleaned.replace(/\//g, '\\') })
    return out
  }

  /**
   * Make a raw cleaned token absolute, or null when it can't be. Drive-absolute / UNC / `~` are kept
   * as-is (main's `expandHome` resolves `~`); a bare relative token is joined under `projectDir`.
   * Mirrors the historical `resolveTerminalPath`. A driveless `\…` path is returned unchanged (it then
   * fails on disk) — the Codex subclass is what rewrites its own driveless session paths.
   */
  protected directPath(cleaned: string, projectDir: string | null): string | null {
    const n = cleaned.replace(/\//g, '\\')
    if (n === '~' || n.startsWith('~\\')) return n
    if (/^[a-zA-Z]:[\\/]/.test(n)) return n
    if (n.startsWith('\\')) return n
    if (projectDir) return projectDir.replace(/[\\/]+$/, '') + '\\' + n
    return null
  }

  /** A token worth a project-tree suffix search: path-ish with a filename-like last segment. */
  static looksSearchable(cleaned: string): boolean {
    const segs = cleaned.replace(/\//g, '\\').split('\\').filter((s) => s && s !== '…' && s !== '...')
    const last = segs[segs.length - 1] ?? ''
    return segs.length >= 1 && last.includes('.')
  }

  /** Per-segment matcher: a segment carrying `…` / `...` / `*` is a wildcard; else an exact compare
   *  (both sides are expected lowercased by the caller). */
  static segTester(patSeg: string): (fileSeg: string) => boolean {
    if (!/[…*]/.test(patSeg) && !patSeg.includes('...')) return (f) => f === patSeg
    // NUL placeholder for wildcard positions: it never appears in a real segment, so it survives the
    // regex-escape pass and can't collide with escaped content when we split on it.
    const wild = String.fromCharCode(0)
    const re = new RegExp(
      '^' +
        patSeg
          .replace(/…|\.\.\.|\*/g, wild)
          .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
          .split(wild)
          .join('.*') +
        '$',
    )
    return (f) => re.test(f)
  }

  /** Does a file's trailing segment list end with the (possibly wildcard) pattern segment list? */
  static matchesSuffix(fileSegsLower: string[], patternSegsLower: string[]): boolean {
    if (patternSegsLower.length > fileSegsLower.length) return false
    for (let i = 1; i <= patternSegsLower.length; i++) {
      const test = TerminalFilePathExtractor.segTester(patternSegsLower[patternSegsLower.length - i])
      if (!test(fileSegsLower[fileSegsLower.length - i])) return false
    }
    return true
  }
}
