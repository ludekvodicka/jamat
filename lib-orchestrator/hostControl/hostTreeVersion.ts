import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The version a Host started from THIS tree would report, read from `app-host/package.json` - the
 * same file the Host's own `BuildInfoSource` falls back to. Comparing it with the version a running
 * Host published is what says "the Host you are talking to is older than the code you are editing".
 *
 * **What it can and cannot see.** Both sides read the same `package.json`, so this detects a version
 * that was bumped, not an arbitrary edit to a source file: a Host started before the last commit
 * reports `current` as long as the version did not move. Stronger evidence (the build's payload
 * hash) has to wait for a packaged Host, which is the only thing that can produce one honestly.
 *
 * Unreadable is null, and null is never read as a match - a missing answer must not be able to say
 * the Host is up to date.
 */
export class HostTreeVersion {
  private static readonly cacheMillisecondsConst = 30_000
  private static readonly packageNameConst = 'app-host'
  private static readonly packageFileNameConst = 'package.json'
  private cached: { at: number; version: string | null } | null = null

  /** `applicationRoot` is the directory `app-host` stands in, named by the client as everywhere. */
  constructor(private readonly applicationRoot: string) {}

  /**
   * Cached for half a minute because the composer runs on every debug read and this is a disk read;
   * a version that changes has to be built and restarted anyway, which takes longer than the TTL.
   */
  current(): string | null {
    const now = Date.now()
    if (this.cached !== null && now - this.cached.at < HostTreeVersion.cacheMillisecondsConst)
      return this.cached.version
    const version = this.read()
    this.cached = { at: now, version }
    return version
  }

  private read(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(
        join(
          this.applicationRoot,
          HostTreeVersion.packageNameConst,
          HostTreeVersion.packageFileNameConst,
        ),
        'utf8',
      )) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : null
    } catch {
      return null
    }
  }
}
