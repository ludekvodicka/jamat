import type { CommitMessageSource } from '../../../lib-orchestrator/svn/svnCommitMessageCheck'
import { JsonDocumentStore, type JsonDocumentReading } from '../../../lib-orchestrator/shared/jsonDocumentStore'
import { JsonShape } from '../../../lib-orchestrator/shared/jsonShape'
import { PathCompare } from '../../../lib-orchestrator/shared/pathCompare'
import { VersioningCommitLimits, VersioningCommitPaths, type VersioningCommitDraftDto } from '../../shared/versioningCommit'

type CommitScope = Pick<VersioningCommitDraftDto, 'sessionId' | 'vcs' | 'scopeRoot' | 'paths'>
type CommitMessage = Pick<VersioningCommitDraftDto, 'message' | 'editedByPerson' | 'proposedByAgent'> & { source: CommitMessageSource; at: number }
type DraftMessage = Pick<VersioningCommitDraftDto, 'message' | 'editedByPerson' | 'proposedByAgent' | 'messageSource' | 'messageAt'>
interface MessageDocument {
  version: 1
  messages: Record<string, CommitMessage>
}

export class VersioningCommitMessageStore extends JsonDocumentStore<MessageDocument> {
  private document: MessageDocument

  constructor(file: string, report: (message: string) => void) {
    super(file, report)
    this.document = this.readDocumentSync()
  }

  read(scope: CommitScope): DraftMessage | undefined {
    const message = this.document.messages[VersioningCommitMessageStore.key(scope)]
    return message === undefined ? undefined : { message: message.message, editedByPerson: message.editedByPerson,
      proposedByAgent: message.proposedByAgent, messageSource: message.source, messageAt: message.at }
  }

  save(draft: CommitScope & DraftMessage): boolean {
    const key = VersioningCommitMessageStore.key(draft)
    const message = { message: draft.message, editedByPerson: draft.editedByPerson, proposedByAgent: draft.proposedByAgent, source: draft.messageSource ?? 'unknown', at: draft.messageAt ?? Date.now() }
    if (JSON.stringify(this.document.messages[key]) === JSON.stringify(message)) return true
    return this.saveDocument({ version: 1, messages: { ...this.document.messages, [key]: message } })
  }

  remove(scope: CommitScope): boolean {
    const key = VersioningCommitMessageStore.key(scope)
    if (!Object.hasOwn(this.document.messages, key)) return true
    const messages = { ...this.document.messages }
    delete messages[key]
    return this.saveDocument({ version: 1, messages })
  }

  protected get subject(): string { return 'Commit messages' }
  protected get refusalConsequence(): string { return 'commit messages cannot be saved until the file is repaired' }
  protected get readFailureConsequence(): string { return 'saved commit messages could not be restored' }
  protected emptyDocument(): MessageDocument { return { version: 1, messages: {} } }
  protected writeFailureMessage(detail: string): string { return `Commit messages could not be saved: ${detail}` }

  protected coerce(parsed: unknown): JsonDocumentReading<MessageDocument> {
    if (!JsonShape.isRecord(parsed) || parsed.version !== 1 || !JsonShape.isRecord(parsed.messages))
      throw new Error('Unsupported commit message document')
    const messages: Record<string, CommitMessage> = {}
    for (const [key, value] of Object.entries(parsed.messages)) {
      if (!JsonShape.isRecord(value) || typeof value.message !== 'string'
        || value.message.length > VersioningCommitLimits.messageMaxCharactersConst
        || typeof value.editedByPerson !== 'boolean' || typeof value.proposedByAgent !== 'boolean')
        throw new Error('Invalid saved commit message')
      messages[key] = { message: value.message, editedByPerson: value.editedByPerson, proposedByAgent: value.proposedByAgent,
        source: ['agent-proposal', 'person-local', 'person-remote', 'restored-draft', 'kept-attempt', 'unknown'].includes(String(value.source))
          ? value.source as CommitMessageSource : 'unknown', at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0 }
    }
    return { document: { version: 1, messages }, damaged: false }
  }

  private saveDocument(document: MessageDocument): boolean {
    if (!this.writeDocumentSync(document)) return false
    this.document = document
    return true
  }

  private static key(scope: CommitScope): string {
    return JSON.stringify([scope.sessionId, scope.vcs, PathCompare.comparable(scope.scopeRoot),
      // A node-only directory keys apart from the same directory with its subtree; files keep their old key.
      scope.paths === undefined ? null : [...new Set(scope.paths.map((path) => `${PathCompare.comparable(VersioningCommitPaths.pathOf(path))}${
        VersioningCommitPaths.nodeOnly(path) ? '\u0000empty' : ''}`))].sort()])
  }
}
