import type { FileChangesVcsId } from '../../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { ProjectBinding } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionAgentId,
  SessionColorName,
  SessionInfo,
  SessionOutcome,
  SessionParentKind,
  SessionScriptRunInfo,
  SessionScriptsBadge,
  SessionsSnapshot,
  SessionStepInfo,
  SessionWorktreeCleanupPhase,
  SessionWorktreeInfo,
  SessionWorktreeKind,
  SvnFinishPhase,
  SvnFinishResult,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  SessionShellState,
  SessionSubagentState,
  SessionTaskListing,
  SessionTaskRow,
} from '../../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { PathText } from '../../../shared/pathText'
import { TabControlTask } from '../../../shared/tabControl'
import { SessionsGroupsState, type SessionGroup } from '../../../shared/sessionsGroupsState'
import { SessionsFilterState, type SessionFilterStatus, type SessionsFilterValue } from '../../../shared/sessionsFilterState'
import { type TerminalTarget, TerminalTargetCodec } from '../../../shared/terminalTarget'
import type { UiSettingsNestingKey, UiSettingsValue } from '../../../shared/uiSettings'
import { FinalizeAsks } from '../../overlays/finalize/finalizeModel'
import {
  type SessionAction,
  type SessionMergeBadge,
  type SessionGlyph,
  type SessionLandingBadge,
  type SessionLaunchBadge,
  type SessionMainUpdateBadge,
  SessionNodeState,
} from './sessionNodeState'

/** `null` diff = nothing has measured this worktree yet; zero changes is a measurement, absence is not. */
export interface WorktreeBadge {
  kind: SessionWorktreeKind
  path: string
  /** git: the branch; svn: the checked-out URL. */
  branch: string
  /*
   * `changedFiles` was here until 2026-08-24 and is not any more: `WorktreeMark` draws `added`
   * and `removed` and nothing else, and every field of this node is part of the fingerprint the
   * tree is rebuilt from. A number nobody draws that moves on its own is a rebuild nobody asked
   * for - the same reason `outputSeq` left `SessionInfo` in the same change.
   */
  diff: { added: number; removed: number } | null
  /** The branch this worktree was cut from has moved on: the `BASE` chip of the rail design. */
  baseMoved: boolean
  /** A running SVN finish, or null; the title names the scope a review waits for. */
  finish: { phase: SvnFinishPhase; title: string } | null
  /** How the last SVN finish ended, or null while one runs or none has; the title is its lines. */
  outcome: { result: SvnFinishResult; title: string } | null
  /** An SVN action that waits for the person; the text is the workflow's badge, the title says why. It outranks the outcome. */
  needs: { text: string; title: string } | null
  /** Why the worktree is still there after the session's end, or null; the title is the library's sentence. */
  cleanup: { phase: SessionWorktreeCleanupPhase; title: string } | null
}

/**
 * What the launcher needs to start something here without asking which project it is: the session's
 * own binding, handed on rather than rebuilt, because it is already the type the intent carries.
 * Only a catalog project has one - an ad-hoc directory has no category to be named by.
 */
export type ProjectLaunch = Extract<ProjectBinding, { kind: 'project' }>

/** Independent facts. None is ever folded into another, which is the whole point of listing them. */
export interface SessionBadges {
  commitOpen: boolean
  agentId: SessionAgentId | null
  worktree: WorktreeBadge | null
  /** A landed row: its main copy lacks what its worktree committed, and how far it is behind HEAD. */
  landing: SessionLandingBadge | null
  /** An UPDATE of a main copy this session runs, or that waits for the person. */
  mainUpdate: SessionMainUpdateBadge | null
  /** A turn settled or a runtime exited while the person was looking somewhere else. */
  attention: boolean
  /**
   * Which VCS says this session's working copy has uncommitted work, or null for none - either
   * because it is clean, or because nothing has measured it yet. The two are the same to a row:
   * an unmeasured directory draws nothing rather than claiming to be clean.
   */
  vcs: FileChangesVcsId | null
  completed: boolean
  /**
   * Whether this session has a terminal tab open in any workspace window. It is already what keeps
   * a completed row in the tree at all; the row reads it a second time to know whether its Close
   * button has anything to close.
   */
  tabbed: boolean
}

/**
 * Where a script run's terminal is, for a click that opens it. Null where the run has no record left
 * in this snapshot: there is no terminal behind it to open.
 */
export interface ScriptRunOpen {
  target: TerminalTarget
  tabTitle: string
}

/**
 * `open` is the terminal a running or failed badge opens; `logRunId` is the run whose saved log a
 * succeeded badge opens, null on a remote row: a log is local to the computer that ran it.
 */
export type ScriptsBadgeNode = SessionScriptsBadge & { open: ScriptRunOpen | null; logRunId: string | null }

export type ScriptRunNode = SessionScriptRunInfo & { open: ScriptRunOpen | null }

/** Which task a row stands for. The library resolves it again; the renderer never names a file. */
export type TaskRowRef = { kind: 'subagent'; subagentId: string } | { kind: 'shell'; shellId: string }

/** One sub-agent or background shell of a session, as the library listed it. */
export interface TaskRowNode {
  id: string
  sessionId: string
  task: TaskRowRef
  /** The agent type: `Explore`, `general-purpose`, `workflow`; a shell's `$ <command>`. */
  label: string
  /** A sub-agent's description; what the agent said a shell does, or empty. */
  description: string
  /** What it does now, one line, or null once its state settled; a shell has none. */
  detail: string | null
  state: SessionSubagentState | SessionShellState
  depth: 1 | 2
}

/** Retained task rows, with a depth-2 row following its listed parent. */
export interface SessionTasksNode {
  /** `beside`: the `Nest sub-agents` setting is off, so the rows are drawn at the session row's level. */
  placement: 'nested' | 'beside'
  /** The session's number on `beside` rows, which no longer hang under it; null when nested or unnumbered. */
  numberPrefix: string | null
  rows: readonly TaskRowNode[]
}

