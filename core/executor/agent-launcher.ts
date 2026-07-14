/**
 * Agent-agnostic launcher facade. Reads `sel.agent` and dispatches to
 * the corresponding adapter's `buildLaunchCommand`. Callers receive an
 * identical `LaunchCommand` shape regardless of which agent was
 * selected — agent-specific logic stays behind the adapter interface.
 *
 * This is also the single choke point where a config-driven per-agent PRE-LAUNCH hook runs
 * (`config.preLaunch`, resolved by the caller from `AppConfig.agents`): after the command builds
 * (so a refused launch — Docker isolation, a bad session id — skips it) and before the caller
 * spawns. Non-fatal — a hook failure is logged and the launch proceeds. All three entry points
 * (electron/cli/agent) go through here, so the hook fires for every session/tab launch.
 */

import { getAgent } from '../agents/index.js'
import { runAgentPreLaunch } from './pre-launch.js'
import type { LaunchCommand, LaunchConfig } from '../types/contracts.js'

export function buildLaunchCommand(config: LaunchConfig): LaunchCommand {
  const agent = getAgent(config.selection.agent)
  const cmd = agent.buildLaunchCommand(config.selection, config.mode, {
    dockerContextDir: config.dockerContextDir,
    skipPermissions: config.skipPermissions,
  })
  if (config.preLaunch) {
    const r = runAgentPreLaunch(config.preLaunch, config.selection)
    if (r.status === 'failed') {
      console.warn(`[pre-launch] ${config.selection.agent} hook failed (launch continues): ${r.detail ?? 'unknown error'}`)
    }
  }
  return cmd
}
