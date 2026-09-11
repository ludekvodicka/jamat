import type { ConfigurationTabId } from './configurationTab.types'

/**
 * Which screen the settings window was last left on, for as long as this window is open.
 *
 * Memory and not `config.json` on purpose: coming back to the screen you were just on is about the
 * last few minutes, and a remembered screen written to a file would open a fresh morning on whatever
 * was being fiddled with the night before. A restart therefore starts at the first screen again,
 * which is also what the frame's tree already decided about its own expanded state.
 *
 * A named open still wins. Only Ctrl+, asks for "wherever I was"; a command that says which screen
 * it wants - the worktree setup of a project, the remote connections - is answered with that screen
 * and is not overruled by a screen somebody left open an hour ago.
 */
export class ConfigurationLastTab {
  private static tab: ConfigurationTabId | null = null

  static remember(tab: ConfigurationTabId): void {
    ConfigurationLastTab.tab = tab
  }

  /** `null` is "nowhere yet", which the frame answers with the first screen in its catalog. */
  static read(): ConfigurationTabId | null {
    return ConfigurationLastTab.tab
  }

  /** Tests share one module, so without this one case opens where the previous one left off. */
  static reset(): void {
    ConfigurationLastTab.tab = null
  }
}