export type TreeNode = { group: SessionGroup } & (
  | {
      kind: 'category'
      id: string
      label: string
      /**
       * The catalog's own id, or null on the two roots the catalog does not name - AD-HOC and NO
       * PROJECT. Null is what says "nothing can be started from this row": there is no category to
       * open the launcher in.
       */
      categoryId: string | null
      children: readonly TreeNode[]
    }
  | {
      kind: 'project'
      id: string
      label: string
      path: string
      /** Null on an ad-hoc directory, which is the one project row nothing can be launched from. */
      launch: ProjectLaunch | null
      /**
       * One of this row's sessions, for local folder actions to prove the path with. Null on a
       * remote row, whose path describes the target computer and is never opened on this one.
       */
      folderSessionId: string | null
      children: readonly TreeNode[]
    }
  | {
      kind: 'session'
      id: string
      target: TerminalTarget
      operationScope: 'local' | 'remote'
      interactive: boolean
      sessionId: string
      title: string
      /**
       * What a tab for this session is called. It is not the row's own label: the row hangs under
       * the project already, and a tab does not.
       */
      tabTitle: string
      /** The person's note, or null. Never a label: the row offers it only as its tooltip. */
      note: string | null
      /** Where its worktree is or what became of it, or null; the tooltip carries it. */
      worktreeLine: string | null
      /** The name of the colour this session was given, or null. The row paints itself with it. */
      color: SessionColorName | null
      glyph: SessionGlyph
      badges: SessionBadges
      /** The library's badge about this session's before or after scripts, or null. */
      scriptsBadge: ScriptsBadgeNode | null
      /** The run this session's own launch waits for: a click on the row opens it instead. */
      waitingOn: ScriptRunOpen | null
      /** Every run of this session, rows and history, newest first, as the `Scripts` menu lists them. */
      scriptRuns: readonly ScriptRunNode[]
      scriptHistoryRows: readonly ScriptRunNode[]
      /** The library composed a workflow for this session: the row's menu offers Show workflow. */
      workflow: boolean
      /**
       * This row is filed in the section of the session above it, a script run under the session it
       * runs for or a session child under its parent, so a group of its own would change nothing on
       * screen.
       */
      filedWithParent: boolean
      /** A launch the Host keeps refusing, or null while nothing is holding one up. */
      launch: SessionLaunchBadge | null
      /** What the launch word says when it is pointed at, or null where there is no word. */
      launchTitle: string | null
      merge: SessionMergeBadge | null
      /** What the merge word says when it is pointed at, or null where there is no word. */
      mergeTitle: string | null
      /** Operations available across the row and its context menu. */
      actions: readonly SessionAction[]
      /** What Finish is called here, or null on a row that offers none. */
      finalizeLabel: string | null
      /**
       * Whether a runtime is behind this row. It decides whether Finish takes the tab with it, and it
       * is a fact rather than something the view re-reads off the glyph: two derivations of one thing
       * is how the surface and the model come to disagree.
       */
      live: boolean
      endedAt: number | null
      /**
       * How it ended, as the library reads it, or null while it has not. The row draws this and
       * never the exit code: what a kill code means is not the tree's to decide.
       */
      outcome: SessionOutcome | null
      exitCode: number | null
      endedReason: string | null
      /** Its sub-agents, or null on a remote row and while nothing has run inside it. */
      tasks: SessionTasksNode | null
      /** What this client does for the session now, as the library said it; null while nothing runs. */
      step: SessionStepInfo | null
      /**
       * The script runs that still run for this one, or failed and still hold it. A run is something
       * that happened TO this session, so it is drawn under it rather than beside it, where it would
       * read as a second session the user started and does not recognise. Then the session children
       * of the same project, which are part of this one's work, each with its own runs under it.
       */
      children: readonly TreeNode[]
    }
)

export type TreeStateGroup = 'attention' | 'unread' | 'running' | 'read'

export interface TreeViewState {
  assignments?: ReadonlyMap<string, SessionGroup>
  group?: SessionGroup
  filters: SessionsFilterValue
  filterText: string
  stateGroup?: TreeStateGroup
  /**
   * The sessions visible workspace windows have a tab in front for. Only the `attention` filter
   * reads it, and only to keep such a row on the list: opening a session is what TAKES its mark, so
   * under that filter the act of looking at a row removed it from under the cursor, mid-gesture.
   */
  inFront: ReadonlySet<string>
  /**
   * The sessions a workspace window has a tab open for, in front or not. A row whose session is in
   * here survives the state filter, so the tab bar and the tree cannot disagree about what exists.
   */
  tabbed: ReadonlySet<string>
  /**
   * When this build is happening, for closed-session filtering and task expiry. An
   * argument rather than a clock the model reads, so the build stays pure and its tests name the
   * moment. Whatever rebuilds the tree refreshes it - a snapshot poll, a filter change - so a
   * session leaves the window at the next rebuild rather than on the exact minute. Task deadlines
   * also rebuild the tree through the view's next-expiry timer.
   */
  now: number
  /** Task split items in this window, including inactive items. */
  openTaskKeys?: ReadonlySet<string>
  /** The display toggles of Settings; absent nests everything, as a file without them does. */
  nesting?: SessionsNesting
}

export interface TreeResult {
  nodes: readonly TreeNode[]
  emptyState: 'none' | 'noSessions' | 'noMatch'
  nextTaskExpiryAt: number | null
  /**
   * What each node looked like when this result was built, by node id, so the next build compares
   * one string per node instead of serializing both sides again. A session's task rows are printed
   * apart from it, under `SessionsTreeModel.tasksPrintKeyOf(id)`.
   */
  fingerprints: ReadonlyMap<string, string>
}

interface SessionEntry {
  info: SessionInfo
  badges: SessionBadges
  searchText: string
  targetKey: string
  group: SessionGroup
}

export interface SessionsTreeBuildOptions {
  namespace: string
  target: { kind: 'local' } | { kind: 'remote'; remoteEndpointId: string }
  operationScope: 'local' | 'remote'
  interactive: boolean
  allowLocalPaths: boolean
}

/** The one session a row is drawn under: the session a run runs for, or a session child's parent. */
interface ParentLink {
  parent: SessionEntry
  via: 'script' | 'session'
}

/** Which kinds of session child are drawn under their parent rather than as rows of their own. */
export interface SessionsNesting {
  subagents: boolean
  worktrees: boolean
  tickets: boolean
}

