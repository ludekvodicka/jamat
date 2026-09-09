/**
 * How long ago something happened, in the words the launcher's rows use.
 *
 * At the launcher root because two screens read it: the projects rows and the existing-session rows
 * inside New Session. The removed history screen once imported it from
 * `projects/launcherProjectsScreen`, which pulled that component, the manage strip, the projects
 * model and `projects.css` into its graph for one date formatter.
 *
 * `now` is a parameter and not a call: a row that formats its own clock reading cannot be tested,
 * and every row of one render must be relative to the same instant.
 */
/** Coarse on purpose: the column answers "how long ago", and a clock in a list is noise. */
export class LauncherTime {
  private static readonly minuteConst = 60_000
  private static readonly hourConst = 60 * LauncherTime.minuteConst
  private static readonly dayConst = 24 * LauncherTime.hourConst

  static agoOf(timestamp: number | null, now: number): string {
    if (timestamp === null)
      return ''
    const elapsed = now - timestamp
    if (elapsed < LauncherTime.minuteConst)
      return 'just now'
    if (elapsed < LauncherTime.hourConst)
      return `${Math.floor(elapsed / LauncherTime.minuteConst)} min ago`
    if (elapsed < LauncherTime.dayConst)
      return `${Math.floor(elapsed / LauncherTime.hourConst)} h ago`
    if (elapsed < 2 * LauncherTime.dayConst)
      return 'yesterday'
    if (elapsed < 30 * LauncherTime.dayConst)
      return `${Math.floor(elapsed / LauncherTime.dayConst)} days ago`
    return new Date(timestamp).toISOString().slice(0, 10)
  }

  static ageOf(timestamp: number, now: number): string {
    const elapsed = now - timestamp
    if (elapsed < LauncherTime.minuteConst)
      return 'now'
    if (elapsed < LauncherTime.hourConst)
      return `${Math.floor(elapsed / LauncherTime.minuteConst)} min`
    if (elapsed < LauncherTime.dayConst)
      return `${Math.floor(elapsed / LauncherTime.hourConst)} h`
    if (elapsed < 30 * LauncherTime.dayConst) {
      const days = Math.floor(elapsed / LauncherTime.dayConst)
      return `${days} ${days === 1 ? 'day' : 'days'}`
    }
    return `${(elapsed / LauncherTime.dayConst / 30.44).toFixed(1)} mo`
  }
}
