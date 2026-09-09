/**
 * Pure ring-buffer delta math: no filesystem, no PTY, no transport, so it is unit-testable on its own.
 *
 * A terminal keeps a bounded `ring` (last N chars) plus a monotonic `seq` = total chars ever
 * appended. Given a caller's earlier cursor `sinceSeq`, this returns exactly the chars appended
 * since. `truncated` is true when `sinceSeq` fell off the retained ring (the output overflowed it),
 * in which case the caller gets the whole ring instead of a clean delta.
 *
 * A cursor ABOVE `seq` is impossible against the stream it came from, so it means the caller is
 * holding a cursor from a different one (its slot was respawned, or the host restarted). Answering
 * "nothing missed" would leave two processes' output rendered as one continuous screen, so it is
 * reported as truncated: the caller resets and takes what is actually there.
 */
export function computeRingDelta(
  ring: string,
  seq: number,
  sinceSeq: number,
): { data: string; truncated: boolean } {
  const oldestSeq = seq - ring.length // seq of the first char still retained
  if (sinceSeq > seq) return { data: ring, truncated: true }
  if (sinceSeq === seq) return { data: '', truncated: false }
  if (sinceSeq < oldestSeq) return { data: ring, truncated: true }
  return { data: ring.slice(ring.length - (seq - sinceSeq)), truncated: false }
}