/** What every session node of one build reads beside its own entry. */
interface NodeContext {
  children: ReadonlyMap<string, readonly SessionEntry[]>
  links: ReadonlyMap<string, ParentLink>
  /** Every session of the snapshot, matching or not: a run's terminal is opened by its own record. */
  byId: ReadonlyMap<string, SessionEntry>
  options: SessionsTreeBuildOptions
  tasks: ReadonlyMap<string, SessionTaskListing>
  nesting: SessionsNesting
  now: number
  openTaskKeys: ReadonlySet<string>
  nextTaskExpiryAt: number | null
}

interface ProjectGroup {
  id: string
  label: string
  path: string
  launch: ProjectLaunch | null
  entries: SessionEntry[]
}

interface CategoryGroup {
  label: string
  projects: Map<string, ProjectGroup>
}

/**
 * The sessions tree in one pure function: a snapshot and what the user filtered by go in, the nodes
 * a component draws come out. Every surface fact - which glyph a session gets, which project it
 * belongs to, what a filter hides, where an install is drawn - is decided here, so the component
 * only draws. Deciding in the component is how three different answers to "is this session live"
 * end up in one tree.
 */
export class SessionsTreeModel {
  private static readonly taskRetentionMsConst = 5_000
  static readonly groupsConst = [
    { key: 'attention', title: 'Needs attention' },
    { key: 'unread', title: 'Idle unread' },
    { key: 'running', title: 'Running' },
    { key: 'read', title: 'Read' },
  ] as const satisfies readonly { key: TreeStateGroup; title: string }[]
  /**
   * A tree that was never built, for a section nothing can be in. Shared rather than made per call:
   * it holds no node, so nothing about it can differ between two of them.
   */
  static readonly emptyConst: TreeResult = {
    nodes: [],
    emptyState: 'noSessions',
    nextTaskExpiryAt: null,
    fingerprints: new Map(),
  }
  static readonly nestedConst: SessionsNesting = { subagents: true, worktrees: true, tickets: true }

  /** The Settings toggles as the build reads them; only `false` turns one off. */
  static nestingOf(settings: Pick<UiSettingsValue, UiSettingsNestingKey>): SessionsNesting {
    return {
      subagents: settings.sessionsNestSubagents !== false,
      worktrees: settings.sessionsNestWorktrees !== false,
      tickets: settings.sessionsNestTickets !== false,
    }
  }

  static build(
    snapshot: SessionsSnapshot,
    view: TreeViewState,
    marks: ReadonlySet<string>,
    previous: TreeResult | null,
    options: SessionsTreeBuildOptions = SessionsTreeModel.localOptions(),
    commitOpen: ReadonlySet<string> = new Set(),
    tasks: ReadonlyMap<string, SessionTaskListing> = new Map(),
  ): TreeResult {
    if (snapshot.sessions.length === 0)
      return { nodes: [], emptyState: 'noSessions', nextTaskExpiryAt: null, fingerprints: new Map() }
    const entries = snapshot.sessions.map((info) =>
      SessionsTreeModel.entryOf(info, marks, options, commitOpen, view.assignments, view.tabbed))
    const byId = new Map(entries.map((entry) => [entry.info.sessionId, entry]))
    const nesting = view.nesting ?? SessionsTreeModel.nestedConst
    const links = SessionsTreeModel.linksOf(entries, byId, nesting)
    const families = SessionsTreeModel.familyGroupsOf(entries, links)
    const matching = entries.filter((entry) => {
      const section = SessionsTreeModel.sectionOf(entry, links)
      const family = families.get(section.info.sessionId) ?? SessionsTreeModel.stateGroupOf(section)
      if (SessionsTreeModel.matches(section, family, entry, view)) return true
      // A run happened TO its parent, so a filter that keeps the parent keeps its running work. A
      // session child is work of its own and keeps its own filter.
      const link = links.get(entry.info.sessionId)
      return link?.via === 'script' && SessionsTreeModel.matches(section, family, link.parent, view)
    })
    if (matching.length === 0)
      return { nodes: [], emptyState: 'noMatch', nextTaskExpiryAt: null, fingerprints: new Map() }

    const children = SessionsTreeModel.childrenByParent(matching, links)
    const nested = new Set([...children.values()].flat().map((entry) => entry.info.sessionId))
    const roots = matching.filter((entry) => !nested.has(entry.info.sessionId))
    const context: NodeContext = { children, links, byId, options, tasks, nesting, now: view.now,
      openTaskKeys: view.openTaskKeys ?? new Set(), nextTaskExpiryAt: null }
    const nodes = SessionsTreeModel.decorate(
      SessionsTreeModel.rootNodes(roots, snapshot, context),
      options,
      view.assignments,
    )
    return SessionsTreeModel.withIdentity(previous, {
      nodes,
      emptyState: 'none',
      nextTaskExpiryAt: context.nextTaskExpiryAt,
      fingerprints: new Map(),
    })
  }

  private static worktreeBadgeOf(worktree: SessionWorktreeInfo, action: SessionInfo['svnAction'], workflow: SessionInfo['workflow']): WorktreeBadge {
    const phase = SessionNodeState.finishBadgeOf(worktree.finish)
    const needs = SessionNodeState.actionNeedsOf(action)
    const result = SessionNodeState.outcomeBadgeOf(worktree)
    const cleanup = SessionNodeState.cleanupBadgeOf(worktree)
    return {
      kind: worktree.kind,
      path: worktree.worktreePath,
      branch: worktree.branch,
      diff: worktree.diff ? { added: worktree.diff.added, removed: worktree.diff.removed } : null,
      baseMoved: worktree.baseMoved,
      finish: phase === null
        ? null
        : { phase, title: SessionNodeState.finishTitleOf(worktree.finish, action) ?? phase },
      outcome: result === null
        ? null
        : { result, title: SessionNodeState.outcomeTitleOf(worktree) ?? result },
      needs: needs === null ? null : { text: SessionNodeState.needsTextOf(workflow), title: needs },
      cleanup: cleanup === null ? null : { phase: cleanup, title: worktree.cleanup?.summary ?? cleanup },
    }
  }

