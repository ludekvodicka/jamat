import { RemoteControlPeerCodec } from '../../../../lib-orchestrator/remoteControl/remoteControlPeerCodec'

/**
 * The nonces of helloes already accepted, so none of them can be sent twice.
 *
 * How long one is kept is not a number of its own: a hello is fresh while our clock is within the
 * codec's skew window of its `sentAt`, so the nonce has to outlive exactly that and not a moment
 * less. It used to be a flat minute next to a thirty-second window, two numbers nothing tied
 * together, and `sentAt` - the only thing that says when this hello stops being replayable - was
 * taken as an argument and dropped.
 */
export class RemoteControlPeerNonceStore {
  private static readonly maximumEntriesConst = 4_096
  private readonly entries = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  accept(remoteComputerId: string, nonce: string, sentAt: number): boolean {
    this.prune()
    const key = `${remoteComputerId}\u0000${nonce}`
    if (this.entries.has(key) || this.entries.size >= RemoteControlPeerNonceStore.maximumEntriesConst)
      return false
    this.entries.set(
      key,
      sentAt + RemoteControlPeerCodec.maximumClockSkewMillisecondsConst,
    )
    return true
  }

  /** Strictly past its last acceptable moment, so the boundary millisecond is still remembered. */
  private prune(): void {
    const now = this.now()
    for (const [key, acceptableUntil] of this.entries)
      if (acceptableUntil < now) this.entries.delete(key)
  }
}
