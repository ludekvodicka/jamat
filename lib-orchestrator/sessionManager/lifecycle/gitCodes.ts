import type { GitErrorCode } from '../../git/git.types'
import type { SessionsOpErrorCode } from '../sessionManagerApi.types'

/**
 * The git subsystem's vocabulary as the sessions subsystem's.
 *
 * The two lists overlap almost completely, which is exactly why this is written down once: a second
 * copy would be a second opinion about whether `locked` is a `locked` out here, and the two would
 * only be found to disagree by somebody reading a refusal that made no sense.
 */
export class GitCodes {
  static sessionCodeOf(code: GitErrorCode): SessionsOpErrorCode {
    if (code === 'git-missing') return 'git-missing'
    else if (code === 'not-a-repo') return 'not-a-repo'
    else if (code === 'dirty') return 'dirty'
    else if (code === 'locked') return 'locked'
    else if (code === 'missing-base') return 'missing-base'
    else if (code === 'worktree-exists') return 'worktree-exists'
    else if (code === 'git-failed') return 'git-failed'
    else throw new Error(`Unknown git failure: ${JSON.stringify(code)}`)
  }
}
