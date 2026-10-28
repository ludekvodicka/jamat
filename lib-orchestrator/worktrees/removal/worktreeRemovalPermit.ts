export type WorktreeRemovalPermit =
  | { kind: 'clean'; provedAt: number; allowed: readonly string[] }
  | { kind: 'discard'; by: 'person'; at: number }
