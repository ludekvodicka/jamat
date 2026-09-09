import type { SessionAgentId, SessionInfo } from './sessionManagerApi.types'
import type { RuntimeChannel } from '../shared/configIdentity.types'
import { SessionWorkingDirectory } from './sessionWorkingDirectory'

export type SessionReferenceRoute =
  | {
      kind: 'local'
      controllerConfigIdentity: string
      controllerChannel: RuntimeChannel
    }
  | {
      kind: 'remote'
      controllerConfigIdentity: string
      controllerChannel: RuntimeChannel
      remoteEndpointId: string
      targetConfigIdentity: string
      targetChannel: RuntimeChannel
    }

/**
 * One session named so that a SECOND agent knows which conversation is meant: the machine, the agent
 * and that agent's own conversation id, where the session runs, and the file the conversation is
 * written to.
 *
 * It is composed here rather than by whoever draws the menu, for the same reason every other answer
 * about a session is: a surface that wrote its own would be a second version of it, drifting from
 * this one the day a field is added. The local menu and the paired computer's row both read this.
 *
 * `transcriptFile` is handed in rather than derived. Finding it costs a disk read, and a session on
 * another computer has one this machine cannot reach at all - which is why that arm passes null.
 */
export interface SessionReferenceFacts {
  computer: string
  route: SessionReferenceRoute
  sessionId: string
  title: string
  /** Null for a shell: a plain terminal has no conversation to name. */
  agent: { agentId: SessionAgentId; nativeSessionId: string | null } | null
  /** Where it RUNS, so a worktree session names the worktree. Null for the default directory. */
  workingDirectory: string | null
  /** The repository a worktree session came from; null for every session that has no worktree. */
  repository: string | null
  branch: string | null
  transcriptFile: string | null
}

export class SessionReference {
  private static readonly headerConst = 'AppJamatV3 session'

  /**
   * Everything a SNAPSHOT can answer. One mapper for both paths, so the local block and the block
   * for a paired computer's session cannot disagree about what a session's directory is.
   */
  static factsOf(
    info: SessionInfo,
    computer: string,
    transcriptFile: string | null,
    route: SessionReferenceRoute,
  ): SessionReferenceFacts {
    const bound = SessionReference.boundDirectoryOf(info.directory)
    return {
      computer,
      route,
      sessionId: info.sessionId,
      title: info.title,
      agent: info.agent === undefined
        ? null
        : { agentId: info.agent.agentId, nativeSessionId: info.agent.nativeSessionId ?? null },
      // The bound directory of a worktree session names the repository it came from, never where it
      // runs - so the two fields below are that one path read for its two different meanings.
      workingDirectory: SessionWorkingDirectory.of(info),
      repository: info.worktree === undefined ? null : bound,
      branch: info.worktree?.branch ?? null,
      transcriptFile,
    }
  }

  /** A field with nothing to say draws no line: a placeholder is one more thing to read past. */
  static text(facts: SessionReferenceFacts): string {
    const lines: string[] = [
      SessionReference.headerConst,
      'reference version: 2',
      `computer: ${SessionReference.quoted(facts.computer)}`,
    ]
    if (facts.route.kind === 'local')
      lines.push(
        'route: local',
        `controller config identity: ${SessionReference.quoted(facts.route.controllerConfigIdentity)}`,
        `controller channel: ${facts.route.controllerChannel}`,
      )
    else if (facts.route.kind === 'remote')
      lines.push(
        'route: remote',
        `controller config identity: ${SessionReference.quoted(facts.route.controllerConfigIdentity)}`,
        `controller channel: ${facts.route.controllerChannel}`,
        `remote endpoint id: ${SessionReference.quoted(facts.route.remoteEndpointId)}`,
        `target config identity: ${SessionReference.quoted(facts.route.targetConfigIdentity)}`,
        `target channel: ${facts.route.targetChannel}`,
      )
    else throw new Error(`Unknown session reference route: ${JSON.stringify(facts.route)}`)
    lines.push(`session: ${SessionReference.quoted(facts.title)}`)
    if (facts.agent === null) lines.push('agent: none (plain terminal)')
    else {
      lines.push(`agent: ${facts.agent.agentId}`)
      if (facts.agent.nativeSessionId !== null)
        lines.push(`agent session id: ${SessionReference.quoted(facts.agent.nativeSessionId)}`)
    }
    if (facts.workingDirectory !== null)
      lines.push(`working directory: ${SessionReference.quoted(facts.workingDirectory)}`)
    if (facts.repository !== null)
      lines.push(`repository: ${SessionReference.quoted(facts.repository)}`)
    if (facts.branch !== null) lines.push(`branch: ${SessionReference.quoted(facts.branch)}`)
    if (facts.transcriptFile !== null)
      lines.push(`transcript: ${SessionReference.quoted(facts.transcriptFile)}`)
    lines.push(`jamat session id: ${SessionReference.quoted(facts.sessionId)}`)
    return lines.join('\n')
  }

  private static quoted(value: string): string {
    return JSON.stringify(value)
  }

  /**
   * The directory a snapshot names. Null for the default arm on purpose, the same disagreement with
   * `LaunchPlanner.directoryOf` that `SessionFolder.ofDirectory` already makes: that one resolves a
   * home directory to spawn a child in, this one says what path to WRITE DOWN, and the machine that
   * would resolve it may not be this one.
   */
  private static boundDirectoryOf(directory: SessionInfo['directory']): string | null {
    if (directory.mode === 'project') return directory.projectPath
    else if (directory.mode === 'adHoc') return directory.path
    else if (directory.mode === 'default') return null
    else throw new Error(`Unknown session directory: ${JSON.stringify(directory)}`)
  }
}
