/**
 * Pre-seed `~/.claude.json` so a freshly launched Claude session in a given project
 * directory does NOT block on the interactive trust dialogs:
 *   - "Do you trust the files in this folder?"  → hasTrustDialogAccepted
 *   - "Allow external CLAUDE.md file imports?"   → hasClaudeMdExternalIncludesApproved
 *     (+ hasClaudeMdExternalIncludesWarningShown so the dialog isn't shown at all)
 *
 * All three entry points (app-agent, app-electron terminal, app-cli) funnel through the
 * Claude adapter's `buildLaunchCommand`, which calls this right before the process is
 * spawned — so the launched `claude` reads an already-approved entry and starts directly.
 *
 * Design notes:
 *  - Claude keys projects in `~/.claude.json` by the cwd normalized to FORWARD slashes
 *    (drive-letter case varies in practice). We set the flags on the canonical
 *    forward-slash key AND on every existing key that matches case-insensitively, so we
 *    hit whatever key Claude actually uses. If a brand-new dir is still missed once,
 *    Claude creates the entry and the next launch heals it.
 *  - Idempotent: writes only when a flag actually needs flipping (so it doesn't churn the
 *    file's mtime, which the Electron launch-gate watches).
 *  - Atomic (tmp + rename) and defensive: a missing/half-written/corrupt file is a no-op,
 *    never a throw — seeding must never block or break a launch.
 *
 * core/ rule compliance: no UI/framework deps, takes the config path as a parameter.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

/** The per-project flags that suppress the trust + external-import dialogs. */
export const TRUST_FLAGS = [
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
] as const

/** Normalize a directory to Claude's project-key form: backslashes → forward, no trailing slash. */
export function normalizeProjectKey(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * Ensure the project entry for `projectDir` in the claude.json at `claudeJsonPath` has the
 * trust/import flags set, so a launched session starts without interactive prompts.
 * Returns whether the file was changed. Never throws.
 */
export function ensureClaudeProjectTrust(
  projectDir: string,
  claudeJsonPath: string,
): { changed: boolean } {
  if (!projectDir) return { changed: false }

  let data: any
  try {
    data = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
  } catch {
    // Missing or mid-write/corrupt — do nothing rather than risk clobbering it.
    return { changed: false }
  }
  if (!data || typeof data !== 'object') return { changed: false }
  if (!data.projects || typeof data.projects !== 'object') data.projects = {}

  const canonical = normalizeProjectKey(projectDir)
  const canonicalLc = canonical.toLowerCase()

  // Targets: every existing key that matches case-insensitively, plus the canonical key
  // (so a not-yet-present dir gets a seeded entry too).
  const targets = new Set<string>([canonical])
  for (const key of Object.keys(data.projects)) {
    if (normalizeProjectKey(key).toLowerCase() === canonicalLc) targets.add(key)
  }

  let changed = false
  for (const key of targets) {
    const entry =
      data.projects[key] && typeof data.projects[key] === 'object' ? data.projects[key] : {}
    for (const flag of TRUST_FLAGS) {
      if (entry[flag] !== true) {
        entry[flag] = true
        changed = true
      }
    }
    data.projects[key] = entry
  }

  if (!changed) return { changed: false }

  // Atomic write so a concurrent reader/launcher never sees a half-written file.
  const tmp = `${claudeJsonPath}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, claudeJsonPath)
  return { changed: true }
}
