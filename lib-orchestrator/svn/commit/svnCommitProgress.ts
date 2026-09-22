import type { CommitProgress } from '../../shared/commitProgress.types'

export class SvnCommitProgress {
  private static readonly transferPrefixConst = 'Transmitting file data '
  private readonly total: number
  private readonly report: (progress: CommitProgress) => void
  private pending = ''
  private sent = 0
  private transmitted = 0
  private transferring = false

  constructor(total: number, report: (progress: CommitProgress) => void) {
    this.total = total
    this.report = report
  }

  accept(chunk: string): void {
    this.pending += chunk
    while (this.pending.length > 0) {
      if (this.pending.startsWith(SvnCommitProgress.transferPrefixConst)) {
        this.pending = this.pending.slice(SvnCommitProgress.transferPrefixConst.length)
        this.transferring = true
        this.report({ stage: 'transmitting', completed: 0, total: null })
      }
      if (this.transferring) {
        const dots = /^\.+/.exec(this.pending)?.[0].length ?? 0
        if (dots > 0) {
          this.transmitted += dots
          this.pending = this.pending.slice(dots)
          this.report({ stage: 'transmitting', completed: this.transmitted, total: null })
        }
      }
      // SVN flushes dots and the finalization message without a trailing newline.
      if (this.pending.startsWith('Committing transaction') || (this.transferring && this.pending.startsWith('done'))) {
        this.transferring = false
        this.report({ stage: 'committing', completed: 0, total: null })
      }
      const newline = this.pending.indexOf('\n')
      if (newline === -1) break
      const line = this.pending.slice(0, newline).trim()
      this.pending = this.pending.slice(newline + 1)
      if (/^(Sending|Adding|Deleting|Replacing)\s+/.test(line))
        this.report({ stage: 'sending', completed: Math.min(++this.sent, this.total), total: this.total })
      else if (/^Committed revision \d+\./.test(line))
        this.report({ stage: 'verifying', completed: 0, total: null })
    }
    // A malformed or unexpected line must not keep growing with the command's output.
    if (this.pending.length > 65_536) this.pending = ''
  }
}
