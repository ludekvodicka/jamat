import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type { FileChangesContext } from '../fileChangesManager/fileChangesManagerApi.types'
import type { SessionWorkingContextResult } from '../sessionManager/sessionManager'
import { PathCompare } from '../shared/pathCompare'
import { UrlDetector } from './detect/urlDetector'
import { TerminalPathEvaluator, type ResolvedPath } from './resolve/terminalPathEvaluator'
import type {
  ChangedPathHint,
  TerminalDetectResult,
  TerminalDetection,
  TerminalDetectionChild,
  TerminalMenuCapture,
} from './terminalDetectorApi.types'
import { TerminalDetectorLimits } from './terminalDetectorLimits'

export interface TerminalDetectorDeps {
  workingContext(sessionId: string): Promise<SessionWorkingContextResult>
  changedPaths(context: FileChangesContext): Promise<readonly ChangedPathHint[]>
}

/** The kinds are the wire type's, never a second copy: a new one has to break this file to be added. */
type TerminalDetectionKind = TerminalDetection['kind']
/** The two that name something on disk, which is all `markOpened` and `OpenedPath` ever hold. */
type TerminalOpenableKind = Extract<TerminalDetection, { kind: 'file' | 'directory' }>['kind']

interface StoredDetection {
  path: string
  kind: TerminalDetectionKind
  line: number | null
}

interface StoredRequest {
  sessionId: string
  expiresAt: number
  entries: Map<string, StoredDetection>
}

export interface TerminalDetectionHit {
  sessionId: string
  path: string
  kind: TerminalDetectionKind
  line: number | null
  /** The same answer the detection was drawn from, so the open channel enforces the row it offered. */
  opensExternally: boolean
}

interface OpenedPath {
  path: string
  kind: TerminalOpenableKind
}

/**
 * What one right-click in a terminal means. The renderer hands over the raw text it scanned off the
 * screen and gets back opaque detection ids; every action afterwards names an id, never a path, so
 * the renderer can only ask for what a detection actually found.
 */
export class TerminalDetector {
  /** What the built-in viewer would answer with a hex dump while the machine has a reader for it. */
  private static readonly externalExtensionsConst: ReadonlySet<string> = new Set(['.pdf'])

  private readonly evaluator = new TerminalPathEvaluator()
  private readonly requests = new Map<string, StoredRequest>()
  private readonly openedPaths = new Map<string, OpenedPath>()

  constructor(
    private readonly deps: TerminalDetectorDeps,
    private readonly now: () => number = Date.now,
  ) {}

  async detect(sessionId: string, capture: TerminalMenuCapture): Promise<TerminalDetectResult> {
    const context = await this.deps.workingContext(sessionId)
    const cwd = context.ok ? context.value.cwd : null
    const agent = context.ok ? context.value.agent : null
    const resolved = await this.evaluator.evaluate(TerminalDetector.tokensOf(capture), {
      cwd,
      agentId: agent?.agentId ?? null,
      changedPaths: () => cwd === null
        ? Promise.resolve([])
        : this.deps.changedPaths({ sessionId, cwd, agent }),
    })

    const entries = new Map<string, StoredDetection>()
    const detections: TerminalDetection[] = []
    for (const item of resolved.slice(0, TerminalDetectorLimits.detectionsMax))
      detections.push(await this.detectionOf(item, entries))
    for (const url of UrlDetector.find(TerminalDetector.contextOf(capture)))
      detections.push({
        kind: 'url',
        detectionId: TerminalDetector.mintDetectionId(entries, { path: url, kind: 'url', line: null }),
        url,
      })

    const requestId = randomUUID()
    this.storeRequest(requestId, { sessionId, expiresAt: this.now() + TerminalDetectorLimits.requestTtlMilliseconds, entries })
    return { requestId, detections }
  }

  /** The one way an action channel turns an id back into a path. Null for a foreign or expired id. */
  pathOf(requestId: string, detectionId: string): TerminalDetectionHit | null {
    this.prune()
    const request = this.requests.get(requestId)
    if (request === undefined) return null
    const detection = request.entries.get(detectionId)
    if (detection === undefined) return null
    return {
      sessionId: request.sessionId,
      path: detection.path,
      kind: detection.kind,
      line: detection.line,
      opensExternally: TerminalDetector.opensExternally(detection.kind, detection.path),
    }
  }