  /**
   * Where the session runs or ran, for the row's tooltip: the worktree with its kind, or where a
   * removed worktree's work went. Null for a session that never had one.
   */
  static worktreeLineOf(info: Pick<SessionInfo, 'worktree' | 'retiredWorktree'>): string | null {
    if (info.worktree !== undefined) {
      const kind = SessionNodeState.worktreeKindLabelOf(info.worktree.kind)
      const cleanup = info.worktree.cleanup === undefined ? '' : `; ${info.worktree.cleanup.summary}`
      return `${kind} worktree ${info.worktree.worktreePath}${cleanup}`
    }
    if (info.retiredWorktree !== undefined) {
      const revisions = info.retiredWorktree.revisions
      return `Worktree ${info.retiredWorktree.worktreePath} removed after ${
        revisions.length === 0 ? 'no commit' : revisions.join(', ')}`
    }
    return null
  }

  private static entryOf(
    info: SessionInfo,
    marks: ReadonlySet<string>,
    options: SessionsTreeBuildOptions,
    commitOpen: ReadonlySet<string>,
    assignments: TreeViewState['assignments'],
    tabbed: TreeViewState['tabbed'],
  ): SessionEntry {
    const target = SessionsTreeModel.targetOf(info.sessionId, options)
    const targetKey = TerminalTargetCodec.key(target)
    const badges: SessionBadges = {
      commitOpen: options.target.kind === 'local' && commitOpen.has(info.sessionId),
      agentId: info.agent?.agentId ?? null,
      worktree: info.worktree ? SessionsTreeModel.worktreeBadgeOf(info.worktree, info.svnAction, info.workflow) : null,
      landing: SessionNodeState.landingOf(info.retiredWorktree),
      mainUpdate: SessionNodeState.mainUpdateOf(info.svnAction),
      vcs: info.vcs?.dirty === true ? info.vcs.vcsId : null,
      attention: marks.has(targetKey),
      completed: info.completed === true,
      tabbed: tabbed.has(targetKey),
    }
    const searchText = [
      info.title,
      info.agent?.agentId ?? '',
      SessionsTreeModel.projectTextOf(info.project),
    ].join(' ').toLowerCase()
    const groupKeys = SessionsGroupsState.keysOf(target, info.project, options.namespace)
    return { info, badges, searchText, targetKey, group: SessionsGroupsState.groupOf(groupKeys, assignments) }
  }

  static groupKeyOf(node: TreeNode): string {
    if (node.kind === 'session') return SessionsGroupsState.sessionKeyOf(node.target)
    else if (node.kind === 'category' || node.kind === 'project') return node.id
    else throw new Error(`Unknown tree node: ${JSON.stringify(node)}`)
  }

  private static namespaced(id: string, options: SessionsTreeBuildOptions): string {
    return options.namespace.length === 0 ? id : `${options.namespace}/${id}`
  }

  /**
   * A nested row is filed where the session at the top of its family is filed: that one's assigned
   * group and its family's state group. A run has neither of its own that means anything - an install
   * has no group, and an ended install under a session still starting is part of that start, not
   * something to attend to - and a session child read apart from its parent would split one piece of
   * work over two sections. Two hops at most: a run, the session child it runs for, that child's parent.
   */
  private static sectionOf(entry: SessionEntry, links: ReadonlyMap<string, ParentLink>): SessionEntry {
    const first = links.get(entry.info.sessionId)?.parent
    if (first === undefined) return entry
    return links.get(first.info.sessionId)?.parent ?? first
  }

  /**
   * `section` answers the group and `family` the state group; every other filter reads the entry
   * itself.
   */
  private static matches(
    section: SessionEntry,
    family: TreeStateGroup,
    entry: SessionEntry,
    view: TreeViewState,
  ): boolean {
    if (view.group !== undefined && section.group !== view.group) return false
    if (view.stateGroup !== undefined && family !== view.stateGroup) return false
    const text = view.filterText.trim().toLowerCase()
    if (text.length > 0 && !entry.searchText.includes(text))
      return false
    const { colors, agents, states } = view.filters
    if (colors.length > 0 && !colors.includes(entry.info.color ?? null)) return false
    if (agents.length > 0 && !agents.includes(entry.badges.agentId)) return false
    if (states.length === 0) return true
    // A session keeps its row for as long as it has a tab open somewhere. Finalizing a session does
    // not close its tab, deliberately: the tab is where the person reads what happened. The state
    // filter dropped the row anyway, so a tab could sit on screen with nothing in the list that owns
    // it, and no way to act on the session from there. Only the state filter is overruled: narrowing
    // by text, color or agent is the person asking to see less, and is left alone.
    if (view.tabbed.has(entry.targetKey)) return true
    return states.some((state) => SessionsTreeModel.inState(entry, state, view))
  }

