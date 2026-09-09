import { ErrorText } from '../../shared/errorText'
import type { RemoteControlListenerSettings } from '../../shared/remoteControlSettings'
import type { RemoteListenerRuntime } from '../../shared/remoteSettingsSnapshot'
import type {
  RemoteControlPeerListenAddress,
  RemoteControlPeerServer,
} from './remoteControlPeerServer'

/**
 * What this owner needs of a peer server. It is handed one by the factory and never builds one,
 * which is what lets a test bind nothing at all.
 */
export type RemotePeerListenerServer =
  Pick<RemoteControlPeerServer, 'start' | 'beginStop' | 'stop'>

export type RemoteListenerApplyResult =
  | { ok: true }
  | { ok: false; code: 'busy' | 'stopping' | 'bind-failed'; detail: string }

export interface RemotePeerListenerManagerDeps {
  /**
   * A new server per bind. `RemoteControlPeerServer` is one-shot - `beginStop` marks it stopping for
   * good - so a listener that can be turned off and on again cannot hold one instance.
   */
  serverFactory(): RemotePeerListenerServer
  /**
   * Where a paired computer should dial: the advertised host from the settings and the port that
   * actually bound. Called only after a bind succeeds, so the pairing bundle never names an endpoint
   * nothing is listening on.
   */
  onBound(advertisedHost: string, port: number): void
  onChanged(): void
}

/**
 * The inbound listener as a live thing rather than a value read at boot. It owns the running server,
 * the state a person is shown and the address that was really taken, so a port can be changed
 * without restarting the client and a refused bind is visible instead of silent.
 */
export class RemotePeerListenerManager {
  private state: RemoteListenerRuntime = { status: 'disabled' }
  private server: RemotePeerListenerServer | null = null
  private pending: Promise<RemoteListenerApplyResult> | null = null
  private stopPromise: Promise<void> | null = null
  private stopped = false

  constructor(private readonly deps: RemotePeerListenerManagerDeps) {}

  runtime(): RemoteListenerRuntime {
    return this.state
  }

  /**
   * Single-flight: a second apply is refused rather than queued, because two of them are two servers
   * racing for one port and the loser's failure would be reported over the winner's success.
   */
  async apply(settings: RemoteControlListenerSettings): Promise<RemoteListenerApplyResult> {
    if (this.stopped)
      return { ok: false, code: 'stopping', detail: 'The remote listener is shutting down' }
    if (this.pending !== null)
      return { ok: false, code: 'busy', detail: 'Another listener change is still running' }
    const pending = this.run(settings)
    this.pending = pending
    try {
      return await pending
    } finally {
      this.pending = null
    }
  }

  /**
   * The synchronous half of quitting, for `beginQuit`: the connections go now and the waiting
   * happens in `stop`. It also latches, so a settings save arriving mid-quit binds nothing.
   */
  beginStop(): void {
    this.stopped = true
    this.server?.beginStop()
  }

  /** Idempotent by design: `beginQuit` and `dispose` both reach it, and they await the same stop. */
  stop(): Promise<void> {
    this.stopPromise ??= this.runStop()
    return this.stopPromise
  }

  private async run(settings: RemoteControlListenerSettings): Promise<RemoteListenerApplyResult> {
    let bound: RemoteControlPeerListenAddress | null = null
    try {
      // Stop first: the port a re-apply asks for is usually the one this listener is already
      // holding, and a start against itself fails with the address in use.
      await this.stopCurrent()
      if (this.stopped)
        return { ok: false, code: 'stopping', detail: 'The remote listener is shutting down' }
      if (!settings.enabled) {
        this.set({ status: 'disabled' })
        return { ok: true }
      }
      this.set({ status: 'starting' })
      const server = this.deps.serverFactory()
      bound = await server.start(settings.bindHost, settings.port)
      this.server = server
      this.set({ status: 'listening', actualHost: bound.host, actualPort: bound.port })
    } catch (error) {
      const detail = ErrorText.of(error)
      this.set({ status: 'failed', error: detail })
      return { ok: false, code: 'bind-failed', detail }
    }
    // Outside the bind's own failure path: a bundle that could not be written is not a listener that
    // did not come up, and the state a person is shown must not say otherwise.
    if (bound !== null) this.deps.onBound(settings.advertisedHost, bound.port)
    return { ok: true }
  }

  private async runStop(): Promise<void> {
    this.stopped = true
    // An apply already past its own `stopped` check owns the server it is building, so the one to
    // stop is whatever it leaves behind. Its own failure belongs to whoever called it; quitting
    // still has to take the port back.
    if (this.pending !== null) await this.pending.catch(() => undefined)
    await this.stopCurrent()
    if (this.state.status !== 'disabled') this.set({ status: 'disabled' })
  }

  private async stopCurrent(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    await server.stop()
  }

  private set(runtime: RemoteListenerRuntime): void {
    this.state = runtime
    this.deps.onChanged()
  }
}
