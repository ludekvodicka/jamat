import type {
  RemoteControlPeerIdentity,
} from '../../../lib-orchestrator/remoteControl/remoteControlPeerApi.types'
import { ErrorText } from '../../shared/errorText'
import type { RemotePeerCredentialStore } from './remotePeerCredentialStore'

/**
 * What a person is shown about a caller nobody has trusted yet. The fingerprint is what the two
 * people compare out of band; the address is what says whether the call came from where they expect.
 * The display name is the caller's own text and is the one field that proves nothing.
 */
export interface RemoteInboundApprovalRequest {
  remoteComputerId: string
  remoteEndpointId: string
  displayName: string
  fingerprint: string
  remoteAddress: string
}

export interface RemoteInboundApprovalManagerDeps {
  credentials: Pick<RemotePeerCredentialStore, 'trustedInbound' | 'trustInbound'>
  /**
   * The human gate, a callback for `RemoteControlPairingManager`'s reason: this class decides
   * WHETHER to ask, the shell decides how to ask, and the tests answer without an Electron window.
   */
  confirm(request: RemoteInboundApprovalRequest): Promise<boolean>
  onChanged(): void
  onError(message: string): void
  now?(): number
}

/**
 * The only way inbound trust is granted: a caller the peer listener refused, put in front of a
 * person. Nothing waits on the wire while they decide - the connection that triggered this was
 * already closed, and the caller's own retry loop is what makes an Allow take effect.
 *
 * That is also what makes the brakes necessary: anyone who can reach the port can raise a dialog
 * here, so an unknown caller may raise at most one prompt at a time, at most one per identity per
 * interval, and a Deny buys silence from that identity for far longer.
 */
export class RemoteInboundApprovalManager {
  static readonly promptIntervalMillisecondsConst = 60_000
  static readonly denySuppressionMillisecondsConst = 600_000
  private static readonly recentBoundConst = 64
  private pending = false
  private readonly recent = new Map<string, { at: number; denied: boolean }>()

  constructor(private readonly deps: RemoteInboundApprovalManagerDeps) {}

  request(claimant: RemoteControlPeerIdentity, remoteAddress: string): void {
    const key = RemoteInboundApprovalManager.keyOf(claimant)
    // Raced an Allow: the caller redialled between the refusal and the write that answered it.
    if (this.deps.credentials.trustedInbound(
      claimant.remoteComputerId,
      claimant.remoteEndpointId,
    ) !== null) return
    if (this.pending) return
    if (!this.allows(key)) return
    this.pending = true
    this.remember(key, { at: this.clock(), denied: false })
    void this.ask(claimant, remoteAddress, key)
  }

  private async ask(
    claimant: RemoteControlPeerIdentity,
    remoteAddress: string,
    key: string,
  ): Promise<void> {
    try {
      const allowed = await this.deps.confirm({
        remoteComputerId: claimant.remoteComputerId,
        remoteEndpointId: claimant.remoteEndpointId,
        displayName: claimant.displayName,
        fingerprint: claimant.signing.fingerprint,
        remoteAddress,
      })
      if (!allowed) {
        this.remember(key, { at: this.clock(), denied: true })
        return
      }
      this.deps.credentials.trustInbound(claimant)
      this.deps.onChanged()
    } catch (error) {
      this.deps.onError(`Inbound approval failed: ${ErrorText.of(error)}`)
    } finally {
      this.pending = false
    }
  }

  private allows(key: string): boolean {
    const seen = this.recent.get(key)
    if (seen === undefined) return true
    const windowMilliseconds = seen.denied
      ? RemoteInboundApprovalManager.denySuppressionMillisecondsConst
      : RemoteInboundApprovalManager.promptIntervalMillisecondsConst
    return this.clock() - seen.at >= windowMilliseconds
  }

  /** Newest last, oldest evicted: a flood of made-up identities must not grow this without end. */
  private remember(key: string, entry: { at: number; denied: boolean }): void {
    this.recent.delete(key)
    this.recent.set(key, entry)
    for (const oldest of this.recent.keys()) {
      if (this.recent.size <= RemoteInboundApprovalManager.recentBoundConst) break
      this.recent.delete(oldest)
    }
  }

  private clock(): number {
    return this.deps.now === undefined ? Date.now() : this.deps.now()
  }

  /** A space cannot occur in either id, so no two identities can share one key. */
  private static keyOf(claimant: RemoteControlPeerIdentity): string {
    return `${claimant.remoteComputerId} ${claimant.remoteEndpointId}`
  }
}
