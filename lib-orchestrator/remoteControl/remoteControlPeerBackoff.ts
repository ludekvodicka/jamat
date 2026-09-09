export class RemoteControlPeerBackoff {
  private static readonly baseMillisecondsConst = 500
  private static readonly maximumMillisecondsConst = 30_000

  static delay(attempt: number, random: () => number = Math.random): number {
    if (!Number.isSafeInteger(attempt) || attempt < 0)
      throw new Error('Remote peer reconnect attempt must be a non-negative integer')
    const exponential = Math.min(
      RemoteControlPeerBackoff.maximumMillisecondsConst,
      RemoteControlPeerBackoff.baseMillisecondsConst * 2 ** Math.min(attempt, 16),
    )
    const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4
    return Math.min(
      RemoteControlPeerBackoff.maximumMillisecondsConst,
      Math.round(exponential * jitter),
    )
  }
}
