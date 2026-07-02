/**
 * Agent-agnostic launcher facade. Reads `sel.agent` and dispatches to
 * the corresponding adapter's `buildLaunchCommand`. Callers receive an
 * identical `LaunchCommand` shape regardless of which agent was
 * selected — agent-specific logic stays behind the adapter interface.
 */

import { getAgent } from '../agents/index.js'
import type { LaunchCommand, LaunchConfig } from '../types/contracts.js'

export function buildLaunchCommand(config: LaunchConfig): LaunchCommand {
  const agent = getAgent(config.selection.agent)
  return agent.buildLaunchCommand(config.selection, config.mode, {
    dockerContextDir: config.dockerContextDir,
    skipPermissions: config.skipPermissions,
  })
}
