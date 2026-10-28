import { homedir } from 'node:os'
import { join } from 'node:path'

import type { RuntimeChannel } from './configIdentity.types'

/**
 * Machine-local paths for the orchestrator library. `machineRoot()` is the same resolver the Host and
 * the client each carried a copy of; the `orchestrator/` scope beside their `host/` and `client-ui/`
 * keeps the three sets of files from ever naming the same path.
 */
export class OrchestratorPaths {
  private static readonly rootNameConst = 'jamat-v3'
  private static readonly scopeNameConst = 'orchestrator'
  private static readonly relocationJournalsNameConst = 'project-relocations'
  private static readonly relocationLeftoversFileNameConst = 'relocation-leftovers.json'
  private static readonly configSnapshotsNameConst = 'config-snapshots'
  private static readonly sessionRecordsFileNameConst = 'session-records.json'
  private static readonly sessionNumbersFileNameConst = 'session-numbers.json'
  private static readonly sessionSnapshotsNameConst = 'session-snapshots'
  private static readonly scriptLogsNameConst = 'script-logs'
  private static readonly worktreeResultsNameConst = 'worktree-results'
  private static readonly sessionNotifiesNameConst = 'session-notifies'
  private static readonly setupTrustFileNameConst = 'setup-trust.json'
  private static readonly codexRolloutCwdFileNameConst = 'codex-rollout-cwd.json'
  private static readonly rateMonitorCacheFileNameConst = 'rate-monitor-cache.json'
  private static readonly terminalOpenedPathsFileNameConst = 'terminal-opened-paths.json'
  private static readonly claudeStatusLineNameConst = 'claude-statusline'
  private static readonly claudeContextSnapshotsNameConst = 'claude-context'
  private static readonly claudeIdentitiesNameConst = 'claude-identity'
  private static readonly pastedFilesNameConst = 'pasted-files'

  // The override names the state ROOT, never one channel's directory: consuming it verbatim
  // collapses two channels into one state directory.
  static machineRoot(): string {
    const override = process.env.JAMAT_V3_LOCAL_STATE_DIR
    if (override) return override
    return OrchestratorPaths.defaultMachineRoot()
  }

  /** The fixed OS-local rendezvous root, deliberately independent of the state-root override. */
  static defaultMachineRoot(): string {
    if (process.platform === 'win32')
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
        OrchestratorPaths.rootNameConst,
      )
    else if (process.platform === 'darwin')
      return join(homedir(), 'Library', 'Application Support', OrchestratorPaths.rootNameConst)
    else if (process.platform === 'linux')
      return join(
        process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
        OrchestratorPaths.rootNameConst,
      )
    else
      throw new Error(`Unsupported platform: ${process.platform}`)
  }

  static directory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.machineRoot(),
      OrchestratorPaths.scopeNameConst,
      configIdentity,
      channel,
    )
  }

  static relocationJournalsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.relocationJournalsNameConst,
    )
  }

  static relocationLeftoversFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.relocationLeftoversFileNameConst,
    )
  }

  static configSnapshotsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.configSnapshotsNameConst,
    )
  }

  static sessionRecordsFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.sessionRecordsFileNameConst,
    )
  }

  /**
   * The per-project running count each session is named after. Kept beside the records rather than
   * inside them: the records file is rewritten on every reconcile tick, and a counter that shares a
   * file shares its latch - one unreadable document would then cost both.
   */
  static sessionNumbersFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.sessionNumbersFileNameConst,
    )
  }

  /**
   * Which repository-authored setups this machine has agreed to run. Machine state rather than
   * configuration: it records what a person answered here, so copying a config directory to another
   * machine must not carry the answers with it.
   */
  static setupTrustFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.setupTrustFileNameConst,
    )
  }

  /**
   * Which project directory each Codex rollout was written for. A cache and never a record: deleting
   * it costs the next walk over the store its speed and nothing else. It describes somebody else's
   * store, so the document names the store root it was built over and is discarded when that moves.
   */
  static codexRolloutCwdFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.codexRolloutCwdFileNameConst,
    )
  }

  /** Persistent quota samples; a provider read cannot reconstruct deleted history. */
  static rateHistoryDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), 'rate-history')
  }

  /**
   * The rate limits both agents last reported. A cache and never a record: deleting it costs the next
   * client its first drawing of the widget and one read against an endpoint that counts them.
   */
  static rateMonitorCacheFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.rateMonitorCacheFileNameConst,
    )
  }

  /**
   * Which terminal paths this machine proved by a click, so their panels reopen after a restart.
   * Machine state and main-process only: a renderer that could write it could open any file.
   */
  static terminalOpenedPathsFile(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.terminalOpenedPathsFileNameConst,
    )
  }

  /** Kept apart from `config-snapshots`: the two rings rotate on their own cadences. */
  static sessionSnapshotsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.sessionSnapshotsNameConst,
    )
  }

  /**
   * The saved output of finished script runs, one folder per parent session. Machine state: the
   * output of a repository's commands on this machine, owner-only like the records beside it.
   */
  static scriptLogsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.scriptLogsNameConst,
    )
  }

  /**
   * How each SVN worktree ended, `<actionId>.json` with copies of its run logs beside it. Apart from
   * `script-logs` because a result outlives its session, whose removal takes that folder.
   */
  static worktreeResultsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(
      OrchestratorPaths.directory(configIdentity, channel),
      OrchestratorPaths.worktreeResultsNameConst,
    )
  }

  /**
   * The status line relay Claude sessions are started with, and the `--settings` files naming it.
   * Rewritten by the launch whenever it differs; deleting the folder costs nothing.
   */
  static claudeStatusLineDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), OrchestratorPaths.claudeStatusLineNameConst)
  }

  /**
   * `<claude session id>.json`: the context window Claude Code last handed its status line. Written by
   * the relay above, read by the session model reader; a missing file is the fallback, never an error.
   */
  static claudeContextSnapshotsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), OrchestratorPaths.claudeContextSnapshotsNameConst)
  }

  /** One receipt per Jamat session: the conversation its running Claude reported through the status line relay. */
  static claudeIdentitiesDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), OrchestratorPaths.claudeIdentitiesNameConst)
  }

  static sessionNotifiesDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), OrchestratorPaths.sessionNotifiesNameConst)
  }

  static snapinsDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), 'snapins')
  }

  /**
   * Clipboard images and files pasted into a session, one folder per session, so the agent is handed
   * a path. Machine state that expires by age: the agent reads the file when the path is pasted.
   */
  static pastedFilesDirectory(configIdentity: string, channel: RuntimeChannel): string {
    return join(OrchestratorPaths.directory(configIdentity, channel), OrchestratorPaths.pastedFilesNameConst)
  }
}
