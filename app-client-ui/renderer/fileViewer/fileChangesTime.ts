/** Second-precision near the present: a file changed moments ago is what this list is read for. */
export class FileChangesTime {
  private static readonly secondConst = 1_000
  private static readonly minuteConst = 60 * FileChangesTime.secondConst
  private static readonly hourConst = 60 * FileChangesTime.minuteConst
  private static readonly dayConst = 24 * FileChangesTime.hourConst
  private static readonly monthConst = 30 * FileChangesTime.dayConst

  static agoOf(timestamp: number, now: number): string {
    const elapsed = Math.max(0, now - timestamp)
    if (elapsed < FileChangesTime.minuteConst)
      return `${Math.floor(elapsed / FileChangesTime.secondConst)}s ago`
    if (elapsed < FileChangesTime.hourConst)
      return `${Math.floor(elapsed / FileChangesTime.minuteConst)}min ago`
    if (elapsed < FileChangesTime.dayConst)
      return `${Math.floor(elapsed / FileChangesTime.hourConst)}h ago`
    if (elapsed < FileChangesTime.monthConst)
      return `${Math.floor(elapsed / FileChangesTime.dayConst)}d ago`
    // The viewer's zone, not UTC. The group heading beside this one draws `toLocaleString()`, so a
    // UTC date here put two timestamps from the same list in two different zones - and east of
    // Greenwich a file changed just after midnight read as the day before.
    return new Date(timestamp).toLocaleDateString()
  }
}
