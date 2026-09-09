import type {
  SessionAgentId,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'

/**
 * The one-letter mark an agent gets on screen, in the one place that decides it.
 *
 * Two surfaces stamp it - the launcher's create and history screens, and a row of the sessions tree
 * - and they held byte-identical copies, with a comment on the launcher's saying "the sessions tree
 * uses this too, so a row reads the same in both places". It did not; the tree had its own. The
 * comment is what stopped anybody checking, which is why the mark now lives beside the other
 * session-domain helpers of this renderer rather than inside either surface.
 */
export class AgentGlyph {
  static markOf(agentId: SessionAgentId): string {
    if (agentId === 'claude') return 'C'
    else if (agentId === 'codex') return 'X'
    else
      throw new Error(`Unknown agent: ${JSON.stringify(agentId)}`)
  }
}
