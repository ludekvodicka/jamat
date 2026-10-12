/**
 * How long a script run took, in the words the log header and the parent's badge both print:
 * `23.6 s`, `1 min 12 s`, `1 h 3 min`. Each unit is rounded before the next is chosen, so 59.96 s
 * reads `1 min 0 s` and never `60.0 s`.
 */
export class ScriptDuration {
  static text(milliseconds: number): string {
    const tenths = Math.round(Math.max(0, milliseconds) / 100)
    if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`
    const seconds = Math.round(milliseconds / 1000)
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
    const minutes = Math.round(milliseconds / 60_000)
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
  }
}