  /** Main records every proven open here, so a later remount of the same panel can be answered
   *  without a detection. The register dies with the process; restoring after a restart refuses. */
  markOpened(path: string, kind: 'file' | 'directory'): void {
    const comparable = PathCompare.comparable(path)
    this.openedPaths.delete(comparable)
    this.openedPaths.set(comparable, { path, kind })
    for (const oldest of this.openedPaths.keys()) {
      if (this.openedPaths.size <= TerminalDetectorLimits.openedPathsMax) break
      this.openedPaths.delete(oldest)
    }
  }

  wasOpened(path: string): boolean {
    if (this.openedPaths.has(PathCompare.comparable(path))) return true
    for (const opened of this.openedPaths.values())
      if (opened.kind === 'directory' && PathCompare.isInside(opened.path, path)) return true
    return false
  }

  private async detectionOf(item: ResolvedPath, entries: Map<string, StoredDetection>): Promise<TerminalDetection> {
    const detectionId = TerminalDetector.mintDetectionId(entries, { path: item.path, kind: item.kind, line: item.line })
    if (item.kind === 'file')
      return {
        kind: 'file',
        detectionId,
        path: item.path,
        name: basename(item.path),
        line: item.line,
        column: item.column,
        via: item.via,
        opensExternally: TerminalDetector.opensExternally('file', item.path),
      }
    if (item.kind === 'directory') {
      const { children, truncated } = await TerminalDetector.childrenOf(item.path, entries)
      return {
        kind: 'directory',
        detectionId,
        path: item.path,
        name: basename(item.path),
        via: item.via,
        children,
        childrenTruncated: truncated,
      }
    }
    throw new Error(`Unknown resolved path kind: ${JSON.stringify(item)}`)
  }

  private static async childrenOf(
    path: string,
    entries: Map<string, StoredDetection>,
  ): Promise<{ children: TerminalDetectionChild[]; truncated: boolean }> {
    let names: string[]
    try {
      const found = await readdir(path, { withFileTypes: true })
      names = found.filter((entry) => entry.isFile()).map((entry) => entry.name)
    } catch {
      return { children: [], truncated: false }
    }
    const children = names.slice(0, TerminalDetectorLimits.directoryChildrenMax).map((name) => {
      const child = join(path, name)
      return {
        detectionId: TerminalDetector.mintDetectionId(entries, { path: child, kind: 'file', line: null }),
        name,
        opensExternally: TerminalDetector.opensExternally('file', child),
      }
    })
    return { children, truncated: names.length > children.length }
  }

  /**
   * Whether the desktop opens this one rather than the built-in viewer. The extension is the whole
   * rule on purpose: a menu answers a right click, and reading the file to find out what it is would
   * put a second disk round trip in front of every row.
   *
   * Read twice from one place - once for the row the menu draws, once for the channel that acts on
   * it - so a renderer cannot ask for the desktop over a file the menu never offered it for.
   */
  private static opensExternally(kind: TerminalDetectionKind, path: string): boolean {
    if (kind !== 'file') return false
    return TerminalDetector.externalExtensionsConst.has(extname(path).toLowerCase())
  }

  private static mintDetectionId(
    entries: Map<string, StoredDetection>,
    detection: StoredDetection,
  ): string {
    const detectionId = randomUUID()
    entries.set(detectionId, detection)
    return detectionId
  }

  private static contextOf(capture: TerminalMenuCapture): string {
    return capture.contextText.slice(0, TerminalDetectorLimits.captureContextCharactersMax)
  }

  /** The selection arrives exactly as xterm made it, so it can be a whole block of screen. A token
   *  that spans lines is not a path, and letting one through only produces work and noise. */
  private static tokensOf(capture: TerminalMenuCapture): string[] {
    const tokens: string[] = []
    // The stitched token first, the single-row run behind it: the disk decides between them, and
    // the order only says which one a menu lists first when both name something real.
    for (const candidate of [capture.token, capture.fallbackToken, capture.selection]) {
      if (candidate === null) continue
      // The line test comes BEFORE the cut, and the order is load-bearing: a selection whose first
      // line ending sits past the ceiling would have had it sliced away and gone through as one
      // token, which is the case the comment above says cannot happen.
      if (/[\r\n]/.test(candidate)) continue
      const token = candidate.slice(0, TerminalDetectorLimits.captureTokenCharactersMax).trim()
      if (token === '') continue
      if (!tokens.includes(token)) tokens.push(token)
    }
    return tokens
  }

  private storeRequest(requestId: string, request: StoredRequest): void {
    this.prune()
    this.requests.set(requestId, request)
    for (const oldest of this.requests.keys()) {
      if (this.requests.size <= TerminalDetectorLimits.requestsMax) break
      this.requests.delete(oldest)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [requestId, request] of this.requests)
      if (request.expiresAt <= now) this.requests.delete(requestId)
  }
}
