import type { FileChangesVcsId } from '../../../../lib-orchestrator/fileChangesManager/fileChangesManagerApi.types'
import type { ProjectBinding } from '../../../../lib-orchestrator/projectManager/projectManagerApi.types'
import type {
  SessionAgentId,
  SessionColorName,
  SessionInfo,
  SessionOutcome,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { PathText } from '../../../shared/pathText'
import { SessionsFilterState, type SessionFilterStatus, type SessionsFilterValue } from '../../../shared/sessionsFilterState'
import { type TerminalTarget, TerminalTargetCodec } from '../../../shared/terminalTarget'
import { FinalizeAsks } from '../../overlays/finalize/finalizeModel'
import {
  type SessionAction,
  type SessionMergeBadge,
  type SessionGlyph,
  SessionNodeState,
  type SessionLaunchBadge,
  type SessionSetupBadge,
} from './sessionNodeState'

/** `null` diff = nothing has measured this worktree yet; zero changes is a measurement, absence is not. */
export interface WorktreeBadge {
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
  /** A turn settled or a runtime exited while the person was looking somewhere else. */
  attention: boolean
  /**
   * Which VCS says this session's working copy has uncommitted work, or null for none - either
   * because it is clean, or because nothing has measured it yet. The two are the same to a row:
   * an unmeasured directory draws nothing rather than claiming to be clean.
   */
  vcs: FileChangesVcsId | null
  /** Drawn only where a tree carries tabs, and there a row's kind is the thing to tell apart. */
  plainTab: boolean
  completed: boolean
}

export type TreeNode =
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
      /** The name of the colour this session was given, or null. The row paints itself with it. */
      color: SessionColorName | null
      glyph: SessionGlyph
      badges: SessionBadges
      setup: SessionSetupBadge | null
      /** A launch the Host keeps refusing, or null while nothing is holding one up. */
      launch: SessionLaunchBadge | null
      /** What the launch word says when it is pointed at, or null where there is no word. */
      launchTitle: string | null
      merge: SessionMergeBadge | null
      /** What the merge word says when it is pointed at, or null where there is no word. */
      mergeTitle: string | null
      /** What that badge says when it is pointed at: the commands, or why nothing ran. */
      setupTitle: string | null
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
      /**
       * The install sessions that ran for this one. A session's dependencies being installed is
       * something that happened TO it, so it is drawn under it rather than beside it, where it would
       * read as a second session the user started and does not recognise.
       */
      children: readonly TreeNode[]
    }

/**
 * Which rows this tree is built out of. It is an argument rather than a stored choice: the panel
 * draws either one tree of both kinds or two trees of one kind each, so what a tree contains is a
 * property of that build and not a state anything switches.
 */
export type TreeContent = 'sessions' | 'tabs' | 'both'
export type TreeStateGroup = 'attention' | 'unread' | 'running' | 'read'

export interface TreeViewState {
  filters: SessionsFilterValue
  content: TreeContent
  filterText: string
  stateGroup?: TreeStateGroup
  /**
   * The sessions visible workspace windows have a tab in front for. Only the `attention` filter
   * reads it, and only to keep such a row on the list: opening a session is what TAKES its mark, so
   * under that filter the act of looking at a row removed it from under the cursor, mid-gesture.
   */
  inFront: ReadonlySet<string>
  /**
   * When this build is happening, for the one filter that asks how long ago a session closed. An
   * argument rather than a clock the model reads, so the build stays pure and its tests name the
   * moment. Whatever rebuilds the tree refreshes it - a snapshot poll, a filter change - so a
   * session leaves the window at the next rebuild rather than on the exact minute.
   */
  now: number
}

export interface TreeResult {
  nodes: readonly TreeNode[]
  emptyState: 'none' | 'noSessions' | 'noMatch'
  /**
   * What each node looked like when this result was built, by node id, so the next build compares
   * one string per node instead of serializing both sides again.
   */
  fingerprints: ReadonlyMap<string, string>
}

interface SessionEntry {
  info: SessionInfo
  badges: SessionBadges
  searchText: string
  targetKey: string
}

