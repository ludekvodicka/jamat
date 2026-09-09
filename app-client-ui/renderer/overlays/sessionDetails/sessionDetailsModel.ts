import { SessionFolder } from '../../sessions/sessionFolder'
import type {
  SessionAgentId,
  SessionColorName,
  SessionDetailsUpdate,
  SessionInfo,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/** What the command hands the shell: which session, and a serial so a repeat is a fresh card. */
export interface SessionDetailsOpenRequest {
  requestId: number
  sessionId: string
}

/** The three editable fields, exactly as the controls hold them. */
export interface SessionDetailsDraft {
  name: string
  note: string
  color: SessionColorName | null
}

/**
 * The session as the card captured it when it opened. Captured once, not subscribed: a snapshot
 * arriving under the form must not move the fields being edited, and Save re-validates in the
 * library anyway.
 */
export interface SessionDetailsBaseline {
  sessionId: string
  /** `titleParts.number`, drawn as the fixed chip; the dialog never edits or re-derives it. */
  numberChip: string | null
  name: string
  note: string
  color: SessionColorName | null
  agentId: SessionAgentId | null
  life: SessionInfo['life']
  /** What the read-only block shows: the agent's own id where one exists, the record's otherwise. */
  displaySessionId: string
  projectLabel: string
  /** Null where the directory is the Host's default and has no path to show. */
  folderPath: string | null
  agentLabel: string
}

/** The card's decisions, kept out of the component so each one is a call a test can make. */
export class SessionDetailsModel {
  /** Renderer-side, like SessionModelCompact's `/compact`: typing a slash command is keystrokes. */

  static baselineOf(info: SessionInfo): SessionDetailsBaseline {
    return {
      sessionId: info.sessionId,
      numberChip: info.titleParts.number,
      name: info.titleParts.name,
      note: info.note ?? '',
      color: info.color ?? null,
      agentId: info.agent?.agentId ?? null,
      life: info.life,
      displaySessionId: info.agent?.nativeSessionId ?? info.sessionId,
      projectLabel: SessionDetailsModel.projectLabelOf(info.project),
      folderPath: SessionFolder.ofSession(info),
      agentLabel: SessionDetailsModel.agentLabelOf(info.agent?.agentId ?? null),
    }
  }

  /**
   * Null = nothing changed against the baseline, and the dialog just closes (V1 behaviour).
   * Only the fields that moved travel: a save is a diff, so a colour the submenu wrote while the
   * card was open survives a name-only Save instead of being reverted to the baseline.
   */
  static updateOf(
    baseline: SessionDetailsBaseline,
    draft: SessionDetailsDraft,
  ): SessionDetailsUpdate | null {
    const name = draft.name.trim()
    const note = draft.note.trim()
    const update: SessionDetailsUpdate = {}
    if (name !== baseline.name) update.name = name
    if (note !== baseline.note) update.note = note === '' ? null : note
    if (draft.color !== baseline.color) update.color = draft.color
    return Object.keys(update).length === 0 ? null : update
  }

  private static projectLabelOf(project: SessionInfo['project']): string {
    if (project.kind === 'project') return project.projectName
    else if (project.kind === 'adHoc') return project.path
    else if (project.kind === 'none') return 'None'
    else
      throw new Error(`Unknown project binding: ${JSON.stringify(project)}`)
  }

  private static agentLabelOf(agentId: SessionAgentId | null): string {
    if (agentId === 'claude') return 'Claude'
    else if (agentId === 'codex') return 'Codex'
    else if (agentId === null) return 'Shell'
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
