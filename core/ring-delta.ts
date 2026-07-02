/**
 * Pure ring-buffer delta math (electron-free, fs-free), so it's unit-testable via
 * `scripts/smoke-*.ts` without booting Electron or node-pty.
 *
 * A terminal keeps a bounded `ring` (last N chars) plus a monotonic `seq` = total
 * chars ever appended. Given a caller's earlier cursor `sinceSeq`, this returns
 * exactly the chars appended since — the Jamat's "answer delta". `truncated`
 * is true when `sinceSeq` fell off the retained ring (the output overflowed it),
 * in which case the caller gets the whole ring instead of a clean delta.
 */
export function computeRingDelta(
  ring: string,
  seq: number,
  sinceSeq: number,
): { data: string; truncated: boolean } {
  const oldestSeq = seq - ring.length // seq of the first char still retained
  if (sinceSeq >= seq) return { data: '', truncated: false }
  if (sinceSeq < oldestSeq) return { data: ring, truncated: true }
  return { data: ring.slice(ring.length - (seq - sinceSeq)), truncated: false }
}