export interface SessionsTreeBuildOptions {
  namespace: string
  target: { kind: 'local' } | { kind: 'remote'; remoteEndpointId: string }
  operationScope: 'local' | 'remote'
  interactive: boolean
  allowLocalPaths: boolean
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
  static readonly groupsConst = [
    { key: 'attention', title: 'Needs attention' },
    { key: 'unread', title: 'Idle unread' },
    { key: 'running', title: 'Running' },
    { key: 'read', title: 'Read' },
  ] as const satisfies readonly { key: TreeStateGroup; title: string }[]
  private static readonly adHocRootConst = 'root:adhoc'
  private static readonly noProjectRootConst = 'root:none'

  static build(
    snapshot: SessionsSnapshot,
    view: TreeViewState,
    marks: ReadonlySet<string>,
    previous: TreeResult | null,
    options: SessionsTreeBuildOptions = SessionsTreeModel.localOptions(),
    commitOpen: ReadonlySet<string> = new Set(),
  ): TreeResult {
    if (snapshot.sessions.length === 0)
      return { nodes: [], emptyState: 'noSessions', fingerprints: new Map() }
    const entries = snapshot.sessions.map((info) => SessionsTreeModel.entryOf(info, marks, options, commitOpen))
    const matching = entries.filter((entry) => SessionsTreeModel.matches(entry, view))
    if (matching.length === 0)
      return { nodes: [], emptyState: 'noMatch', fingerprints: new Map() }

    const installs = SessionsTreeModel.installsByParent(matching)
    const nested = new Set([...installs.values()].flat().map((entry) => entry.info.sessionId))
    const roots = matching.filter((entry) => !nested.has(entry.info.sessionId))
    const nodes = SessionsTreeModel.decorate(
      SessionsTreeModel.rootNodes(roots, installs, snapshot, options),
      options,
    )
    return SessionsTreeModel.withIdentity(previous, {
      nodes,
      emptyState: 'none',
      fingerprints: new Map(),
    })
  }

  private static entryOf(
    info: SessionInfo,
    marks: ReadonlySet<string>,
    options: SessionsTreeBuildOptions,
    commitOpen: ReadonlySet<string>,
  ): SessionEntry {
    const target = SessionsTreeModel.targetOf(info.sessionId, options)
    const targetKey = TerminalTargetCodec.key(target)
    const badges: SessionBadges = {
      commitOpen: options.target.kind === 'local' && commitOpen.has(info.sessionId),
      agentId: info.agent?.agentId ?? null,
      worktree: info.worktree
        ? {
            branch: info.worktree.branch,
            diff: info.worktree.diff
              ? {
                  added: info.worktree.diff.added,
                  removed: info.worktree.diff.removed,
                }
              : null,
            baseMoved: info.worktree.baseMoved,
          }
        : null,
      vcs: info.vcs?.dirty === true ? info.vcs.vcsId : null,
      attention: marks.has(targetKey),
      plainTab: info.presentation === 'tab',
      completed: info.completed === true,
    }
    const searchText = [
      info.title,
      info.agent?.agentId ?? '',
      SessionsTreeModel.projectTextOf(info.project),
    ].join(' ').toLowerCase()
    return { info, badges, searchText, targetKey }
  }

  private static inContent(entry: SessionEntry, content: TreeContent): boolean {
    if (content === 'sessions') return !entry.badges.plainTab
    else if (content === 'tabs') return entry.badges.plainTab
    else if (content === 'both') return true
    else
      throw new Error(`Unknown tree content: ${JSON.stringify(content)}`)
  }

  private static matches(entry: SessionEntry, view: TreeViewState): boolean {
    if (!SessionsTreeModel.inContent(entry, view.content)) return false
    if (view.stateGroup !== undefined && SessionsTreeModel.stateGroupOf(entry) !== view.stateGroup) return false
    const text = view.filterText.trim().toLowerCase()
    if (text.length > 0 && !entry.searchText.includes(text))
      return false
    const { colors, agents, states } = view.filters
    if (colors.length > 0 && !colors.includes(entry.info.color ?? null)) return false
    if (agents.length > 0 && !agents.includes(entry.badges.agentId)) return false
    return states.length === 0 || states.some((state) => SessionsTreeModel.inState(entry, state, view))
  }

