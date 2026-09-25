import { type JsonDocumentReading, JsonDocumentStore } from '../../shared/jsonDocumentStore'
import type { TerminalDetection } from '../terminalDetectorApi.types'

/** The two kinds that name something on disk, which is all the register ever holds. */
export type TerminalOpenableKind = Extract<TerminalDetection, { kind: 'file' | 'directory' }>['kind']

export interface OpenedPath {
  path: string
  kind: TerminalOpenableKind
  /** When this path last proved itself: a click in a terminal, or a panel it restored since. */
  openedAt: number
}

interface OpenedPathsDocument {
  schemaVersion: 1
  paths: OpenedPath[]
}

/**
 * The register of proven opens, kept across restarts so a panel opened from a terminal path on
 * another drive comes back with the client.
 *
 * It is still a proof and not a list of wishes: only the main process writes this file, and it
 * writes only what a detection or a restored panel already proved. The renderer's stored layout
 * names paths too, and that layout is exactly what this file must never be filled from.
 *
 * Writes are coalesced: a burst of proofs - every restored panel at boot - lands as one write of the
 * latest register, and a write that starts while another is on disk waits for it rather than racing
 * its rename.
 */
export class OpenedPathsStore extends JsonDocumentStore<OpenedPath[]> {
  private loaded: readonly OpenedPath[] = []
  private queued: OpenedPath[] | null = null
  private draining = false

  private constructor(file: string, report: (message: string) => void) {
    super(file, report)
  }

  static load(file: string, report: (message: string) => void): OpenedPathsStore {
    const store = new OpenedPathsStore(file, report)
    store.loaded = store.readDocumentSync()
    return store
  }

  protected get subject(): string {
    return 'The opened terminal paths'
  }

  protected get refusalConsequence(): string {
    return 'files opened from a terminal outside their session will not reopen after a restart '
      + 'until it is repaired or removed'
  }

  protected get readFailureConsequence(): string {
    return 'no earlier terminal open is remembered until it is repaired or removed'
  }

  protected emptyDocument(): OpenedPath[] {
    return []
  }

  protected writeFailureMessage(detail: string): string {
    return `Could not record the opened terminal paths in ${this.file}: ${detail}`
  }

  /** What the file held when this store was loaded, oldest first. */
  entries(): readonly OpenedPath[] {
    return this.loaded
  }

  save(entries: readonly OpenedPath[]): void {
    this.queued = entries.map((entry) => ({ ...entry }))
    if (!this.draining) void this.drain()
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (this.queued !== null) {
        const document: OpenedPathsDocument = { schemaVersion: 1, paths: this.queued }
        this.queued = null
        await this.writeDocument(document)
      }
    }
    finally {
      this.draining = false
    }
  }

  protected coerce(parsed: unknown): JsonDocumentReading<OpenedPath[]> {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { document: [], damaged: true }
    const paths = (parsed as { paths?: unknown }).paths
    if (paths === undefined) return { document: [], damaged: false }
    if (!Array.isArray(paths)) return { document: [], damaged: true }
    const kept: OpenedPath[] = []
    let damaged = false
    for (const entry of paths as unknown[]) {
      const opened = OpenedPathsStore.openedPathOf(entry)
      if (opened === null) damaged = true
      else kept.push(opened)
    }
    return { document: kept, damaged }
  }

  private static openedPathOf(entry: unknown): OpenedPath | null {
    if (typeof entry !== 'object' || entry === null) return null
    const { path, kind, openedAt } = entry as Record<string, unknown>
    if (typeof path !== 'string' || path === '') return null
    if (kind !== 'file' && kind !== 'directory') return null
    if (typeof openedAt !== 'number' || !Number.isFinite(openedAt)) return null
    return { path, kind, openedAt }
  }
}
