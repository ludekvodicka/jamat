import { stat } from 'node:fs/promises'

import type {
  GitCommandFailure,
  GitCommandOutcome,
  GitCommandRunner,
  GitErrorCode,
} from './git.types'

/**
 * What every git member of this library shares: a process to run commands with, and one reading of
 * what came back.
 *
 * The reading is the part worth having in one place. Git says what went wrong in prose on stderr,
 * so turning that into a code is a table of its own words, and a second copy of that table is a
 * second opinion about what `is locked` means. Subclasses add the commands; none of them re-decides
 * what a failure is called.
 */
export abstract class GitManager {
  /** Git's own words. The order decides: a message matching two patterns takes the first of them. */
  private static readonly signaturesConst: readonly { pattern: RegExp; code: GitErrorCode }[] = [
    { pattern: /not a git repository|must be run in a work tree/i, code: 'not-a-repo' },
    { pattern: /is locked|cannot lock ref|index\.lock/i, code: 'locked' },
    {
      pattern: /already exists|already checked out|already used by worktree|already registered/i,
      code: 'worktree-exists',
    },
    {
      pattern: /unknown revision|bad revision|not a valid object name|bad object|ambiguous argument/i,
      code: 'missing-base',
    },
    {
      pattern: /contains modified or untracked files|is dirty|local changes.*would be overwritten/i,
      code: 'dirty',
    },
  ]

  constructor(protected readonly invoker: GitCommandRunner) {}

  /** Null when the command succeeded; otherwise the typed refusal, in git's own words. */
  protected static failureOf(
    outcome: GitCommandOutcome,
    fallback: GitErrorCode,
  ): { ok: false; code: GitErrorCode; detail: string } | null {
    if (outcome.failure)
      return {
        ok: false,
        code: GitManager.codeOfFailure(outcome.failure),
        detail: GitManager.detailOf(outcome),
      }
    if (outcome.code === 0) return null
    const text = `${outcome.stderr}\n${outcome.stdout}`
    const signature = GitManager.signaturesConst.find((entry) => entry.pattern.test(text))
    return {
      ok: false,
      code: signature?.code ?? fallback,
      detail: GitManager.detailOf(outcome),
    }
  }

  private static codeOfFailure(failure: GitCommandFailure): GitErrorCode {
    if (failure === 'git-missing') return 'git-missing'
    else if (failure === 'cwd-missing') return 'git-failed'
    else if (failure === 'spawn-failed') return 'git-failed'
    else if (failure === 'timeout') return 'git-failed'
    else if (failure === 'output-limit') return 'git-failed'
    else throw new Error(`Unknown git command failure: ${JSON.stringify(failure)}`)
  }

  protected static detailOf(outcome: GitCommandOutcome): string {
    const message = outcome.stderr.trim() || outcome.stdout.trim()
    if (outcome.failure)
      return message
        ? `git could not run (${outcome.failure}): ${message}`
        : `git could not run (${outcome.failure})`
    return message || `git exited with ${outcome.code}`
  }

  protected static async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch { return false }
  }
}
