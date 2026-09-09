import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ErrorText } from '../../shared/errorText'

export interface ClaudeTrustSeedResult {
  changed: boolean
  /** Null on success AND on every quiet no-op; a sentence only when a write was tried and failed. */
  problem: string | null
}

/**
 * Answering the workspace-trust dialog before Claude asks it, for a session launched in yolo mode.
 *
 * Codex takes its directory trust as a process argument, so `LaunchPlanner` builds it; Claude has no
 * flag for it at all. `claude --help` states the dialog is skipped only when the run is
 * non-interactive, and every session this client starts is interactive, so the only channel left is
 * the file Claude reads its own answer out of. That makes this a WRITE into a file this tree does
 * not own, which is why it lives here and not in the pure planner.
 *
 * **Never throws, and never creates the file.** A machine where Claude has never run has no
 * `~/.claude.json`, and writing one would be inventing state for a program that is about to write
 * its own; the launch simply meets the dialog, exactly as it does today.
 */
export class ClaudeTrustSeed {
  /**
   * The three answers the dialog stores, verified against Claude Code 2.1.233. They are one constant
   * because the dangerous-mode probe may find a fourth, and then this is the only line that moves.
   */
  private static readonly trustKeysConst = [
    'hasTrustDialogAccepted',
    'hasClaudeMdExternalIncludesApproved',
    'hasClaudeMdExternalIncludesWarningShown',
  ] as const

  /**
   * The child inherits everything but `JAMAT*`, so a `CLAUDE_CONFIG_DIR` in this process reaches the
   * launched Claude too. Seeding `~/.claude.json` while the agent reads another file would answer a
   * dialog nobody is going to be shown.
   */
  static defaultPath(environment: NodeJS.ProcessEnv = process.env): string {
    const configDir = environment.CLAUDE_CONFIG_DIR
    return join(configDir !== undefined && configDir !== '' ? configDir : homedir(), '.claude.json')
  }

  static seed(projectDir: string, claudeJsonPath: string): ClaudeTrustSeedResult {
    if (!projectDir) return { changed: false, problem: null }
    let document: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { changed: false, problem: null }
      document = parsed as Record<string, unknown>
    } catch {
      // Absent, half-written or hand-broken. Claude rewrites it on its next start either way, and
      // clobbering it here would destroy state this tree cannot reconstruct.
      return { changed: false, problem: null }
    }
    const projects = ClaudeTrustSeed.projectsOf(document)
    let changed = false
    for (const key of ClaudeTrustSeed.targetKeys(projects, projectDir)) {
      const entry = ClaudeTrustSeed.entryOf(projects, key)
      for (const flag of ClaudeTrustSeed.trustKeysConst)
        if (entry[flag] !== true) {
          entry[flag] = true
          changed = true
        }
    }
    // Idempotent on purpose: a launch of an already-trusted directory must not move the file's mtime,
    // because anything watching it would read a write that changed nothing as a change.
    if (!changed) return { changed: false, problem: null }
    try {
      ClaudeTrustSeed.write(claudeJsonPath, document)
    } catch (error) {
      return { changed: false, problem: ErrorText.of(error) }
    }
    return { changed: true, problem: null }
  }

  /**
   * The canonical key Claude writes - forward slashes, no trailing one - plus every key already in
   * the file that differs from it only in case or separators. Which of them Claude will actually
   * read is decided by its own normalisation, so all of them are answered.
   */
  private static targetKeys(projects: Record<string, unknown>, projectDir: string): Set<string> {
    const canonical = ClaudeTrustSeed.normalized(projectDir)
    const targets = new Set<string>([canonical])
    for (const key of Object.keys(projects))
      if (ClaudeTrustSeed.normalized(key).toLowerCase() === canonical.toLowerCase())
        targets.add(key)
    return targets
  }

  private static normalized(directory: string): string {
    return directory.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  private static projectsOf(document: Record<string, unknown>): Record<string, unknown> {
    const projects = document.projects
    if (projects && typeof projects === 'object' && !Array.isArray(projects))
      return projects as Record<string, unknown>
    const fresh: Record<string, unknown> = {}
    document.projects = fresh
    return fresh
  }

  private static entryOf(
    projects: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const entry = projects[key]
    if (entry && typeof entry === 'object' && !Array.isArray(entry))
      return entry as Record<string, unknown>
    const fresh: Record<string, unknown> = {}
    projects[key] = fresh
    return fresh
  }

  /**
   * NOT `AtomicJsonFile.write`, and the difference is the temporary name. That helper writes a fixed
   * `<file>.tmp`, which is right for the files this tree owns alone; `~/.claude.json` is written by
   * Claude itself and possibly by a second Jamat, and two writers sharing one temporary name can
   * rename each other's half-written file into place.
   */
  private static write(file: string, value: unknown): void {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8')
    renameSync(temporary, file)
  }
}