  private static stateGroupOf(entry: SessionEntry): TreeStateGroup {
    const info = entry.info
    const glyph = SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail)
    switch (glyph) {
      case 'waiting': return 'attention'
      case 'starting':
      case 'working':
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
    const glyph = SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail)
    switch (state) {
      case 'active': return !entry.badges.completed
      // Viewing a marked row takes its mark; retain it so a double-click cannot open the next row.
      case 'attention': return entry.badges.attention || view.inFront.has(entry.targetKey)
      case 'running': return glyph === 'working' || glyph === 'background' || glyph === 'shell'
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
   * Which sessions belong under which, among the ones that survived the filter. Two things nest for
   * the same reason and are read the same way: an install prepares a session, and a resolver settles
   * one's merge. Both happened TO the row above them rather than beside it.
   *
   * A hidden parent does not hide its child: the child is drawn where its own directory puts it
   * instead, because a tree that answers "show me what is running" must not lose a running session
   * to its parent.
   */
  private static installsByParent(entries: readonly SessionEntry[]): Map<string, SessionEntry[]> {
    const byId = new Map(entries.map((entry) => [entry.info.sessionId, entry]))
    const installs = new Map<string, SessionEntry[]>()
    for (const entry of entries) {
      const parentId = SessionsTreeModel.parentOf(entry)
      if (parentId === undefined || parentId === entry.info.sessionId)
        continue
      const parent = byId.get(parentId)
      // A child of a child is not something the session manager writes. Refusing the second hop is
      // what keeps a hand-edited record from folding two sessions into each other, where both would
      // leave the roots and neither would be drawn.
      if (!parent || SessionsTreeModel.parentOf(parent) !== undefined)
        continue
      installs.set(parentId, [...(installs.get(parentId) ?? []), entry])
    }
    return installs
  }

  /** A session is either preparing another or resolving another's merge, and never both. */
  private static parentOf(entry: SessionEntry): string | undefined {
    return entry.info.setupFor ?? entry.info.resolveFor
  }

  private static rootNodes(
    roots: readonly SessionEntry[],
    installs: ReadonlyMap<string, readonly SessionEntry[]>,
    snapshot: SessionsSnapshot,
    options: SessionsTreeBuildOptions,
  ): readonly TreeNode[] {
    const categories = new Map<string, CategoryGroup>()
    const adHoc = new Map<string, ProjectGroup>()
    const loose: SessionEntry[] = []

    for (const entry of roots) {
      const binding = entry.info.project
      if (binding.kind === 'project')
        SessionsTreeModel.push(
          SessionsTreeModel.categoryOf(categories, binding.categoryId, snapshot).projects,
          `category:${binding.categoryId}`,
          { path: binding.projectPath, label: binding.projectName, launch: binding },
          entry,
        )
      else if (binding.kind === 'adHoc')
        SessionsTreeModel.push(
          adHoc,
          SessionsTreeModel.adHocRootConst,
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
        SessionsTreeModel.projectNodes(group.projects, installs, options),
      ))
    if (adHoc.size > 0)
      nodes.push(SessionsTreeModel.categoryNode(
        SessionsTreeModel.adHocRootConst,
        'AD-HOC',
        null,
        SessionsTreeModel.projectNodes(adHoc, installs, options),
      ))
    if (loose.length > 0)
      nodes.push(SessionsTreeModel.categoryNode(
        SessionsTreeModel.noProjectRootConst,
        'NO PROJECT',
        null,
        SessionsTreeModel.sessionNodes(loose, installs, options),
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
    projects.set(key, { ...seed, id: `project:${rootId}/${key}`, entries: [entry] })
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
    installs: ReadonlyMap<string, readonly SessionEntry[]>,
    options: SessionsTreeBuildOptions,
  ): readonly TreeNode[] {
    return [...projects.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((project): TreeNode => ({
        kind: 'project',
        id: project.id,
        label: project.label,
        path: project.path,
        launch: project.launch,
        // The first one the tree draws, so the folder actions do not change what they prove with
        // whenever the entries happen to be gathered in another order.
        folderSessionId: SessionsTreeModel.sorted(project.entries)[0].info.sessionId,
        children: SessionsTreeModel.sessionNodes(project.entries, installs, options),
      }))
  }

  private static categoryNode(
    id: string,
    label: string,
    categoryId: string | null,
    children: readonly TreeNode[],
  ): TreeNode {
    return { kind: 'category', id, label, categoryId, children }
  }

  /** Sorted by what the user reads, so a row does not move when a random session id sorts elsewhere. */
  private static sessionNodes(
    entries: readonly SessionEntry[],
    installs: ReadonlyMap<string, readonly SessionEntry[]>,
    options: SessionsTreeBuildOptions,
  ): readonly TreeNode[] {
    return SessionsTreeModel.sorted(entries).map((entry) => SessionsTreeModel.sessionNode(
      entry,
      // One hop, matching the one hop `installsByParent` attaches: an install has no installs.
      SessionsTreeModel.sorted(installs.get(entry.info.sessionId) ?? [])
        .map((install) => SessionsTreeModel.sessionNode(install, [], options)),
      options,
    ))
  }

  private static sorted(entries: readonly SessionEntry[]): readonly SessionEntry[] {
    return [...entries].sort((left, right) => left.info.title.localeCompare(right.info.title)
      || left.info.sessionId.localeCompare(right.info.sessionId))
  }

  private static sessionNode(
    entry: SessionEntry,
    children: readonly TreeNode[],
    options: SessionsTreeBuildOptions,
  ): TreeNode {
    const info = entry.info
    const target = SessionsTreeModel.targetOf(info.sessionId, options)
    const ask = FinalizeAsks.of(info, target, options.operationScope)
    const actions = SessionsTreeModel.scopedActions(
      SessionNodeState.actionsOf(info, ask !== null),
      options,
    )
    return {
      kind: 'session',
      id: `session:${info.sessionId}`,
      target,
      operationScope: options.operationScope,
      interactive: options.interactive,
      sessionId: info.sessionId,
      title: info.title,
      tabTitle: info.tabTitle,
      note: info.note ?? null,
      color: info.color ?? null,
      glyph: SessionNodeState.glyphOf(info.life, info.kind, info.activity, info.activityDetail),
      badges: entry.badges,
      setup: SessionNodeState.setupBadgeOf(info.setup),
      setupTitle: SessionNodeState.setupTitleOf(info.setup),
      launch: SessionNodeState.launchBadgeOf(info.launchWait),
      launchTitle: SessionNodeState.launchTitleOf(info.launchWait),
      actions,
      finalizeLabel: actions.includes('finalize') ? SessionNodeState.finalizeLabelOf(info.life) : null,
      live: SessionNodeState.isLive(info.life),
      merge: SessionNodeState.mergeBadgeOf(info.merge),
      mergeTitle: SessionNodeState.mergeTitleOf(info.merge),
      endedAt: info.endedAt ?? null,
      outcome: info.outcome ?? null,
      exitCode: info.exitCode ?? null,
      endedReason: info.endedReason ?? null,
      children,
    }
  }

  private static decorate(
    nodes: readonly TreeNode[],
    options: SessionsTreeBuildOptions,
  ): readonly TreeNode[] {
    return nodes.map((node): TreeNode => {
      const id = options.namespace.length === 0 ? node.id : `${options.namespace}/${node.id}`
      const children = SessionsTreeModel.decorate(node.children, options)
      if (node.kind === 'category')
        return {
          ...node,
          id,
          categoryId: options.allowLocalPaths ? node.categoryId : null,
          children,
        }
      else if (node.kind === 'project')
        return {
          ...node,
          id,
          launch: options.allowLocalPaths ? node.launch : null,
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

  /** Remote control exposes only rerun and finalize; the catalog still decides remote finalize. */
  private static scopedActions(
    actions: readonly SessionAction[],
    options: SessionsTreeBuildOptions,
  ): readonly SessionAction[] {
    if (!options.interactive) return []
    if (options.operationScope === 'local') return actions
    else if (options.operationScope === 'remote')
      return actions.filter((action) => action === 'reopen' || action === 'finalize')
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

    const reuse = (nodes: readonly TreeNode[]): readonly TreeNode[] => nodes.map((node) => {
      const children = reuse(node.children)
      // A node prints its OWN fields only. Its subtree is already decided by the children the line
      // above returned, so comparing their identity is both cheaper and exact - serializing the
      // subtree again would re-walk every session under every category, per tick.
      const { children: _subtree, ...own } = node
      const print = JSON.stringify(own)
      prints.set(node.id, print)
      const old = byId.get(node.id)
      if (old && old.kind === node.kind && before.get(node.id) === print
        && SessionsTreeModel.sameNodes(old.children, children))
        return old
      return { ...node, children }
    })

    return { ...next, nodes: reuse(next.nodes), fingerprints: prints }
  }

  private static sameNodes(left: readonly TreeNode[], right: readonly TreeNode[]): boolean {
    if (left.length !== right.length)
      return false
    return left.every((node, index) => node === right[index])
  }
}
