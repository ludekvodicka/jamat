/** Which project a right-click meant, as much of it as the settings tab needs to name and read it. */
export interface WorktreeSetupIntent {
  projectName: string
  projectPath: string
}

/**
 * The one-shot handover between "open the worktree setup of THIS project" and the settings tab.
 *
 * A renderer-side store rather than a prop on the settings frame: widening `ConfigurationTabProps`
 * would put a field every tab can see there for the benefit of one, and the launcher already solves
 * "open a surface knowing where" exactly this way.
 *
 * `consume` is what makes it one-shot, and it is the whole point: a settings card opened later from
 * Ctrl+, must not still be editing the project somebody right-clicked last week.
 */
export class WorktreeSetupIntentStore {
  private intent: WorktreeSetupIntent | null = null

  /** Last write wins: two openers racing is one user clicking twice, and they meant the second. */
  write(intent: WorktreeSetupIntent): void {
    this.intent = intent
  }

  consume(): WorktreeSetupIntent | null {
    const taken = this.intent
    this.intent = null
    return taken
  }
}
