import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Claude Code keeps a project's transcripts in `<claudeHome>/projects/<encoded cwd>`. That encoding
 * is the only link between a folder on disk and its history, so it lives in exactly one place: the
 * session source and the history migrator both resolve through this class.
 */
export class ClaudeProjectsLocator {
  private lookup: Map<string, string> | null = null
  private generation = 0
  /** The build in flight, so callers that arrive during one join it instead of starting their own. */
  private building: Promise<Map<string, string>> | null = null

  constructor(private readonly claudeHome: string) {}

  /**
   * EVERY non-alphanumeric character becomes '-'. Verified against real store directories: '.', ' ',
   * '_' and both separators all collapse the same way. A narrower expression (replacing only the
   * separators) reads as equivalent and is not: it silently hid the history of every project whose
   * path held a '_', a space or a '.', an entire category at a time. Never widen or narrow it.
   */
  static encodeProjectDir(folderPath: string): string {
    return folderPath.replace(/[^A-Za-z0-9]/g, '-')
  }

  async resolveProjectDir(projectPath: string): Promise<string | null> {
    const encoded = ClaudeProjectsLocator.encodeProjectDir(projectPath).toLowerCase()
    const lookup = await this.directoryLookup()
    const hit = lookup.get(encoded)
    if (hit) return hit
    // A store directory created after the map was built (a session started while this process runs)
    // would never resolve. One rescan heals that; a second one would only re-read the same listing.
    //
    // Only the caller still holding the map that missed asks for that rescan. A listing sorted by
    // activity resolves every project at once and most of them have no Claude history at all, so
    // when each miss dropped the shared map the rescans multiplied by the number of misses: 40
    // listings of one directory for 28 projects, where two is the answer.
    // Somebody else already replaced the map this missed on; their rescan is the one rescan.
    if (this.lookup !== lookup) return (await this.directoryLookup()).get(encoded) ?? null
    this.invalidate()
    return (await this.directoryLookup()).get(encoded) ?? null
  }

  invalidate(): void {
    this.generation += 1
    this.lookup = null
  }

  /** Keyed by the lowercased directory name: the encoded path keeps the case the user typed. */
  private async directoryLookup(): Promise<Map<string, string>> {
    if (this.lookup) return this.lookup
    if (!this.building) this.building = this.buildLookup()
    return this.building
  }

  private async buildLookup(): Promise<Map<string, string>> {
    try {
      while (true) {
        const generation = this.generation
        const lookup = await this.walkStore()
        // An invalidate() during the walk means this map already describes a store that moved -
        // the migrator renames a store directory and invalidates. Installing it would answer a hit
        // with a directory that no longer exists, and nothing later re-checks a hit; and the callers
        // that joined this build gave up their own readdir for it, so they are answered from the
        // walk that ran after the rename rather than from this one.
        if (this.generation !== generation) continue
        this.lookup = lookup
        return lookup
      }
    } finally {
      this.building = null
    }
  }

  private async walkStore(): Promise<Map<string, string>> {
    const projectsDirectory = join(this.claudeHome, 'projects')
    const lookup = new Map<string, string>()
    try {
      for (const name of await readdir(projectsDirectory))
        lookup.set(name.toLowerCase(), join(projectsDirectory, name))
    } catch { /* no projects directory yet: every lookup misses until Claude Code writes one */ }
    return lookup
  }
}
