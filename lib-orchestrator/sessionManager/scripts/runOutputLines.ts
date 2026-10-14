import type {
  RuntimeListResult,
  TerminalProjectionSnapshot,
  TerminalProjectionView,
} from '../../../app-host/app/wire/hostWire.js'
import type { SessionStepInfo } from '../sessionManagerApi.types'
import { ScreenTail } from '../workState/screenTail'
import type { HostRuntimeReader } from '../workState/workStateMonitor'

export interface RunOutputLinesDeps {
  /** The one Host connection, read the way `WorkStateMonitor` reads it. */
  client: HostRuntimeReader
  /** The run's definition row says so; false for a runtime with no run record. */
  liveLineOf: (runtimeSessionId: string) => boolean
  onChanged: () => void
}

interface RunOutputLine {
  outputSeq: number
  line: string | null
}

/**
 * The last output line of each running scripted run, read from the listings the session manager
 * already fetches. It holds no timer, as `WorkStateMonitor` does not: the line moves with the poll,
 * every 2 s while somebody looks and every 15 s while nobody does. Only a run whose `outputSeq` moved
 * is inspected, so an idle run costs nothing and its line, and the snapshot, stay as they are.
 *
 * The line is display only. svn prints non-ASCII names unsafely in plain text, so nothing decides on it.
 */
export class RunOutputLines {
  /** The viewport alone and a short raw tail: one line is read, never a screen to classify. */
  static readonly viewConst: TerminalProjectionView = { rawTailChars: 1_000, screenScrollbackRows: 0 }
  static readonly lineCharactersMaxConst = 160
  private static readonly controlPatternConst = /[\x00-\x08\x0b-\x1f\x7f]/g

  private readonly deps: RunOutputLinesDeps
  private readonly lines = new Map<string, RunOutputLine>()
  /** The runs the latest listing names alive with a live line; a pass in flight writes no other. */
  private eligible = new Set<string>()
  private observing = false
  private stopped = false

  constructor(deps: RunOutputLinesDeps) {
    this.deps = deps
  }

  /**
   * One listing, the reconcile's own, off the queue. The lines of runs it no longer names alive go
   * first, before any await, also in a pass dropped because it overlaps the previous one: a run that
   * ended never keeps its line behind another run's slow inspect.
   */
  async observe(listing: RuntimeListResult): Promise<void> {
    if (this.stopped) return
    this.eligible = new Set(listing.sessions
      .filter((session) => session.alive && this.deps.liveLineOf(session.runtimeSessionId))
      .map((session) => session.runtimeSessionId))
    if (this.forget()) this.deps.onChanged()
    if (this.observing) return
    this.observing = true
    try {
      await this.read(listing)
    } finally {
      this.observing = false
    }
  }

  /** As `WorkStateMonitor.stop`: a pass still in flight writes nothing and tells nobody. */
  stop(): void {
    this.stopped = true
    this.lines.clear()
  }

  lineOf(runtimeSessionId: string): string | null {
    return this.lines.get(runtimeSessionId)?.line ?? null
  }

  /** The line as a step: verbatim output, so no detail, no count and no seconds. */
  stepOf(runtimeSessionId: string): SessionStepInfo | null {
    const line = this.lineOf(runtimeSessionId)
    return line === null ? null : { text: line, detail: null, progress: null, startedAt: null }
  }

  /**
   * Physical rows first: the Host applies `\r` and cursor moves to them, which is how a progress line
   * repaints itself. A Host without rows leaves the raw tail, where each row keeps only what follows
   * its last `\r`.
   */
  static lastLineOf(projection: Pick<TerminalProjectionSnapshot, 'screenLines' | 'raw'>): string | null {
    return RunOutputLines.lastOf(projection.screenLines ?? [])
      ?? RunOutputLines.lastOf((projection.raw ?? '').split('\n').map((row) => {
        const text = row.endsWith('\r') ? row.slice(0, -1) : row
        return text.slice(text.lastIndexOf('\r') + 1)
      }))
  }

  private static lastOf(rows: readonly string[]): string | null {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const text = ScreenTail.stripAnsi(rows[index]).replace(/\t/g, ' ')
        .replace(RunOutputLines.controlPatternConst, '').trim()
      if (text === '') continue
      const characters = Array.from(text)
      return characters.length <= RunOutputLines.lineCharactersMaxConst
        ? text
        : characters.slice(0, RunOutputLines.lineCharactersMaxConst).join('').trimEnd()
    }
    return null
  }

  /** True when a forgotten run had a line on show. */
  private forget(): boolean {
    let changed = false
    for (const [runtimeSessionId, known] of [...this.lines]) {
      if (this.eligible.has(runtimeSessionId)) continue
      this.lines.delete(runtimeSessionId)
      if (known.line !== null) changed = true
    }
    return changed
  }

  private async read(listing: RuntimeListResult): Promise<void> {
    let changed = false
    for (const session of listing.sessions) {
      if (!this.eligible.has(session.runtimeSessionId)) continue
      const known = this.lines.get(session.runtimeSessionId)
      if (known?.outputSeq === session.outputSeq) continue
      const inspected = await this.deps.client.runtimeInspect(
        { hostInstanceId: listing.hostInstanceId, runtimeSessionId: session.runtimeSessionId, generation: session.generation },
        RunOutputLines.viewConst,
      )
      if (this.stopped) return
      // A refused inspect keeps the last line, and its sequence, so the next pass asks again.
      if (!inspected.ok || !this.eligible.has(session.runtimeSessionId)) continue
      // No projection is an absence of output, not an empty screen: the line stands, and the
      // sequence is taken so an idle run is not inspected again on every poll.
      const current = this.lines.get(session.runtimeSessionId)
      const projection = inspected.value.projection
      const line = projection === null ? current?.line ?? null : RunOutputLines.lastLineOf(projection)
      this.lines.set(session.runtimeSessionId, { outputSeq: session.outputSeq, line })
      if (line !== (current?.line ?? null)) changed = true
    }
    if (changed) this.deps.onChanged()
  }
}
