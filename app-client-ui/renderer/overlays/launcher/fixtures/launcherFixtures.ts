import type {
  CategoryInfo,
  ProjectEntry,
  ProjectListResult,
  ProviderSessionSummary,
} from '../../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type { ExistingSessionSummary } from '../create/createScreenModel'

/**
 * Typed rather than JSON on purpose: a fixture cast into the wire type would go on compiling after
 * the wire type moved, and the tests below would then be checking a shape the library no longer has.
 */
export class LauncherFixtures {
  static categories(): readonly CategoryInfo[] {
    return [
      { id: 'nodejs', label: 'NodeJs', path: 'C:\\Projects\\NodeJs', available: true },
      { id: 'web', label: 'Web', path: 'C:\\Projects\\Web', available: true },
      { id: 'ai', label: 'Ai', path: 'C:\\Projects\\Ai', available: false },
    ]
  }

  /**
   * Two projects, then a virtual folder holding two more, and a second folder the root defines and
   * nothing matches. The empty one is what a folder looks like the moment somebody creates it: it is
   * absent from `entries` and present in `virtualFolders`, which is the whole difference the move
   * targets turn on.
   */
  static nodejs(): ProjectListResult {
    const jamat = LauncherFixtures.project('AppJamat', 40)
    const jamatV3 = LauncherFixtures.project('AppJamatV3', 30)
    const old = LauncherFixtures.project('archive/AppOld', 20)
    const legacy = LauncherFixtures.project('archive/BotLegacy', 10)
    return {
      entries: [
        { kind: 'project', project: jamat },
        { kind: 'project', project: jamatV3 },
        { kind: 'virtualFolder', prefix: 'archive/', title: 'archive', children: [old, legacy] },
      ],
      projects: [jamat, jamatV3, old, legacy],
      virtualFolders: [
        { prefix: 'archive/', title: 'archive' },
        { prefix: 'temporary', title: 'Temporary projects' },
      ],
      truncated: false,
      available: true,
    }
  }

  static web(): ProjectListResult {
    const admin = LauncherFixtures.project('WebJamatAdmin', 50)
    const portfolio = LauncherFixtures.project('WebPortfolio', 15)
    return {
      entries: [
        { kind: 'project', project: admin },
        { kind: 'project', project: portfolio },
      ],
      projects: [admin, portfolio],
      virtualFolders: [],
      truncated: false,
      available: true,
    }
  }

  /** What `projects:sessions` hands the session screen: newest first, both providers merged. */
  static history(): readonly ExistingSessionSummary[] {
    return [
      LauncherFixtures.summary('claude', 'sess-claude-1', 'Rewrite the launcher', 'make the picker keyboard first', 5),
      LauncherFixtures.summary('codex', 'sess-codex-1', 'Worktree cleanup', 'remove the stale worktrees', 90),
      LauncherFixtures.summary('claude', 'sess-claude-2', null, 'why does the host drop the lease', 400),
    ].map((summary) => ({ ...summary, localTitle: null }))
  }

  static summary(
    agentId: 'claude' | 'codex',
    nativeSessionId: string,
    title: string | null,
    firstUserMessage: string | null,
    minutesAgo: number,
  ): ProviderSessionSummary {
    const lastActivity = Date.UTC(2026, 7, 5, 12, 0) - minutesAgo * 60_000
    return {
      agentId,
      nativeSessionId,
      title,
      firstUserMessage,
      createdAt: lastActivity - 60_000,
      lastActivity,
      active: false,
    }
  }

  /**
   * Backslashed, the way `join` hands a path back on Windows - a virtual folder's `/` included - so
   * anything that takes a leaf off one of these is taken at its word rather than by the separator.
   */
  private static project(name: string, minutesAgo: number): ProjectEntry {
    return {
      name,
      path: `C:\\Projects\\NodeJs\\${name.replaceAll('/', '\\')}`,
      lastActivity: Date.UTC(2026, 7, 5, 12, 0) - minutesAgo * 60_000,
    }
  }
}