  private static stateGroupOf(entry: SessionEntry): TreeStateGroup {
    const info = entry.info
    const glyph = SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail, info.compacting)
    switch (glyph) {
      case 'waiting': return 'attention'
      case 'starting':
      case 'working':
      case 'compacting':
      case 'background':
      case 'shell': return 'running'
      case 'ended':
      case 'lost': return entry.badges.completed ? 'read' : 'attention'
      case 'idle': return entry.badges.attention ? 'unread' : 'read'
      case 'unknown': return 'attention'
      default: throw new Error(`Unknown session glyph: ${JSON.stringify(glyph)}`)
    }
  }

  private static inState(entry: SessionEntry, state: SessionFilterStatus, view: TreeViewState): boolean {
    const info = entry.info
    const glyph = SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail, info.compacting)
    switch (state) {
      case 'active': return !entry.badges.completed
      // Viewing a marked row takes its mark; retain it so a double-click cannot open the next row.
      case 'attention': return entry.badges.attention || view.inFront.has(entry.targetKey)
      case 'running': return glyph === 'working' || glyph === 'background'
        || glyph === 'compacting' || glyph === 'shell'
      case 'question': return glyph === 'waiting'
      case 'idle': return glyph === 'idle'
      case 'starting': return glyph === 'starting'
      case 'background': return glyph === 'background'
      case 'ended': return glyph === 'ended'
      case 'lost': return glyph === 'lost'
      case 'completed': return entry.badges.completed
      case 'unknown': return glyph === 'unknown'
      // `endedAt` is the only closing time a record keeps, and a session that is still running has
      // none: absence is what says "this one has not closed", not a zero to compare against.
      case 'closedRecently': return info.endedAt !== undefined
        && view.now - info.endedAt <= SessionsFilterState.closedWithinMsConst
      default: throw new Error(`Unknown session filter state: ${JSON.stringify(state)}`)
    }
  }

  /**
   * The family's state group, by the id of the session at its top: the most urgent of that session
   * and its live nested session children. A question asked by a worktree child is the family's
   * question, while a child that ended is history and leaves the family where its parent is. Read
   * over every session, before any filter, so a filter cannot move a family between groups.
   */
  private static familyGroupsOf(
    entries: readonly SessionEntry[],
    links: ReadonlyMap<string, ParentLink>,
  ): ReadonlyMap<string, TreeStateGroup> {
    const families = new Map(entries.map((entry) => [entry.info.sessionId, SessionsTreeModel.stateGroupOf(entry)]))
    for (const entry of entries) {
      const link = links.get(entry.info.sessionId)
      if (link === undefined || link.via !== 'session' || !SessionNodeState.isLive(entry.info.life)) continue
      const parentId = link.parent.info.sessionId
      const parent = families.get(parentId) ?? SessionsTreeModel.stateGroupOf(link.parent)
      families.set(parentId, SessionsTreeModel.moreUrgent(parent, SessionsTreeModel.stateGroupOf(entry)))
    }
    return families
  }

  /** The order of `groupsConst` is the order of urgency. */
  private static moreUrgent(left: TreeStateGroup, right: TreeStateGroup): TreeStateGroup {
    const rank = (group: TreeStateGroup): number =>
      SessionsTreeModel.groupsConst.findIndex((entry) => entry.key === group)
    return rank(right) < rank(left) ? right : left
  }

  /**
   * Which sessions belong under which, among the ones that survived the filter. Every script run
   * nests for the same reason and is read the same way: an install prepares a session, a resolver
   * settles its merge, a check runs before its Finish. Each happened TO the row above it rather than
   * beside it. A session child of the same project nests under its parent, because it is part of
   * that one's work.
   *
   * A hidden parent does not hide its child: the child is drawn where its own directory puts it
   * instead, because a tree that answers "show me what is running" must not lose a running session
   * to its parent.
   */
  private static childrenByParent(
    entries: readonly SessionEntry[],
    links: ReadonlyMap<string, ParentLink>,
  ): Map<string, SessionEntry[]> {
    const shown = new Set(entries.map((entry) => entry.info.sessionId))
    const children = new Map<string, SessionEntry[]>()
    for (const entry of entries) {
      const parentId = links.get(entry.info.sessionId)?.parent.info.sessionId
      if (parentId === undefined || !shown.has(parentId))
        continue
      children.set(parentId, [...(children.get(parentId) ?? []), entry])
    }
    return children
  }

  /** Every session's link to the row it is drawn under, read over the whole snapshot, filter or not. */
  private static linksOf(
    entries: readonly SessionEntry[],
    byId: ReadonlyMap<string, SessionEntry>,
    nesting: SessionsNesting,
  ): ReadonlyMap<string, ParentLink> {
    const links = new Map<string, ParentLink>()
    for (const entry of entries) {
      const link = SessionsTreeModel.parentOf(entry, byId, nesting)
      if (link !== undefined) links.set(entry.info.sessionId, link)
    }
    return links
  }

  /**
   * Two links, one hop each. A script run's link comes first: it nests under its session, which may
   * itself be a nested session child, so a worktree child's setup run stays under the child. A run of
   * a run is not something the session manager writes, and neither is a parent that is a run.
   * Refusing them is what keeps a hand-edited record from folding two sessions into each other, where
   * both would leave the roots and neither would be drawn.
   */
  private static parentOf(
    entry: SessionEntry,
    byId: ReadonlyMap<string, SessionEntry>,
    nesting: SessionsNesting,
  ): ParentLink | undefined {
    const runFor = entry.info.script?.parentId
    if (runFor !== undefined) {
      const parent = byId.get(runFor)
      return parent === undefined || parent === entry || parent.info.script !== undefined
        ? undefined
        : { parent, via: 'script' }
    }
    const parent = SessionsTreeModel.ownParentOf(entry, byId, nesting)
    // One hop: a parent whose own link nests nests nothing, so a grandchild is a root. Only the
    // parent's own link is read, so a hand-edited cycle cannot recurse.
    if (parent === undefined || SessionsTreeModel.ownParentOf(parent, byId, nesting) !== undefined)
      return undefined
    return { parent, via: 'session' }
  }

  /** The parent a session's own link names, when that link nests at all. */
  private static ownParentOf(
    entry: SessionEntry,
    byId: ReadonlyMap<string, SessionEntry>,
    nesting: SessionsNesting,
  ): SessionEntry | undefined {
    const link = entry.info.parent
    if (link === undefined || !link.sameProject || !SessionsTreeModel.nests(link.kind, nesting))
      return undefined
    const parent = byId.get(link.sessionId)
    return parent === undefined || parent === entry || parent.info.script !== undefined ? undefined : parent
  }

  private static nests(kind: SessionParentKind, nesting: SessionsNesting): boolean {
    switch (kind) {
      case 'worktree': return nesting.worktrees
      case 'ticket': return nesting.tickets
      case 'worker': return nesting.subagents
      default: throw new Error(`Unknown session parent kind: ${JSON.stringify(kind satisfies never)}`)
    }
  }

  private static rootNodes(
    roots: readonly SessionEntry[],
    snapshot: SessionsSnapshot,
    context: NodeContext,
  ): readonly TreeNode[] {
    const categories = new Map<string, CategoryGroup>()
    const adHoc = new Map<string, ProjectGroup>()
    const loose: SessionEntry[] = []

    for (const entry of roots) {
      const binding = entry.info.project
      const group = SessionsGroupsState.projectGroupOf(binding)
      if (binding.kind === 'project')
        SessionsTreeModel.push(
          SessionsTreeModel.categoryOf(categories, binding.categoryId, snapshot).projects,
          group.rootId,
          { path: binding.projectPath, label: binding.projectName, launch: binding },
          entry,
        )
      else if (binding.kind === 'adHoc')
        SessionsTreeModel.push(
          adHoc,
          group.rootId,
          { path: binding.path, label: SessionsTreeModel.leafOf(binding.path), launch: null },
          entry,
        )
      else if (binding.kind === 'none')
        loose.push(entry)
      else
        throw new Error(`Unknown project binding: ${JSON.stringify(binding)}`)
    }

    // The two roots the catalog does not name are held apart from it rather than under invented
    // category ids: a configured category called `adhoc` would otherwise have its sessions quietly
    // folded into this one.
    const nodes = SessionsTreeModel.orderedCategories(categories, snapshot)
      .map(([id, group]) => SessionsTreeModel.categoryNode(
        `category:${id}`,
        group.label,
        id,
        SessionsTreeModel.projectNodes(group.projects, context),
      ))
    if (adHoc.size > 0)
      nodes.push(SessionsTreeModel.categoryNode(
        SessionsGroupsState.adHocRootConst,
        'AD-HOC',
        null,
        SessionsTreeModel.projectNodes(adHoc, context),
      ))
    if (loose.length > 0)
      nodes.push(SessionsTreeModel.categoryNode(
        SessionsGroupsState.noProjectRootConst,
        'NO PROJECT',
        null,
        SessionsTreeModel.sessionNodes(loose, context),
      ))
    return nodes
  }

  private static categoryOf(
    categories: Map<string, CategoryGroup>,
    categoryId: string,
    snapshot: SessionsSnapshot,
  ): CategoryGroup {
    const found = categories.get(categoryId)
    if (found)
      return found
    const label = snapshot.categories.find((category) => category.id === categoryId)?.label
      ?? categoryId
    const created: CategoryGroup = { label, projects: new Map() }
    categories.set(categoryId, created)
    return created
  }

  private static push(
    projects: Map<string, ProjectGroup>,
    rootId: string,
    seed: Omit<ProjectGroup, 'id' | 'entries'>,
    entry: SessionEntry,
  ): void {
    // Two sessions in `C:\work` and `c:/work` are two sessions in one directory, and one project row
    // is what says so. The path drawn stays the first one seen; only the key is normalised.
    const key = PathText.comparable(seed.path)
    const found = projects.get(key)
    if (found) {
      found.entries.push(entry)
      return
    }
    projects.set(key, { ...seed, id: SessionsGroupsState.projectKeyOf(rootId, seed.path), entries: [entry] })
  }

  /**
   * Catalog order. A binding naming a category the snapshot does not list cannot happen - both are
   * read from one catalog pass - but a session that got here is still a session someone is running,
   * and dropping it silently is the one outcome this tree exists to prevent, so it sorts last.
   */
  private static orderedCategories(
    categories: ReadonlyMap<string, CategoryGroup>,
    snapshot: SessionsSnapshot,
  ): readonly [string, CategoryGroup][] {
    const indexOf = (id: string): number => {
      const found = snapshot.categories.findIndex((category) => category.id === id)
      return found < 0 ? snapshot.categories.length : found
    }
    return [...categories.entries()].sort(([left], [right]) => indexOf(left) - indexOf(right))
  }

  private static projectNodes(
    projects: ReadonlyMap<string, ProjectGroup>,
    context: NodeContext,
  ): readonly TreeNode[] {
    return [...projects.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((project): TreeNode => ({
        kind: 'project',
        group: 'none',
        id: project.id,
        label: project.label,
        path: project.path,
        launch: project.launch,
        // The first one the tree draws, so the folder actions do not change what they prove with
        // whenever the entries happen to be gathered in another order.
        folderSessionId: SessionsTreeModel.sorted(project.entries)[0].info.sessionId,
        children: SessionsTreeModel.sessionNodes(project.entries, context),
      }))
  }

  private static categoryNode(
    id: string,
    label: string,
    categoryId: string | null,
    children: readonly TreeNode[],
  ): TreeNode {
    return { kind: 'category', id, label, categoryId, children, group: 'none' }
  }

  /** Sorted by what the user reads, so a row does not move when a random session id sorts elsewhere. */
  private static sessionNodes(
    entries: readonly SessionEntry[],
    context: NodeContext,
  ): readonly TreeNode[] {
    return SessionsTreeModel.sorted(entries).map((entry) => SessionsTreeModel.sessionNode(
      entry,
      // Ends after two levels: `parentOf` never puts a session child under a nested row, and never a
      // run under a run.
      SessionsTreeModel.sessionNodes(context.children.get(entry.info.sessionId) ?? [], context),
      context,
    ))
  }

  private static sorted(entries: readonly SessionEntry[]): readonly SessionEntry[] {
    return [...entries].sort((left, right) => left.info.title.localeCompare(right.info.title)
      || left.info.sessionId.localeCompare(right.info.sessionId))
  }

  private static sessionNode(
    entry: SessionEntry,
    children: readonly TreeNode[],
    context: NodeContext,
  ): TreeNode {
    const { options } = context
    const info = entry.info
    const badge = SessionNodeState.scriptsBadgeOf(info.scripts)
    const waitingOn = info.scripts?.waitingOn
    const target = SessionsTreeModel.targetOf(info.sessionId, options)
    const actions = SessionsTreeModel.scopedActions(
      SessionNodeState.actionsOf(info, FinalizeAsks.offered(info, options.operationScope)
        || SessionNodeState.opensWorkflow(info, options.operationScope)),
      options,
    )
    const scriptRuns = (info.scripts?.runs ?? []).map((run) => ({
      ...run,
      open: run.row ? SessionsTreeModel.runOpenOf(run.runId, context) : null,
    }))
    return {
      kind: 'session',
      group: entry.group,
      id: `session:${info.sessionId}`,
      target,
      operationScope: options.operationScope,
      interactive: options.interactive,
      sessionId: info.sessionId,
      title: info.title,
      tabTitle: info.tabTitle,
      note: info.note ?? null,
      worktreeLine: SessionsTreeModel.worktreeLineOf(info),
      color: info.color ?? null,
      glyph: SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail, info.compacting),
      badges: entry.badges,
      scriptsBadge: badge === null ? null : {
        ...badge,
        open: badge.runId !== undefined && SessionNodeState.scriptsBadgeClickOf(badge.state) === 'terminal'
          ? SessionsTreeModel.runOpenOf(badge.runId, context)
          : null,
        logRunId: badge.runId !== undefined && SessionNodeState.scriptsBadgeClickOf(badge.state) === 'log'
          ? SessionsTreeModel.savedLogOf(badge.runId, info, options)
          : null,
      },
      waitingOn: waitingOn === undefined ? null : SessionsTreeModel.runOpenOf(waitingOn, context),
      scriptRuns,
      scriptHistoryRows: SessionsTreeModel.scriptHistoryOf(info.sessionId, scriptRuns, context),
      workflow: info.workflow !== undefined,
      filedWithParent: context.links.has(info.sessionId),
      launch: SessionNodeState.launchBadgeOf(info.launchWait),
      launchTitle: SessionNodeState.launchTitleOf(info.launchWait),
      actions,
      finalizeLabel: actions.includes('finalize')
        ? SessionNodeState.finalizeLabelOf(info.life, info.worktree?.liveFinish === true)
        : null,
      live: SessionNodeState.isLive(info.life),
      merge: SessionNodeState.mergeBadgeOf(info.merge),
      mergeTitle: SessionNodeState.mergeTitleOf(info.merge),
      endedAt: info.endedAt ?? null,
      outcome: info.outcome ?? null,
      exitCode: info.exitCode ?? null,
      endedReason: info.endedReason ?? null,
      tasks: SessionsTreeModel.tasksOf(info, context),
      step: info.step ?? null,
      children,
    }
  }

  /** Only a local row reads a listing: a paired computer hands over no sub-agent content. */
  private static tasksOf(info: SessionInfo, context: NodeContext): SessionTasksNode | null {
    const sessionId = info.sessionId
    const target = context.options.target
    if (target.kind === 'remote') return null
    else if (target.kind !== 'local')
      throw new Error(`Unknown sessions tree target: ${JSON.stringify(target satisfies never)}`)
    const listing = context.tasks.get(sessionId)
    if (listing === undefined || listing.kind === 'none') return null
    else if (listing.kind !== 'tasks')
      throw new Error(`Unknown session task listing: ${JSON.stringify(listing satisfies never)}`)
    const rows = SessionsTreeModel.underTheirParents(listing.rows.filter((row) =>
      SessionsTreeModel.keepsTask(TabControlTask.keyOf(sessionId, row), row.state === 'running', row.endedAt, context)))
    if (rows.length === 0) return null
    const nested = context.nesting.subagents
    return {
      placement: nested ? 'nested' : 'beside',
      numberPrefix: nested ? null : info.titleParts.number,
      rows: rows.map((row) => SessionsTreeModel.taskRowOf(sessionId, row)),
    }
  }

  private static keepsTask(key: string, running: boolean, endedAt: number | null, context: NodeContext): boolean {
    if (running || context.openTaskKeys.has(key)) return true
    if (endedAt === null) return false
    const expiresAt = endedAt + SessionsTreeModel.taskRetentionMsConst
    if (expiresAt <= context.now) return false
    context.nextTaskExpiryAt = Math.min(context.nextTaskExpiryAt ?? expiresAt, expiresAt)
    return true
  }

  private static scriptHistoryOf(sessionId: string, runs: readonly ScriptRunNode[], context: NodeContext): readonly ScriptRunNode[] {
    const target = context.options.target
    if (target.kind === 'remote') return []
    else if (target.kind !== 'local')
      throw new Error(`Unknown sessions tree target: ${JSON.stringify(target satisfies never)}`)
    return runs.filter((run) => !run.row && SessionsTreeModel.keepsTask(
      TabControlTask.keyOf(sessionId, { kind: 'script', runId: run.runId }),
      run.state === 'running', run.endedAt ?? null, context))
  }

  /**
   * The listing's order, except that a depth-2 sub-agent moves under its depth-1 row when that one is
   * listed beside it. A shell is never placed under anything.
   */
  private static underTheirParents(rows: readonly SessionTaskRow[]): readonly SessionTaskRow[] {
    const listed = new Set(rows.flatMap((row) => row.kind === 'subagent' ? [row.subagentId] : []))
    const placedUnder = (row: SessionTaskRow): boolean => row.kind === 'subagent' && row.depth === 2
      && row.parentSubagentId !== null && row.parentSubagentId !== row.subagentId
      && listed.has(row.parentSubagentId)
    const out: SessionTaskRow[] = []
    for (const row of rows) {
      if (placedUnder(row)) continue
      out.push(row)
      if (row.kind === 'subagent')
        out.push(...rows.filter((child) => placedUnder(child) && child.kind === 'subagent'
          && child.parentSubagentId === row.subagentId))
    }
    return out
  }

  private static taskRowOf(sessionId: string, row: SessionTaskRow): TaskRowNode {
    switch (row.kind) {
      case 'subagent':
        return {
          id: `task:${sessionId}:subagent:${row.subagentId}`,
          sessionId,
          task: { kind: 'subagent', subagentId: row.subagentId },
          label: row.agentType,
          description: row.description,
          detail: row.step,
          state: row.state,
          depth: row.depth,
        }
      case 'shell':
        return {
          id: `task:${sessionId}:shell:${row.shellId}`,
          sessionId,
          task: { kind: 'shell', shellId: row.shellId },
          label: `$ ${row.command}`,
          description: row.description ?? '',
          detail: null,
          state: row.state,
          depth: 1,
        }
      default:
        throw new Error(`Unknown session task row: ${JSON.stringify(row satisfies never)}`)
    }
  }

  /** The run's own tab title, so its tab says which project it belongs to like every other tab. */
  private static runOpenOf(runId: string, context: NodeContext): ScriptRunOpen | null {
    const run = context.byId.get(runId)
    if (run === undefined) return null
    return { target: SessionsTreeModel.targetOf(runId, context.options), tabTitle: run.info.tabTitle }
  }

  /** The run id when its log is saved and this computer holds it; the main process proves it again. */
  private static savedLogOf(runId: string, info: SessionInfo, options: SessionsTreeBuildOptions): string | null {
    if (options.target.kind === 'remote') return null
    else if (options.target.kind === 'local')
      return info.scripts?.runs.some((run) => run.runId === runId && run.log === 'saved') ? runId : null
    else
      throw new Error(`Unknown sessions tree target: ${JSON.stringify(options.target)}`)
  }

  private static decorate(
    nodes: readonly TreeNode[],
    options: SessionsTreeBuildOptions,
    assignments: TreeViewState['assignments'],
    inherited: SessionGroup = 'none',
  ): readonly TreeNode[] {
    return nodes.map((node): TreeNode => {
      const id = SessionsTreeModel.namespaced(node.id, options)
      const group = node.kind === 'session' ? node.group : assignments?.get(id) ?? inherited
      const children = SessionsTreeModel.decorate(node.children, options, assignments, group)
      if (node.kind === 'category')
        return {
          ...node,
          id,
          categoryId: options.allowLocalPaths ? node.categoryId : null,
          group,
          children,
        }
      else if (node.kind === 'project')
        return {
          ...node,
          id,
          launch: options.allowLocalPaths ? node.launch : null,
          group,
          folderSessionId: options.allowLocalPaths ? node.folderSessionId : null,
          children,
        }
      else if (node.kind === 'session') {
        return {
          ...node,
          id,
          children,
        }
      } else
        throw new Error(`Unknown tree node: ${JSON.stringify(node)}`)
    })
  }

  private static targetOf(sessionId: string, options: SessionsTreeBuildOptions): TerminalTarget {
    if (options.target.kind === 'local') return { kind: 'local', sessionId }
    else if (options.target.kind === 'remote')
      return { kind: 'remote', remoteEndpointId: options.target.remoteEndpointId, sessionId }
    else
      throw new Error(`Unknown sessions tree target: ${JSON.stringify(options.target)}`)
  }

  /**
   * Remote control exposes only rerun and finalize; the catalog still decides remote finalize.
   * `close` survives the narrowing because it is not a remote operation at all: the tab it closes is
   * this computer's, and a remote row that has one can be put away exactly like a local one.
   */
  private static scopedActions(
    actions: readonly SessionAction[],
    options: SessionsTreeBuildOptions,
  ): readonly SessionAction[] {
    if (!options.interactive) return []
    if (options.operationScope === 'local') return actions
    else if (options.operationScope === 'remote')
      return actions.filter((action) => action === 'reopen' || action === 'finalize'
        || action === 'close')
    else
      throw new Error(`Unknown operation scope: ${JSON.stringify(options.operationScope)}`)
  }

  private static localOptions(): SessionsTreeBuildOptions {
    return {
      namespace: '',
      target: { kind: 'local' },
      operationScope: 'local',
      interactive: true,
      allowLocalPaths: true,
    }
  }

  private static projectTextOf(project: ProjectBinding): string {
    if (project.kind === 'project') return `${project.projectName} ${project.projectPath}`
    else if (project.kind === 'adHoc') return project.path
    else if (project.kind === 'none') return ''
    else
      throw new Error(`Unknown project binding: ${JSON.stringify(project)}`)
  }


  private static leafOf(path: string): string {
    const parts = path.replaceAll('\\', '/').replace(/\/+$/, '').split('/')
    return parts[parts.length - 1] || path
  }

  /**
   * A tick that only moved one session must not hand every row a new object: React would re-render
   * the whole tree, and in a tree of live sessions that is every second.
   */
  private static withIdentity(previous: TreeResult | null, next: TreeResult): TreeResult {
    const byId = new Map<string, TreeNode>()
    const index = (nodes: readonly TreeNode[]): void => {
      for (const node of nodes) {
        byId.set(node.id, node)
        index(node.children)
      }
    }
    if (previous)
      index(previous.nodes)
    const before = previous?.fingerprints ?? new Map<string, string>()
    const prints = new Map<string, string>()

    const reuse = (nodes: readonly TreeNode[]): readonly TreeNode[] => nodes.map((node): TreeNode => {
      const children = reuse(node.children)
      // A node prints its OWN fields only. Its subtree is already decided by the children the line
      // above returned, so comparing their identity is both cheaper and exact - serializing the
      // subtree again would re-walk every session under every category, per tick.
      const print = SessionsTreeModel.ownPrintOf(node)
      prints.set(node.id, print)
      const old = byId.get(node.id)
      const same = old !== undefined && old.kind === node.kind && before.get(node.id) === print
        && SessionsTreeModel.sameNodes(old.children, children)
      if (node.kind !== 'session')
        return same ? old : { ...node, children }
      // Printed on their own, so a moved step leaves the session's own print alone, and an unmoved
      // listing keeps the object its rows were drawn from.
      const tasksKey = SessionsTreeModel.tasksPrintKeyOf(node.id)
      const tasksPrint = JSON.stringify(node.tasks)
      prints.set(tasksKey, tasksPrint)
      const tasks = old?.kind === 'session' && before.get(tasksKey) === tasksPrint ? old.tasks : node.tasks
      if (same && old.kind === 'session' && old.tasks === tasks)
        return old
      return { ...node, tasks, children }
    })

    return { ...next, nodes: reuse(next.nodes), fingerprints: prints }
  }

  /**
   * The sessions these trees put on screen: every session node that no collapsed category or
   * project folds away. A session's own children are always drawn, so they count with it.
   */
  static drawnSessionIdsOf(results: readonly TreeResult[], collapsed: ReadonlySet<string>): ReadonlySet<string> {
    const drawn = new Set<string>()
    const walk = (nodes: readonly TreeNode[]): void => {
      for (const node of nodes)
        if (node.kind === 'session') {
          drawn.add(node.sessionId)
          walk(node.children)
        } else if (node.kind === 'category' || node.kind === 'project') {
          if (!collapsed.has(node.id)) walk(node.children)
        } else
          throw new Error(`Unknown tree node: ${JSON.stringify(node satisfies never)}`)
    }
    for (const result of results)
      walk(result.nodes)
    return drawn
  }

  /** Where `fingerprints` keeps the print of a session node's task rows. */
  static tasksPrintKeyOf(nodeId: string): string {
    return `${nodeId}#tasks`
  }

  private static ownPrintOf(node: TreeNode): string {
    if (node.kind === 'session') {
      const { children: _subtree, tasks: _tasks, ...own } = node
      return JSON.stringify(own)
    }
    const { children: _subtree, ...own } = node
    return JSON.stringify(own)
  }

  private static sameNodes(left: readonly TreeNode[], right: readonly TreeNode[]): boolean {
    if (left.length !== right.length)
      return false
    return left.every((node, index) => node === right[index])
  }
}
