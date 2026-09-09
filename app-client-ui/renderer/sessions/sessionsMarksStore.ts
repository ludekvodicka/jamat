import type {
  RemoteConnectionsSnapshot,
} from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { SessionsSnapshot } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { TerminalTargetCodec } from '../../shared/terminalTarget'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { SessionsAttentionModel } from './sessionsAttentionModel'

/** The marks and the cross-window visibility that clears them. */
export interface SessionsMarksView {
  /** The sessions that want the person: a turn settled, or a runtime exited, while they were away. */
  marks: ReadonlySet<string>
  /** The active terminal targets across visible workspace windows, which put marks out. */
  activeTargetKeys: ReadonlySet<string>
}

/**
 * The attention model, lifted out of the sessions tree to the window that owns it.
 *
 * It lived inside the tree component until the marks had a second reader. That made them invisible
 * to a tab whenever the tree was closed, and a session tab is exactly where somebody with the
 * sidebar hidden would look. The model's rules hold as they always did: a first sighting raises
 * nothing, `unknown` is not a settled turn, and nothing survives a restart, so a mark is measured
 * from the first snapshot this window saw.
 *
 * One instance per window, main and holder alike, because a holder draws session tabs too and
 * "have I seen this" is a question about one window's screen rather than about the machine.
 */
export class SessionsMarksStore {
  private readonly localModel = new SessionsAttentionModel()
  private readonly remoteModels = new Map<string, SessionsAttentionModel>()
  private localMarks: ReadonlySet<string> = new Set()
  private readonly remoteMarks = new Map<string, ReadonlySet<string>>()
  private readonly listeners = new Set<() => void>()
  private view: SessionsMarksView = {
    marks: new Set(),
    activeTargetKeys: new Set(),
  }

  constructor(
    private readonly snapshots: SnapshotStore<SessionsSnapshot>,
    private readonly remoteSnapshots?: SnapshotStore<RemoteConnectionsSnapshot>,
  ) {}

  start(): () => void {
    const offLocal = this.snapshots.subscribe(() => this.apply(this.view.activeTargetKeys))
    const offRemote = this.remoteSnapshots?.subscribe(() => this.apply(this.view.activeTargetKeys))
      ?? (() => undefined)
    return () => {
      offLocal()
      offRemote()
    }
  }

  /**
   * Which sessions are on screen, handed in by whoever reads that event rather than read here.
   *
   * Switching tabs is when a mark has to go out, and waiting for the next snapshot to notice would
   * leave it lit on the very session being read. The tree also keeps these targets under its
   * Attention filter while the mark disappears, but its current-row tint is renderer-local.
   */
  setActiveTargets(targetKeys: ReadonlySet<string>): void {
    this.apply(targetKeys)
  }

  current(): SessionsMarksView {
    return this.view
  }

  /** The primitive a tab subscribes on: a boolean re-renders nothing when another session moves. */
  markedOf(sessionId: string): boolean {
    return this.view.marks.has(sessionId)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private apply(activeTargetKeys: ReadonlySet<string>): void {
    const sessions = this.snapshots.current().snapshot?.sessions
    // Kept even with no document to apply it to: this event fires on a visibility change, so one
    // arriving before the first snapshot is the only word this window has about what is on screen
    // until something changes again.
    if (sessions !== undefined) {
      const activeSessionIds = new Set(sessions
        .filter((session) => activeTargetKeys.has(session.sessionId))
        .map((session) => session.sessionId))
      this.localMarks = this.localModel.apply({ sessions, activeSessionIds })
    }
    this.applyRemote(activeTargetKeys)
    const marks = new Set(this.localMarks)
    for (const [remoteEndpointId, sessionIds] of this.remoteMarks)
      for (const sessionId of sessionIds)
        marks.add(TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId, sessionId }))
    if (sessions === undefined && this.remoteSnapshots?.current().snapshot === null) {
      // Published like every other change, not assigned quietly. `current()` is the `getSnapshot`
      // of a `useSyncExternalStore`, so handing out a new object nobody was told about leaves a
      // subscriber on the old value until something else happens to re-render it.
      const pending = { marks: this.view.marks, activeTargetKeys }
      if (SessionsMarksStore.same(this.view, pending)) return
      this.view = pending
      for (const listener of [...this.listeners]) listener()
      return
    }
    // The model builds a fresh set on every call, so an unchanged answer must keep the OLD view:
    // a new object every two seconds would re-render every subscriber for nothing.
    if (SessionsMarksStore.same(this.view, { marks, activeTargetKeys })) return
    this.view = { marks, activeTargetKeys }
    for (const listener of [...this.listeners]) listener()
  }

  private applyRemote(activeTargetKeys: ReadonlySet<string>): void {
    const remote = this.remoteSnapshots?.current().snapshot
    if (remote === null || remote === undefined) return
    const alive = new Set(remote.outbound.map((entry) => entry.remoteEndpointId))
    for (const entry of remote.outbound) {
      if (entry.sessions === null) continue
      let model = this.remoteModels.get(entry.remoteEndpointId)
      if (!model) {
        model = new SessionsAttentionModel()
        this.remoteModels.set(entry.remoteEndpointId, model)
      }
      const activeSessionIds = new Set(entry.sessions.sessions
        .filter((session) => activeTargetKeys.has(TerminalTargetCodec.key({
          kind: 'remote',
          remoteEndpointId: entry.remoteEndpointId,
          sessionId: session.sessionId,
        })))
        .map((session) => session.sessionId))
      this.remoteMarks.set(entry.remoteEndpointId, model.apply({
        sessions: entry.sessions.sessions,
        activeSessionIds,
      }))
    }
    for (const remoteEndpointId of [...this.remoteModels.keys()])
      if (!alive.has(remoteEndpointId)) {
        this.remoteModels.delete(remoteEndpointId)
        this.remoteMarks.delete(remoteEndpointId)
      }
  }

  private static same(before: SessionsMarksView, after: SessionsMarksView): boolean {
    return SessionsMarksStore.sameKeys(before.activeTargetKeys, after.activeTargetKeys)
      && SessionsMarksStore.sameKeys(before.marks, after.marks)
  }

  private static sameKeys(before: ReadonlySet<string>, after: ReadonlySet<string>): boolean {
    if (before.size !== after.size) return false
    for (const sessionId of before)
      if (!after.has(sessionId)) return false
    return true
  }
}
