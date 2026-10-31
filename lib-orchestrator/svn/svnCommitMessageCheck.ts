export type CommitMessageSource = 'agent-proposal' | 'person-local' | 'person-remote' | 'restored-draft' | 'kept-attempt' | 'unknown'

export type CommitMessageFinding = 'empty' | 'no-prefix' | 'long-first-line' | 'chat-opening' | 'markdown' | 'reused-after-keep'
/** `confirm`: the person must tick that they checked it, because they did not write the message. */
export interface CommitMessageFindingInfo { id: CommitMessageFinding; text: string; confirm?: true }

export class SvnCommitMessageCheck {
  /**
   * How an assistant's reply starts rather than a commit: a heading of the answer, a "here is the
   * message" line, or an assent. Each needs that exact shape, so an ordinary subject line that only
   * mentions a commit message, or starts with "Here", does not match (UA1-J12-2).
   */
  private static readonly chatOpeningsConst: readonly RegExp[] = [
    /^(?:Shrnutí|Souhrn|Summary|Detaily|Details):/i,
    /^(?:here(?:'s|’s| is| are)|zde je|tady je)\b.*\bcommit/i,
    /^(?:sure|certainly|of course|okay|alright|absolutely)[,!.]/i,
    /^(?:(?:suggested|proposed)\s+)?commit message\s*:/i,
  ]

  /** Nothing beyond an optional `[Project]` prefix: the field a person cleared, or left at its prefilled prefix. */
  static empty(message: string): boolean {
    return !message.trim().replace(/^\[[^\]\s]+\](?:\s|$)/, '').trim()
  }

  /** A field a person wrote holds their message; an emptied one holds nobody's, so a proposal may fill it. */
  static personMessage(message: string, source: CommitMessageSource): boolean {
    return SvnCommitMessageCheck.writtenByPerson(source) && !SvnCommitMessageCheck.empty(message)
  }

  static findings(message: string, source: CommitMessageSource): CommitMessageFinding[] {
    if (SvnCommitMessageCheck.empty(message)) return ['empty']
    const first = message.split(/\r?\n/, 1)[0]
    const findings: CommitMessageFinding[] = []
    if (!/^\[[^\]\s]+\] /.test(first)) findings.push('no-prefix')
    if (first.length > 100) findings.push('long-first-line')
    const opening = first.replace(/^\[[^\]\s]+\]\s*/, '')
    if (SvnCommitMessageCheck.chatOpeningsConst.some((pattern) => pattern.test(opening))) findings.push('chat-opening')
    if (/\*\*|__|^\s*(?:[-*+] |\d+[.)] )/.test(first)) findings.push('markdown')
    if (source === 'kept-attempt') findings.push('reused-after-keep')
    return findings
  }

  static info(message: string, source: CommitMessageSource): CommitMessageFindingInfo[] {
    const confirm = !SvnCommitMessageCheck.writtenByPerson(source)
    return SvnCommitMessageCheck.findings(message, source).map((id) => ({ id, text: SvnCommitMessageCheck.wordOf(id), ...confirm && id !== 'empty' ? { confirm: true as const } : {} }))
  }

  /** The findings that still stop a commit: an empty message, and a finding nobody confirmed in a message the person did not write. */
  static blocking(message: string, source: CommitMessageSource, acknowledged: readonly CommitMessageFinding[]): CommitMessageFinding[] {
    const confirm = !SvnCommitMessageCheck.writtenByPerson(source)
    return SvnCommitMessageCheck.findings(message, source).filter((finding) => finding === 'empty' || confirm && !acknowledged.includes(finding))
  }

  /** A repository's prefix is known, so a message without one gets it instead of a finding. */
  static withPrefix(message: string, prefix: string): string {
    if (!message.trim()) return message
    if (/^\[[^\]\s]+\](?:\s|$)/.test(message.trimStart())) return message.trimStart()
    return `${prefix} ${message.trimStart()}`
  }

  /** Whether the message publishes under `prefix`: one without a prefix gets it, one with another keeps that one. */
  static prefixed(message: string, prefix: string): boolean {
    return SvnCommitMessageCheck.withPrefix(message, prefix).startsWith(prefix)
  }

  static writtenByPerson(source: CommitMessageSource): boolean {
    switch (source) {
      case 'person-local': case 'person-remote': return true
      case 'agent-proposal': case 'restored-draft': case 'kept-attempt': case 'unknown': return false
      default: throw new Error(`Unknown commit message source: ${JSON.stringify(source satisfies never)}`)
    }
  }

  static wordOf(finding: CommitMessageFinding): string {
    switch (finding) {
      case 'empty': return 'Enter a commit message'
      case 'no-prefix': return 'No [Project] prefix'
      case 'long-first-line': return 'First line exceeds 100 characters'
      case 'chat-opening': return 'Chat opening'
      case 'markdown': return 'Markdown in first line'
      case 'reused-after-keep': return 'Message reused after Keep'
      default: throw new Error(`Unknown commit message finding: ${JSON.stringify(finding satisfies never)}`)
    }
  }
}
