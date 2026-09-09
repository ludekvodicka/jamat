import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { TerminalDetectorLimits } from '../terminalDetectorLimits'
import { TerminalPathExtractor } from '../extract/terminalPathExtractor'

interface WalkedFile {
  path: string
  segments: readonly string[]
}

export interface SuffixWalkBounds {
  depthMax: number
  entriesMax: number
}

/**
 * Last resort for a token that named no file on disk: walk the project for something whose trailing
 * segments match. Bounded on every axis, because a right-click must not turn into a tree scan of an
 * arbitrary directory.
 */
export class SuffixWalk {
  private static readonly boundsConst: SuffixWalkBounds = {
    depthMax: TerminalDetectorLimits.suffixWalkDepthMax,
    entriesMax: TerminalDetectorLimits.suffixWalkEntriesMax,
  }

  private static readonly ignoredNamesConst = new Set([
    '.git', '.svn', 'node_modules', '.vite', 'out', 'dist', '.next', '__pycache__',
  ])

  static async find(
    root: string,
    partial: string,
    limit = TerminalDetectorLimits.detectionsMax,
    bounds: SuffixWalkBounds = SuffixWalk.boundsConst,
  ): Promise<string[]> {
    const segments = TerminalPathExtractor.segmentsOf(partial).map((segment) => segment.toLowerCase())
    if (segments.length === 0) return []
    const files = await SuffixWalk.collect(root, TerminalPathExtractor.segTester(segments[segments.length - 1]), bounds)
    if (files.length === 0) return []
    // Longest suffix first: the most specific match wins, and a cut leading segment still resolves
    // once the pattern shrinks to the bare filename.
    for (let length = segments.length; length >= 1; length--) {
      const suffix = segments.slice(segments.length - length)
      const matches = files.filter((file) => TerminalPathExtractor.matchesSuffix(file.segments, suffix))
      if (matches.length > 0) return matches.slice(0, limit).map((file) => file.path)
    }
    return []
  }

  private static async collect(
    root: string,
    matchesName: (name: string) => boolean,
    bounds: SuffixWalkBounds,
  ): Promise<WalkedFile[]> {
    const files: WalkedFile[] = []
    let visited = 0

    // Asynchronous on purpose: this runs in the Electron main process, and a synchronous readdir of
    // up to entriesMax entries holds every window, every IPC answer and every terminal frame while
    // it runs. Every other read in this subsystem is already async.
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > bounds.depthMax) return
      if (visited >= bounds.entriesMax) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (++visited >= bounds.entriesMax) return
        const full = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!SuffixWalk.ignoredNamesConst.has(entry.name)) await walk(full, depth + 1)
        } else if (matchesName(entry.name.toLowerCase())) {
          files.push({
            path: full,
            segments: TerminalPathExtractor.segmentsOf(full).map((segment) => segment.toLowerCase()),
          })
        }
      }
    }

    await walk(root, 0)
    return files
  }
}
