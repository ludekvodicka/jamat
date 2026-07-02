/**
 * Path scoping for the remote data ops (Direction #2). Pure (node:path only) so it can be
 * smoke-tested in isolation — it is the security-critical guard that keeps a remote
 * `file-read` / `file-diff` from reaching outside the configured project roots.
 */

import path from 'node:path'

/**
 * Resolve `filePath` to an absolute path IF it lies inside one of `roots` (a root itself, or any
 * descendant), else null. Uses `resolve` + a `root + sep` boundary check so a sibling whose name
 * merely shares a prefix (`/a/foobar` vs root `/a/foo`) does NOT match, and `..` traversal that
 * escapes a root is rejected (it resolves out of the root before the check).
 *
 * Case sensitivity follows the platform's `path` (case-preserving) — consistent with the existing
 * open-tab guard in control-ops.ts; callers feed paths from the same config/session source.
 */
export function scopeUnderRoots(filePath: unknown, roots: readonly string[]): string | null {
  if (typeof filePath !== 'string' || !filePath) return null
  let abs: string
  try { abs = path.resolve(filePath) } catch { return null }
  for (const r of roots) {
    if (!r) continue
    let root: string
    try { root = path.resolve(r) } catch { continue }
    if (abs === root || abs.startsWith(root + path.sep)) return abs
  }
  return null
}
