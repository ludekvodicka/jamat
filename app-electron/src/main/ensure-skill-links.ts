/**
 * Auto-link this repo's project-local skills into the global Claude skills dir
 * (`~/.claude/skills/<name>`) via NTFS junctions, on every app start — so every
 * machine that runs the app gets them with no manual `mklink`. The automated
 * successor to the old `scripts/link-skill.ps1` (run once, by hand).
 *
 * These skills live IN the app repo (not the shared `claude-extensions` repo)
 * because they document THIS app's surface and version with it — so the junction
 * must point at the working copy (`<repo>/skills/<name>`), where SVN updates and
 * edits flow, and where Claude Code reads the markdown.
 *
 * Source root: the repo's `skills/` CONTAINER — each subdir is a skill, linked by its own name
 * (e.g. `skills/jamat`, `skills/mdext-renderer`). The mdext-renderer authoring skill used
 * to ship co-versioned inside the mdExtRenderer widget (svn:external); it now lives here in the app,
 * alongside this app's other skills, because it documents what THIS app's agents should emit.
 *
 * For each `<repo>/skills/<name>`:
 *  - no link               → create a junction
 *  - junction, wrong target (e.g. a stale link into a legacy v1 app) → repoint
 *  - junction, correct     → no-op (idempotent)
 *  - a REAL directory      → leave it + warn (never clobber a user's own skill)
 *
 * It also prunes a junction under `~/.claude/skills` that points into THIS repo's
 * `skills/` but whose source no longer exists — so a renamed/absorbed skill (e.g.
 * the old `jamat`, now folded into `jamat`) doesn't leave a dead link.
 *
 * Windows-only (junctions). Fully non-fatal: any failure is logged and swallowed —
 * linking a skill must never block app startup.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { readdirSync, lstatSync, readlinkSync, symlinkSync, rmdirSync, mkdirSync, existsSync } from 'node:fs'
import { logError, logInfo } from './logger'

/** Resolve + lowercase + strip trailing slash, for case-insensitive path compares. */
function norm(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()
}

/** A reparse point's target, or null if `p` is a real directory (not a junction/symlink). */
function linkTarget(p: string): string | null {
  try { return readlinkSync(p) } catch { return null }
}

export function ensureSkillLinks(monorepoRoot: string): void {
  if (process.platform !== 'win32') return // junctions are a Windows mechanism
  try {
    const globalSkills = path.join(homedir(), '.claude', 'skills')
    mkdirSync(globalSkills, { recursive: true })

    // Source root: the repo's own `skills/` container — each subdir is a skill, linked by its own
    // name. `bases` records the source area so prune can recognize OUR junctions.
    const bases: string[] = []

    // Container — <root>/skills/* : each subdir is a skill, linked by its own name.
    const skillsSrc = path.join(monorepoRoot, 'skills')
    bases.push(skillsSrc)
    if (existsSync(skillsSrc)) {
      for (const entry of readdirSync(skillsSrc, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        ensureOne(path.join(globalSkills, entry.name), path.join(skillsSrc, entry.name), entry.name)
      }
    }

    pruneDeadRepoLinks(globalSkills, bases)
  } catch (err) {
    logError('skill-links', `ensure failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }
}

function ensureOne(link: string, target: string, name: string): void {
  let exists = true
  try { lstatSync(link) } catch { exists = false }

  if (!exists) { create(link, target, name, 'linked'); return }

  const cur = linkTarget(link)
  if (cur === null) {
    // a real directory, not a reparse point — never clobber a user's own skill
    logError('skill-links', `~/.claude/skills/${name} is a real directory, not a junction — leaving it untouched`)
    return
  }
  if (norm(cur) === norm(target)) return // already correct

  // stale/dangling junction (e.g. → a legacy v1 app) — repoint to the current target
  try { rmdirSync(link) }
  catch (e) { logError('skill-links', `repoint ${name}: removing stale junction failed: ${e instanceof Error ? e.message : String(e)}`); return }
  create(link, target, name, 'repointed')
}

function create(link: string, target: string, name: string, verb: string): void {
  try {
    symlinkSync(target, link, 'junction') // junctions need no elevation, unlike symlinks
    logInfo('skill-links', `${verb} ~/.claude/skills/${name} -> ${target}`)
  } catch (e) {
    logError('skill-links', `link ${name} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Remove junctions under `~/.claude/skills` that point into OUR source base (the repo's `skills/`
 *  container) but whose source is gone — a renamed/absorbed skill (e.g. the old `jamat`).
 *  A junction is "ours" if its target IS the base or sits UNDER it (a container child). Never touches
 *  links into other locations. */
function pruneDeadRepoLinks(globalSkills: string, bases: string[]): void {
  const normBases = bases.map((b) => norm(b))
  let entries: string[]
  try { entries = readdirSync(globalSkills) } catch { return }
  for (const name of entries) {
    const link = path.join(globalSkills, name)
    const cur = linkTarget(link)
    if (cur === null) continue                 // real dir or not a link
    const nc = norm(cur)
    const ours = normBases.some((b) => nc === b || nc.startsWith(b + path.sep))
    if (!ours) continue                        // not one of ours
    if (existsSync(cur)) continue              // source still there → keep
    try { rmdirSync(link); logInfo('skill-links', `pruned dead junction ~/.claude/skills/${name} (source gone)`) }
    catch { /* ignore */ }
  }
}
