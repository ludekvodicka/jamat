import type { SvnErrorCode } from '../../svn/svn.types'
import type { SessionsOpErrorCode } from '../sessionManagerApi.types'

/** The svn subsystem's vocabulary as the sessions subsystem's, the twin of `GitCodes`. */
export class SvnCodes {
  static sessionCodeOf(code: SvnErrorCode): SessionsOpErrorCode {
    if (code === 'refused') return 'invalid-spec'
    else if (code === 'locked') return 'locked'
    else if (code === 'svn-missing') return 'svn-failed'
    else if (code === 'not-a-working-copy') return 'svn-failed'
    else if (code === 'out-of-date') return 'svn-failed'
    else if (code === 'external-target') return 'svn-failed'
    else if (code === 'svn-failed') return 'svn-failed'
    else if (code === 'io-failed') return 'svn-failed'
    else throw new Error(`Unknown svn failure: ${JSON.stringify(code)}`)
  }
}
