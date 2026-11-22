import type { ProviderTranscriptView } from '../projectManager/providerTranscriptView'
import { CodexAppServerClient } from '../rateMonitor/codexAppServerView'
import type { AgentHistoryEraser } from './purge/agentHistoryEraser.types'
import { AntigravityHistoryEraser } from './purge/antigravityHistoryEraser'
import { ClaudeHistoryEraser } from './purge/claudeHistoryEraser'
import { CodexHistoryEraser } from './purge/codexHistoryEraser'
import type { SessionAgentId } from './sessionManagerApi.types'

/** The agent erasers a composer hands `SessionManagerDeps.erase`, built from where each agent keeps its state. */
export class SessionEraseView {
  static agents(options: {
    /** The main Claude config home and every account profile's. */
    claudeHomes: () => readonly string[]
    /** The main Codex home; profiles share its sessions and databases. */
    codexHome: string
    /** The Antigravity CLI home; defaults to `~/.gemini/antigravity-cli`. */
    antigravityHome?: string
    /** Claude Code's temporary root: `CLAUDE_CODE_TMPDIR`, else the system one. */
    temporaryRoot: string
    transcripts: Pick<ProviderTranscriptView, 'subagentFiles'>
  }): Partial<Record<SessionAgentId, AgentHistoryEraser>> {
    return {
      claude: new ClaudeHistoryEraser({ homes: options.claudeHomes, temporaryRoot: options.temporaryRoot }),
      codex: new CodexHistoryEraser({
        home: options.codexHome,
        childrenOf: async (threadId, since) => (await options.transcripts.subagentFiles({
          agentId: 'codex', cwd: '', nativeSessionId: threadId, since,
        })).map((ref) => ref.subagentId),
        // The Codex of this process's environment, which is the main home: deleting a thread is
        // not tied to the account that ran it, because profiles share the rollouts and databases.
        client: () => new CodexAppServerClient({ onNotification: () => undefined }),
      }),
      antigravity: new AntigravityHistoryEraser({ home: options.antigravityHome }),
    }
  }
}
