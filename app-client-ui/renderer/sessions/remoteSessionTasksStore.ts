import type { RemoteConnectionsSnapshot } from '../../../lib-orchestrator/remoteControl/remoteConnectionsApi.types'
import type { RemoteTaskListing } from '../../../lib-orchestrator/remoteControl/remoteTaskApi.types'
import type { SessionTaskListing } from '../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { AppClientUiReport } from '../../shared/appClientUiReport'
import { TerminalTargetCodec, type TerminalTarget } from '../../shared/terminalTarget'
import type { SnapshotStore } from '../ipc/snapshotStore'
import { SessionWorkspaceProviders, type SessionWorkspacePorts } from '../panels/terminal/sessionWorkspaceProviders'
import { SessionTasksStore } from './sessionTasksStore'

type Target = Extract<TerminalTarget, { kind: 'remote' }>

export class RemoteSessionTasksStore {
  private readonly remote: SnapshotStore<RemoteConnectionsSnapshot>
  private readonly poll: SessionTasksStore
  private readonly readers = new Map<string, { workspace: SessionWorkspacePorts; stop(): void; epoch: string | null }>()
  private readonly targets = new Map<string, Target>()
  private drawn = new Set<string>()
  private readings: ReadonlyMap<string, RemoteTaskListing> = new Map()
  private readonly listeners = new Set<() => void>()

  constructor(remote: SnapshotStore<RemoteConnectionsSnapshot>) {
    this.remote = remote
    this.poll = new SessionTasksStore({ current: () => this.snapshot(), subscribe: (changed) => remote.subscribe(changed) }, {
      canRead: () => true,
      list: async (keys) => {
        const listings: Record<string, SessionTaskListing> = {}
        for (const key of keys) {
          const target = this.targets.get(key)
          if (!target || !this.wanted(key)) continue
          const reader = this.reader(target)
          if (!reader.workspace.listTasks) continue
          const result = await reader.workspace.listTasks()
          if (this.readers.get(key) !== reader || !this.wanted(key)) continue
          if (!result.ok || !result.value.ok) {
            const reason = !result.ok ? result.error : !result.value.ok ? result.value.error.detail : 'Source task read failed'
            listings[key] = { kind: 'none', code: 'unreadable', reason }
            this.accept(key, { listing: listings[key], scripts: this.readings.get(key)?.scripts ?? null })
          } else {
            listings[key] = result.value.value.listing
            this.accept(key, result.value.value)
          }
        }
        return { ok: true, value: { ok: true, value: listings } }
      }, reportError: AppClientUiReport.error,
    })
  }

  start(): () => void {
    const stop = this.poll.start()
    const changed = this.remote.subscribe(() => {
      let invalidated = false
      for (const [key, reader] of this.readers) {
        const target = this.targets.get(key)!
        const endpoint = this.endpoint(target)
        if ((endpoint?.connectionId ?? null) === reader.epoch && endpoint?.status === 'connected') continue
        reader.stop(); this.readers.delete(key)
        const next = new Map(this.readings); next.delete(key); this.readings = next
        invalidated = true
      }
      this.prune()
      if (invalidated) { this.poll.invalidate(); this.publish() }
    })
    return () => { stop(); changed(); for (const reader of this.readers.values()) reader.stop(); this.readers.clear(); this.targets.clear(); this.readings = new Map(); this.drawn.clear(); this.poll.invalidate(); this.publish() }
  }

  setWindowVisible(visible: boolean): void { this.poll.setWindowVisible(visible) }
  setDrawn(targets: readonly Target[]): void {
    this.drawn = new Set(targets.map((target) => TerminalTargetCodec.key(target)))
    for (const target of targets) this.targets.set(TerminalTargetCodec.key(target), target)
    this.poll.setDrawn(this.drawn)
    this.prune()
  }
  current(): ReadonlyMap<string, RemoteTaskListing> { return this.readings }
  subscribe(changed: () => void): () => void { this.listeners.add(changed); return () => { this.listeners.delete(changed) } }

  private snapshot() {
    const endpoints = this.remote.current().snapshot?.outbound ?? []
    const base = endpoints.find((entry) => entry.sessions)?.sessions
    if (!base) return { snapshot: null, error: null }
    return { error: null, snapshot: { ...base, sessions: endpoints.flatMap((endpoint) => {
      if (endpoint.status !== 'connected' || !endpoint.workspaceCapabilities?.includes('session-workspace.tasks') || !endpoint.workspaceCapabilities.includes('session-workspace.views')) return []
      return (endpoint.sessions?.sessions ?? []).map((session) => ({ ...session,
        sessionId: TerminalTargetCodec.key({ kind: 'remote', remoteEndpointId: endpoint.remoteEndpointId, sessionId: session.sessionId }) }))
    }) } }
  }
  private endpoint(target: Target) { return this.remote.current().snapshot?.outbound.find((entry) => entry.remoteEndpointId === target.remoteEndpointId) }
  private reader(target: Target) {
    const key = TerminalTargetCodec.key(target), held = this.readers.get(key)
    if (held) return held
    const workspace = SessionWorkspaceProviders.forTarget(target, this.remote)
    const reader = { workspace, stop: workspace.start(), epoch: this.endpoint(target)?.connectionId ?? null }
    this.readers.set(key, reader)
    return reader
  }
  private wanted(key: string): boolean { return this.drawn.has(key) }
  // The tree redraws on every publish and calls setDrawn again, so an offline target that is still
  // drawn must cost nothing here: publishing for it would loop the view (UA1-J12-1).
  private prune(): void {
    const present = new Set(this.snapshot().snapshot?.sessions.map((session) => session.sessionId) ?? [])
    let removed = false
    for (const key of this.targets.keys())
      if (!this.wanted(key) || !present.has(key)) {
        const reader = this.readers.get(key)
        if (reader) { reader.stop(); this.readers.delete(key); removed = true }
        if (!this.wanted(key)) this.targets.delete(key)
        if (!this.readings.has(key)) continue
        const next = new Map(this.readings); next.delete(key); this.readings = next
        removed = true
      }
    if (removed) { this.poll.invalidate(); this.publish() }
  }
  private accept(key: string, reading: RemoteTaskListing): void {
    if (JSON.stringify(this.readings.get(key)) === JSON.stringify(reading)) return
    const next = new Map(this.readings); next.set(key, reading); this.readings = next; this.publish()
  }
  private publish(): void { for (const changed of this.listeners) changed() }
}
