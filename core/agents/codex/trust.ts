/**
 * Pre-seed `~/.codex/config.toml` so a freshly launched Codex session in a given project
 * directory does NOT block on the interactive gate:
 *   "You are in <dir> — Do you trust the contents of this directory?"
 *
 * This is the Codex analog of `claude/trust.ts` (`ensureClaudeProjectTrust`). It is called
 * right before spawn from the Codex adapter's `buildLaunchCommand`, so the launched `codex`
 * reads an already-trusted project and starts directly. The `--dangerously-bypass-approvals-
 * and-sandbox` flag only sets the approval/sandbox policy — it does NOT suppress this separate
 * per-directory trust gate, which decides whether project-local config / hooks load.
 *
 * Codex records trust as a per-project table in config.toml (verified vs codex-cli 0.144.1):
 *   [projects.'<path>']
 *   trust_level = "trusted"
 * The key is the launch cwd — on Windows lowercased with backslashes, in a single-quoted TOML
 * literal (backslashes are literal, not escapes). We reproduce that exact form.
 *
 * Design notes:
 *  - APPEND-ONLY. We never parse and re-serialize the TOML: the file holds the user's MCP
 *    servers, plugins, marketplaces, and notify hooks — a round-trip without a real TOML
 *    library risks corrupting them. We scan for an existing `[projects.<path>]` header
 *    (normalized both ways) and append a fresh block only when the project is truly absent, so
 *    we never create a duplicate table (which would make the whole config unparseable).
 *  - Existence-gated: we only seed a directory that actually exists on disk. A real launch
 *    always has an existing cwd; this keeps bogus/test paths out of the user's config.
 *  - Atomic (tmp + rename) and defensive: a seeding failure is a no-op, never a throw —
 *    seeding must never block or break a launch.
 *
 * core/ rule compliance: no UI/framework deps, takes the config path as a parameter.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs'

/** Normalize a directory for case-insensitive, separator-insensitive comparison. */
function normForCompare(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The key form Codex writes: on Windows, backslashes + lowercased; elsewhere left as-is. */
function trustKey(projectDir: string, isWindows: boolean): string {
  const noTrailing = projectDir.replace(/[\\/]+$/, '')
  return isWindows ? noTrailing.replace(/\//g, '\\').toLowerCase() : noTrailing
}

/**
 * Ensure `~/.codex/config.toml` (at `codexConfigPath`) trusts `projectDir`, so a launched
 * Codex session starts without the interactive trust prompt. Returns whether the file was
 * changed. Never throws.
 */
export function ensureCodexProjectTrust(
  projectDir: string,
  codexConfigPath: string,
  isWindows: boolean = process.platform === 'win32',
): { changed: boolean } {
  if (!projectDir) return { changed: false }
  // Never seed trust for a path that isn't a real directory (keeps test/bogus dirs out of config).
  try {
    if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) return { changed: false }
  } catch {
    return { changed: false }
  }

  let text: string
  try {
    text = readFileSync(codexConfigPath, 'utf8')
  } catch {
    // No config yet (or unreadable) — Codex creates it on first run; a fresh file holding only
    // our block is valid TOML, so start from empty rather than bailing.
    text = ''
  }

  // Already trusted? Compare every `[projects.<quote><path><quote>]` header path, normalized.
  const canonical = normForCompare(projectDir)
  const headerRe = /^[ \t]*\[projects\.[ \t]*(['"])(.*?)\1[ \t]*\][ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text)) !== null) {
    if (normForCompare(m[2]) === canonical) return { changed: false }
  }

  // Append a fresh trust block at EOF (a new table can never disturb the sections above it).
  let next = text
  if (next.length > 0 && !next.endsWith('\n')) next += '\n'
  if (next.length > 0) next += '\n'
  next += `[projects.'${trustKey(projectDir, isWindows)}']\ntrust_level = "trusted"\n`

  const tmp = `${codexConfigPath}.tmp-${process.pid}`
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, codexConfigPath)
  return { changed: true }
}
