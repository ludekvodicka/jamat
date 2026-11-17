import type { FileChangesManager } from '../../../lib-orchestrator/fileChangesManager/fileChangesManager'
import type { RemoteControlTerminal } from '../../../lib-orchestrator/remoteControl/remoteControlTerminal'
import { RemoteControlDeliverConst } from '../../../lib-orchestrator/remoteControl/remoteControlProtocol'
import type { MainFinishChanges, MainFinishPort } from '../../../lib-orchestrator/sessionManager/mainFinishPort.types'
import type { SessionManager } from '../../../lib-orchestrator/sessionManager/sessionManager'
import type { VersioningCommitManager } from '../versioning/versioningCommitManager'
import type { SessionTranscriptAccess } from '../sessionTranscript/sessionTranscriptAccess'

/**
 * The Finish of a main-copy session reads its changes, types its command and asks about reviews
 * through the owners this process composes. SVN is asked first, as the main-copy commit reads do,
 * so a project with a human Git mirror beside its SVN working copy commits to SVN.
 */
export class MainFinishPortAdapter implements MainFinishPort {
  private readonly sessions: Pick<SessionManager, 'workingContext'>
  private readonly fileChanges: Pick<FileChangesManager, 'sessionChanges'>
  private readonly terminal: Pick<RemoteControlTerminal, 'deliver'>
  private readonly transcripts: Pick<SessionTranscriptAccess, 'read'>
  private readonly commits: Pick<VersioningCommitManager, 'discovery'>
  private readonly commandOf: (vcs: 'svn' | 'git') => string

  constructor(deps: {
    sessions: Pick<SessionManager, 'workingContext'>
    fileChanges: Pick<FileChangesManager, 'sessionChanges'>
    terminal: Pick<RemoteControlTerminal, 'deliver'>
    transcripts: Pick<SessionTranscriptAccess, 'read'>
    commits: Pick<VersioningCommitManager, 'discovery'>
    commandOf: (vcs: 'svn' | 'git') => string
  }) {
    this.sessions = deps.sessions
    this.fileChanges = deps.fileChanges
    this.terminal = deps.terminal
    this.transcripts = deps.transcripts
    this.commits = deps.commits
    this.commandOf = deps.commandOf
  }

  async changes(sessionId: string): Promise<MainFinishChanges> {
    const context = await this.sessions.workingContext(sessionId)
    if (!context.ok) return { ok: false, detail: context.detail }
    const { cwd, agent } = context.value
    const read = await this.fileChanges.sessionChanges({ sessionId, cwd, agent }, 'svn')
    return read.ok ? { ok: true, vcs: read.value.vcs, paths: read.value.paths } : read
  }

  command(vcs: 'svn' | 'git'): string {
    return this.commandOf(vcs)
  }

  async deliver(sessionId: string, text: string, input: 'typed' | 'paste'): Promise<string | null> {
    const result = await this.terminal.deliver(sessionId, text, {
      input,
      readyTimeoutMs: RemoteControlDeliverConst.readyTimeoutMillisecondsConst,
      submitTimeoutMs: RemoteControlDeliverConst.submitTimeoutMillisecondsConst,
    }, { transcript: () => this.transcripts.read(sessionId) })
    return result.ok ? null : result.error.detail
  }

  reviewPending(sessionId: string): boolean {
    return this.commits.discovery().pending.includes(sessionId)
  }
}
