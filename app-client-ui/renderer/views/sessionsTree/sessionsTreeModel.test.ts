import type { SessionGroup } from '../../../shared/sessionsGroupsState'
import { SessionsFilterState, type SessionFilterStatus } from '../../../shared/sessionsFilterState'
import { describe, expect, it } from 'vitest'

import type { SessionInfo, SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import type {
  SessionShellRow,
  SessionSubagentRow,
  SessionTaskListing,
  SessionTaskRow,
} from '../../../../lib-orchestrator/sessionTasks/sessionTasksApi.types'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import {
  SessionsTreeModel,
  type SessionsTreeBuildOptions,
  type TaskRowRef,
  type TreeNode,
  type TreeResult,
  type TreeViewState,
} from './sessionsTreeModel'

describe('app-client-ui/renderer/views/sessionsTree/sessionsTreeModel', () => {
  const noMarks: ReadonlySet<string> = new Set()
  /** Nothing is in front unless a test says so; only the `attention` filter reads it. */
  const noneInFront: ReadonlySet<string> = new Set()
  const noneTabbed: ReadonlySet<string> = new Set()
  type ViewUnderTest =
    Omit<TreeViewState, 'inFront' | 'tabbed' | 'now'>
    & { inFront?: ReadonlySet<string>; tabbed?: ReadonlySet<string>; now?: number }
  /** The moment every build happens at unless a test names another one. */
  const nowConst = 1_754_400_000_000
  const hourConst = 60 * 60 * 1_000
  const all: ViewUnderTest = { filters: SessionsFilterState.allConst, filterText: '' }

  function build(
    snapshot: SessionsSnapshot,
    view: ViewUnderTest = all,
    marks: ReadonlySet<string> = noMarks,
    previous: TreeResult | null = null,
    options?: SessionsTreeBuildOptions,
  ): TreeResult {
    return SessionsTreeModel.build(
      SessionsFixtures.present(snapshot),
      { inFront: noneInFront, tabbed: noneTabbed, now: nowConst, ...view },
      marks,
      previous,
      options,
    )
  }

  function lookup(nodes: readonly TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id)
        return node
      const inside = lookup(node.children, id)
      if (inside)
        return inside
    }
    return null
  }

  function find(nodes: readonly TreeNode[], id: string): TreeNode {
    const found = lookup(nodes, id)
    if (!found)
      throw new Error(`No node ${id} in ${JSON.stringify(everyId(nodes))}`)
    return found
  }

  function everyId(nodes: readonly TreeNode[]): string[] {
    const out: string[] = []
    const walk = (list: readonly TreeNode[]): void => {
      for (const node of list) {
        out.push(node.id)
        walk(node.children)
      }
    }
    walk(nodes)
    return out
  }

  function titles(node: TreeNode): string[] {
    return node.children.map((child) => child.kind === 'session' ? child.title : child.label)
  }

  it('partitions sessions and retains their shared project in both groups', () => {
    const snapshot = SessionsFixtures.mixed()
    const assignments = new Map<string, SessionGroup>([['session:s-working', 'pinned']])
    const pinned = build(snapshot, { ...all, assignments, group: 'pinned' })
    const rest = build(snapshot, { ...all, assignments, group: 'none' })
    expect(everyId(pinned.nodes).filter((id) => id.startsWith('session:'))).toEqual(['session:s-working'])
    expect(lookup(rest.nodes, 'session:s-working')).toBeNull()
    expect(lookup(rest.nodes, 'session:s-waiting')).not.toBeNull()
    expect(pinned.nodes[0].children[0].id).toBe(rest.nodes[0].children[0].id)
    expect(build(snapshot, { ...all, assignments: new Map(), group: 'pinned' }).nodes).toEqual([])
  })

  it('pins whole roots and normalized directories, including new sessions and plain tabs', () => {
    const snapshot = SessionsFixtures.mixed()
    const project = build(snapshot).nodes[0].children[0]
    for (const key of [project.id, 'category:nodejs']) {
      const assignments = new Map<string, SessionGroup>([[key, 'pinned']])
      const next = { ...snapshot, sessions: [...snapshot.sessions,
        { ...snapshot.sessions.find((session) => session.sessionId === 's-working')!, sessionId: 'new' }] }
      const pinned = build(next, { ...all, assignments, group: 'pinned' })
      expect(everyId(pinned.nodes)).toContain('session:new')
      expect(everyId(pinned.nodes)).toContain('session:s-tab')
      expect(pinned.nodes.map((node) => node.id)).toEqual(['category:nodejs'])
      expect(build(next, { ...all, assignments, group: 'none' }).nodes.map((node) => node.id))
        .not.toContain('category:nodejs')
    }
    const pinned = build(snapshot, { ...all, assignments: new Map([['project:root:adhoc/q:/scratch', 'pinned']]), group: 'pinned' })
    expect(everyId(pinned.nodes).filter((id) => id.startsWith('session:')))
      .toEqual(['session:s-adhoc', 'session:s-adhoc-cased'])
  })

  it('files a run in its parent group whatever its own assignment says, and still applies filters', () => {
    const source = SessionsFixtures.mixed()
    const parent = source.sessions.find((session) => session.sessionId === 's-working')!
    const child: SessionInfo = {
      ...parent, sessionId: 'child', script: { parentId: parent.sessionId, phase: 'before', scriptId: 'setup' },
    }
    const snapshot = { ...source, sessions: [parent, child] }
    const assignments = new Map<string, SessionGroup>([['session:child', 'pinned']])
    expect(build(snapshot, { ...all, assignments, group: 'pinned' }).emptyState).toBe('noMatch')
    const rest = build(snapshot, { ...all, assignments, group: 'none' })
    expect(find(rest.nodes, 'session:s-working').children.map((node) => node.id)).toEqual(['session:child'])
    expect(build(snapshot, { ...all, assignments, group: 'none', filterText: 'missing' }).nodes).toEqual([])
  })

  // The observed case: the scheduler files its sessions in an automation group, and the install it
  // starts for one has no group at all. It used to be a root of the default section.
  it('nests an install without a group under its parent in the parent group, and roots it nowhere', () => {
    const snapshot = SessionsFixtures.setupPending()
    const assignments = new Map<string, SessionGroup>([['session:s-primary', 'automation']])
    const grouped = build(snapshot, { ...all, assignments, group: 'automation' })
    const rest = build(snapshot, { ...all, assignments, group: 'none' })

    expect(titles(find(grouped.nodes, 'session:s-primary'))).toEqual(['Setup alpha'])
    expect(everyId(rest.nodes)).not.toContain('session:s-install')
    expect(everyId(rest.nodes)).toContain('session:s-neighbour')
  })

  it('files an ended install under a starting parent in Running, never in Needs attention', () => {
    const source = SessionsFixtures.setupPending()
    const snapshot: SessionsSnapshot = { ...source, sessions: source.sessions.map((session) => session.sessionId === 's-install'
      ? { ...session, life: 'ended' as const, outcome: 'failed' as const, exitCode: 1, endedAt: 1754319100000 }
      : session) }
    const running = build(snapshot, { ...all, stateGroup: 'running' })
    const attention = build(snapshot, { ...all, stateGroup: 'attention' })

    expect(titles(find(running.nodes, 'session:s-primary'))).toEqual(['Setup alpha'])
    expect(everyId(attention.nodes)).not.toContain('session:s-install')
  })

  it('uses session then project then root assignments, including new sessions', () => {
    const source = SessionsFixtures.mixed()
    const base = source.sessions.find((session) => session.sessionId === 's-working')!
    const projectKey = build(source).nodes[0].children[0].id
    const snapshot = { ...source, sessions: [base, { ...base, sessionId: 'new' }, { ...base, sessionId: 'exception' }] }
    const assignments = new Map<string, SessionGroup>([
      ['category:nodejs', 'blocked'], [projectKey, 'priority'], ['session:exception', 'waiting'],
    ])
    const members = (group: SessionGroup): string[] => everyId(build(snapshot, { ...all, assignments, group }).nodes)
      .filter((id) => id.startsWith('session:'))
    expect(members('priority')).toEqual(['session:new', 'session:s-working'])
    expect(members('none')).toEqual([])
    expect(members('waiting')).toEqual(['session:exception'])
    expect(members('blocked')).toEqual([])
    const tree = build(snapshot, { ...all, assignments })
    expect(find(tree.nodes, 'category:nodejs').group).toBe('blocked')
    expect(find(tree.nodes, projectKey).group).toBe('priority')
    expect(find(tree.nodes, 'session:s-working').group).toBe('priority')
    assignments.delete(projectKey)
    expect(members('blocked')).toEqual(['session:new', 'session:s-working'])
    expect(members('none')).toEqual([])
    expect(build(snapshot, { ...all, assignments, group: 'waiting', filterText: 'missing' }).nodes).toEqual([])
  })

  it('matches lifecycle and work state independently of stale activity on ended sessions', () => {
    const source = SessionsFixtures.mixed()
    const base = source.sessions.find((session) => session.sessionId === 's-working')!
    const cases: readonly [string, Partial<SessionInfo>][] = [
      ['working', {}], ['background', { activityDetail: 'background' }],
      ['compacting', { compacting: true }],
      ['question', { activity: 'waiting' }], ['idle', { activity: 'idle' }],
      ['starting', { life: 'starting' }], ['unknown', { activity: 'unknown' }],
      ['ended', { life: 'ended' }], ['lost', { life: 'lost' }],
      ['completed', { life: 'ended', completed: true }],
      ['shell', { kind: 'shell', agent: undefined, activity: null }],
    ]
    const snapshot = { ...source, sessions: cases.map(([sessionId, over]) => ({ ...base, sessionId, ...over })) }
    const wanted: Record<SessionFilterStatus, readonly string[]> = {
      active: ['working', 'background', 'compacting', 'question', 'idle', 'starting', 'unknown', 'ended', 'lost', 'shell'],
      attention: ['idle'], running: ['working', 'background', 'compacting', 'shell'], question: ['question'],
      idle: ['idle'], starting: ['starting'], background: ['background'], ended: ['ended', 'completed'],
      lost: ['lost'], completed: ['completed'], unknown: ['unknown'],
      // None of these carries an end time, and that is the answer: a record with no `endedAt` has
      // not closed, whatever its life says.
      closedRecently: [],
    }
    for (const state of Object.keys(wanted) as SessionFilterStatus[]) {
      const result = build(snapshot, { ...all, filters: { ...all.filters, states: [state] } }, new Set(['idle']))
      expect(everyId(result.nodes).filter((id) => id.startsWith('session:')).sort(), state)
        .toEqual(wanted[state].map((id) => `session:${id}`).sort())
    }
    const grouped = {
      attention: ['question', 'unknown', 'ended', 'lost'],
      unread: ['idle'],
      running: ['working', 'background', 'compacting', 'starting', 'shell'],
      read: ['completed'],
    }
    for (const group of SessionsTreeModel.groupsConst) {
      const result = build(snapshot, { ...all, stateGroup: group.key }, new Set(['idle']))
      expect(everyId(result.nodes).filter((id) => id.startsWith('session:')).sort(), group.title)
        .toEqual(grouped[group.key].map((id) => `session:${id}`).sort())
    }
    expect(everyId(build(snapshot, { ...all, stateGroup: 'read' }).nodes)
      .filter((id) => id.startsWith('session:')).sort()).toEqual(['session:completed', 'session:idle'])
    expect(build(snapshot, { ...all, stateGroup: 'unread' }).nodes).toEqual([])
  })

  it('keeps only the sessions that closed inside the window, the finished ones included', () => {
    const source = SessionsFixtures.mixed()
    const base = source.sessions.find((session) => session.sessionId === 's-working')!
    const cases: readonly [string, Partial<SessionInfo>][] = [
      ['closed-recently', { life: 'ended', endedAt: nowConst - hourConst }],
      ['closed-and-finished', { life: 'ended', completed: true, endedAt: nowConst - hourConst }],
      // The far edge of the window is inside it; one millisecond past it is not.
      ['closed-at-the-edge', { life: 'ended', endedAt: nowConst - SessionsFilterState.closedWithinMsConst }],
      ['closed-too-long-ago', { life: 'ended', endedAt: nowConst - SessionsFilterState.closedWithinMsConst - 1 }],
      ['still-running', {}],
    ]
    const snapshot = { ...source, sessions: cases.map(([sessionId, over]) => ({ ...base, sessionId, ...over })) }
    const result = build(snapshot, { ...all, now: nowConst, filters: SessionsFilterState.closedRecentlyConst })
    expect(everyId(result.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:closed-and-finished', 'session:closed-at-the-edge', 'session:closed-recently'])
  })

  it('keeps matching children when their parent is filtered away and treats None as uncolored only', () => {
    const source = SessionsFixtures.setupPending()
    const snapshot = { ...source, sessions: source.sessions.map((session) => ({
      ...session, color: session.script === undefined ? 'red' as const : 'blue' as const,
    })) }
    const result = build(snapshot, { ...all, filters: { ...all.filters, colors: ['blue'] } })
    expect(everyId(result.nodes).filter((id) => id.startsWith('session:')))
      .toEqual(snapshot.sessions.filter((session) => session.script !== undefined).map((session) => `session:${session.sessionId}`))
    expect(build(snapshot, { ...all, filters: { ...all.filters, colors: [null] } }).emptyState).toBe('noMatch')
  })

  it('roots the tree in catalog order, then AD-HOC, then NO PROJECT', () => {
    const result = build(SessionsFixtures.mixed())

    expect(result.nodes.map((node) => node.id)).toEqual([
      'category:nodejs',
      'category:web',
      'root:adhoc',
      'root:none',
    ])
    expect(result.nodes.map((node) => node.kind === 'category' ? node.label : ''))
      .toEqual(['NodeJs', 'Web', 'AD-HOC', 'NO PROJECT'])
  })

  it('draws no category for a catalog root with no session records', () => {
    const mixed = SessionsFixtures.mixed()
    const webOnly: SessionsSnapshot = {
      ...mixed,
      sessions: mixed.sessions.filter((session) => session.sessionId.startsWith('s-e')
        || session.sessionId === 's-lost'),
    }

    expect(build(webOnly).nodes.map((node) => node.id)).toEqual(['category:web'])
  })

  it('gives an ad-hoc directory its own project row and folds the same path written twice', () => {
    const adHoc = find(build(SessionsFixtures.mixed()).nodes, 'root:adhoc')

    expect(adHoc.children).toHaveLength(1)
    const project = adHoc.children[0]
    if (project.kind !== 'project')
      throw new Error('AD-HOC drew no project row')
    expect(project.label).toBe('Scratch')
    expect(project.path).toBe('Q:/Scratch')
    expect(titles(project)).toEqual(['Scratch shell', 'Scratch shell two'])
  })

  it('carries the launch binding of a catalog project, and none for an ad-hoc directory', () => {
    const nodes = build(SessionsFixtures.mixed()).nodes
    const project = find(nodes, 'project:category:nodejs/c:/projects/nodejs/appjamatv3')
    const adHoc = find(nodes, 'root:adhoc').children[0]
    if (project.kind !== 'project' || adHoc?.kind !== 'project')
      throw new Error('The mixed fixture drew no project rows')

    expect(project.launch).toEqual({
      kind: 'project',
      categoryId: 'nodejs',
      projectName: 'AppJamatV3',
      projectPath: 'C:/Projects/NodeJs/AppJamatV3',
    })
    // An ad-hoc path has no category, and the launcher intent carries a category or nothing.
    expect(adHoc.launch).toBe(null)
  })

  /**
   * What a right-click on a root row can start something with. The two roots the catalog does not
   * name carry null rather than their own row id: `root:adhoc` is not a category anything can be
   * opened in, and a null is what stops the menu offering to.
   */
  it('names the catalog category on a root row, and none on AD-HOC or NO PROJECT', () => {
    const nodes = build(SessionsFixtures.mixed()).nodes
    const categoryIds = nodes.map((node) => node.kind === 'category' ? node.categoryId : 'not a root')

    expect(categoryIds).toEqual(['nodejs', 'web', null, null])
  })

  /**
   * A project row's folder actions are proved against a session of that row, and the row exists only
   * because sessions were found in it - so there is always one, and it is the first one drawn.
   */
  it('hands a project row one of its own sessions to prove its folder with', () => {
    const nodes = build(SessionsFixtures.mixed()).nodes
    const project = find(nodes, 'project:category:nodejs/c:/projects/nodejs/appjamatv3')
    if (project.kind !== 'project')
      throw new Error('The mixed fixture drew no project row')

    const own = project.children
      .filter((child) => child.kind === 'session')
      .map((child) => child.sessionId)
    expect(own).toContain(project.folderSessionId)
    expect(project.folderSessionId).toBe(own[0])
  })

  describe('SVN worktree sessions', () => {
    function sessionNode(id: string): Extract<TreeNode, { kind: 'session' }> {
      const node = find(build(SessionsFixtures.svnWorktrees()).nodes, `session:${id}`)
      if (node.kind !== 'session') throw new Error(`${id} is not a session node`)
      return node
    }

    it('marks an SVN worktree with its kind and checkout, and names it in the tooltip', () => {
      const node = sessionNode('s-svn')

      expect(node.badges.worktree).toMatchObject({
        kind: 'svn',
        path: 'C:/Projects/NodeJs/AppJamatV3/.worktrees/014-svn-worktree',
        branch: 'http://svn.local/applications/AppJamatV3',
        finish: null,
        outcome: null,
      })
      expect(node.worktreeLine).toBe('SVN worktree C:/Projects/NodeJs/AppJamatV3/.worktrees/014-svn-worktree')
    })

    it('shows the scope a review waits for, and no outcome while a finish runs', () => {
      const node = sessionNode('s-reviewing')

      expect(node.badges.worktree?.finish).toEqual({
        phase: 'reviewing',
        title: 'Waiting for the commit review of C:/Projects/NodeJs/AppJamatV3/.worktrees/015-reviewing',
      })
      expect(node.badges.worktree?.outcome).toBeNull()
      expect(node.finalizeLabel).toBeNull()
    })

    it('shows how many changes a partial commit left', () => {
      const outcome = sessionNode('s-partial').badges.worktree?.outcome

      expect(outcome?.result).toBe('partial')
      expect(outcome?.title).toContain('left 2 change(s)')
    })

    it('tells the person after UPDATED to reopen the session or press Finish again', () => {
      const outcome = sessionNode('s-updated').badges.worktree?.outcome

      expect(outcome?.result).toBe('updated')
      expect(outcome?.title)
        .toContain('Reopen the session to rerun the tests, or press Finish again')
    })

    it('says why a worktree outlived its session on the row and in the tooltip', () => {
      const fixture = SessionsFixtures.svnWorktrees()
      const unlanded = 'r4127 is not in the main copy; Finish brings it in and removes the worktree'
      const snapshot = {
        ...fixture,
        sessions: fixture.sessions.map((session) => {
          if (session.sessionId === 's-svn' && session.worktree)
            return { ...session, worktree: { ...session.worktree, cleanup: { phase: 'pending' as const, reason: 'unlanded r4127: a.ts', summary: unlanded } } }
          if (session.sessionId === 's-partial' && session.worktree)
            return { ...session, worktree: { ...session.worktree, cleanup: { phase: 'pending' as const, summary: 'removed once the session has ended' } } }
          return session
        }),
      }
      const nodes = build(snapshot).nodes
      const svn = find(nodes, 'session:s-svn')
      const partial = find(nodes, 'session:s-partial')
      if (svn.kind !== 'session' || partial.kind !== 'session') throw new Error('not session nodes')

      expect(svn.badges.worktree?.cleanup).toEqual({ phase: 'pending', title: unlanded })
      expect(svn.worktreeLine).toBe(`SVN worktree C:/Projects/NodeJs/AppJamatV3/.worktrees/014-svn-worktree; ${unlanded}`)
      expect(partial.badges.worktree?.cleanup).toBeNull()
      expect(partial.worktreeLine).toContain('; removed once the session has ended')
    })

    it('copies the step the library composed onto the node, and null where it sent none', () => {
      expect(sessionNode('s-removing').step).toEqual({
        text: 'Removing the worktree',
        detail: '12,000 of 48,000 files',
        progress: { done: 12000, total: 48000 },
        startedAt: 1754600400000,
      })
      expect(sessionNode('s-finishing').step?.detail).toBe('svn log -v --xml -r4513:HEAD')
      expect(sessionNode('s-svn').step).toBeNull()
    })

    it('hands a new object only to the row whose step moved and to its ancestors', () => {
      const fixture = SessionsFixtures.svnWorktrees()
      const first = build(fixture)
      const moved: SessionsSnapshot = {
        ...fixture,
        revision: fixture.revision + 1,
        sessions: fixture.sessions.map((session) => session.sessionId === 's-removing' && session.step
          ? { ...session, step: { ...session.step, detail: '24,000 of 48,000 files', progress: { done: 24000, total: 48000 } } }
          : session),
      }
      const second = build(moved, all, noMarks, first)
      const projectId = 'project:category:nodejs/c:/projects/nodejs/appjamatv3'

      const removing = find(second.nodes, 'session:s-removing')
      expect(removing).not.toBe(find(first.nodes, 'session:s-removing'))
      expect(removing.kind === 'session' ? removing.step?.progress : null).toEqual({ done: 24000, total: 48000 })
      expect(find(second.nodes, projectId)).not.toBe(find(first.nodes, projectId))
      expect(find(second.nodes, 'category:nodejs')).not.toBe(find(first.nodes, 'category:nodejs'))
      expect(find(second.nodes, 'session:s-finishing')).toBe(find(first.nodes, 'session:s-finishing'))
      expect(find(second.nodes, 'session:s-svn')).toBe(find(first.nodes, 'session:s-svn'))
    })

    it('names where the work of a removed worktree went', () => {
      const node = sessionNode('s-retired')

      expect(node.badges.worktree).toBeNull()
      expect(node.worktreeLine).toBe(
        'Worktree C:/Projects/NodeJs/AppJamatV3/.worktrees/013-retired removed after '
          + 'http://svn.local/applications:r4119',
      )
    })
  })

  it('draws NO PROJECT flat, with the session straight under the root', () => {
    const none = find(build(SessionsFixtures.mixed()).nodes, 'root:none')

    expect(none.children.map((node) => node.kind)).toEqual(['session'])
    expect(titles(none)).toEqual(['Home claude'])
  })

  it('carries the worktree badge, the exit code and the reason a session ended', () => {
    const nodes = build(SessionsFixtures.mixed()).nodes
    const working = find(nodes, 'session:s-working')
    const waiting = find(nodes, 'session:s-waiting')
    const ended = find(nodes, 'session:s-ended')
    const lost = find(nodes, 'session:s-lost')
    if (working.kind !== 'session' || waiting.kind !== 'session'
      || ended.kind !== 'session' || lost.kind !== 'session')
      throw new Error('The fixture sessions are not session nodes')

    expect(working.badges.worktree)
      .toEqual({
        kind: 'git',
        path: 'C:/Projects/NodeJs/AppJamatV3/.worktrees/alpha',
        branch: 'feature/alpha',
        finish: null,
        outcome: null,
        needs: null,
        cleanup: null,
      })
    expect(working.badges.agentId).toBe('claude')
    expect(ended.exitCode).toBe(1)
    expect(ended.endedAt).toBe(1754200500000)
    expect(ended.glyph).toBe('ended')
    expect(lost.glyph).toBe('lost')
    expect(lost.exitCode).toBe(null)
    expect(lost.endedReason).toBe('no runtime answered for this record')
    expect(lost.actions).toEqual(['reopen', 'remove'])
  })

  it('draws background work as its own green-state glyph', () => {
    const mixed = SessionsFixtures.mixed()
    const snapshot: SessionsSnapshot = {
      ...mixed,
      sessions: mixed.sessions.map((session) => session.sessionId === 's-working'
        ? { ...session, activityDetail: 'background' as const }
        : session),
    }
    const working = find(build(snapshot).nodes, 'session:s-working')
    if (working.kind !== 'session') throw new Error('s-working is not a session node')

    expect(working.glyph).toBe('background')
  })

  it('carries the note onto the session node, and null where there is none', () => {
    const mixed = SessionsFixtures.mixed()
    const noted: SessionsSnapshot = {
      ...mixed,
      sessions: mixed.sessions.map((session) => session.sessionId === 's-working'
        ? { ...session, note: 'Waiting for the review' }
        : session),
    }
    const nodes = build(noted).nodes
    const working = find(nodes, 'session:s-working')
    const waiting = find(nodes, 'session:s-waiting')
    if (working.kind !== 'session' || waiting.kind !== 'session')
      throw new Error('The fixture sessions are not session nodes')

    expect(working.note).toBe('Waiting for the review')
    expect(waiting.note).toBe(null)
  })

  /**
   * The daily view is what has not been dealt with, and that is the person's verdict rather than
   * the Host's: a session a reboot interrupted and one that exited on its own both stay until they
   * are marked finished, and a session still running that somebody marked finished is gone from it.
   */
  it('keeps everything unfinished in active, whatever its life, and only that', () => {
    const active = build(SessionsFixtures.mixed(), { filters: { ...SessionsFilterState.allConst, states: ['active'] }, filterText: '' })

    expect(everyId(active.nodes)).toContain('session:s-ended')
    expect(everyId(active.nodes)).toContain('session:s-lost')
    expect(everyId(active.nodes)).toContain('session:s-working')
    expect(everyId(active.nodes)).not.toContain('session:s-done')
    // And `all` is the archive: the finished one is there too.
    expect(everyId(build(SessionsFixtures.mixed()).nodes)).toContain('session:s-done')
  })

  /**
   * The rule that keeps the tab bar and the tree agreeing. Finalizing a session does not close its
   * tab, so a completed session the person can still see has to keep a row to be reachable from.
   */
  it('keeps a session with an open tab whatever the state filter says, and only against that filter', () => {
    const activeOnly = { ...SessionsFilterState.allConst, states: ['active'] as const }
    const hidden = build(SessionsFixtures.mixed(), { filters: activeOnly, filterText: '' })
    expect(everyId(hidden.nodes)).not.toContain('session:s-done')

    // A local row is keyed by its session id, which is what the panel index reports for an open tab.
    const shown = build(SessionsFixtures.mixed(),
      { filters: activeOnly, filterText: '', tabbed: new Set(['s-done']) })
    expect(everyId(shown.nodes)).toContain('session:s-done')

    // Narrowing by text is the person asking to see less, and an open tab does not overrule it.
    const searched = build(SessionsFixtures.mixed(),
      { filters: activeOnly, filterText: 'zzz-matches-nothing', tabbed: new Set(['s-done']) })
    expect(everyId(searched.nodes)).not.toContain('session:s-done')
  })

  /**
   * The same open-tab fact the filter reads, carried on the row as well: Close is drawn on every
   * completed session, and only the badge says whether it has anything to close.
   */
  it('carries the open tab on the badge and offers close on a completed row alone', () => {
    const shown = build(SessionsFixtures.mixed(), { ...all, tabbed: new Set(['s-done']) })
    const done = find(shown.nodes, 'session:s-done')
    const working = find(shown.nodes, 'session:s-working')
    if (done.kind !== 'session' || working.kind !== 'session')
      throw new Error('the fixture sessions are not session nodes')

    expect(done.badges.tabbed).toBe(true)
    expect(done.badges.completed).toBe(true)
    expect(done.actions).toContain('close')
    expect(working.badges.tabbed).toBe(false)
    expect(working.actions).not.toContain('close')

    const withoutTab = find(build(SessionsFixtures.mixed()).nodes, 'session:s-done')
    if (withoutTab.kind !== 'session') throw new Error('s-done is not a session node')
    expect(withoutTab.badges.tabbed).toBe(false)
    expect(withoutTab.actions).toEqual(done.actions)
  })

  /** A remote session's tab is this computer's, so the remote narrowing has no reason to drop it. */
  it('keeps close on a remote completed row, where every library operation is narrowed away', () => {
    const options: SessionsTreeBuildOptions = {
      namespace: '',
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a' },
      operationScope: 'remote',
      interactive: true,
      allowLocalPaths: false,
    }
    const remote = find(
      build(SessionsFixtures.mixed(), all, noMarks, null, options).nodes,
      'session:s-done',
    )
    if (remote.kind !== 'session') throw new Error('the remote finished session drew no row')

    expect(remote.actions).toContain('close')
    expect(remote.actions).not.toContain('remove')
  })

  /** The one filter path: what a mode hides is the same wherever the row is drawn. */
  it('applies the filter mode to every row of the tree', () => {
    const active = everyId(build(SessionsFixtures.mixed(), {
      filters: { ...SessionsFilterState.allConst, states: ['active'] },
      filterText: '',
    }).nodes).filter((id) => id.startsWith('session:'))
    const byText = everyId(build(SessionsFixtures.mixed(), {
      filters: SessionsFilterState.allConst,
      filterText: 'scratch tab',
    }).nodes).filter((id) => id.startsWith('session:'))

    // `s-done` is finished business, so the mode takes it out; the text narrows to the one row.
    expect(active).not.toContain('session:s-done')
    expect(active).toContain('session:s-tab')
    expect(byText).toEqual(['session:s-tab'])
  })

  it('filters by text over the title, the agent and the project', () => {
    const byTitle = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, filterText: 'gamma' })
    const byProject = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, filterText: 'WebJamatAdmin' })
    const byAgent = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, filterText: 'codex' })

    expect(everyId(byTitle.nodes).filter((id) => id.startsWith('session:')))
      .toEqual(['session:s-shell'])
    expect(everyId(byProject.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-done', 'session:s-ended', 'session:s-lost'])
    expect(everyId(byAgent.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-ended', 'session:s-tab', 'session:s-waiting'])
  })

  it('shows only what is marked in attention, and nothing else', () => {
    const marks: ReadonlySet<string> = new Set(['s-waiting'])
    const result = build(SessionsFixtures.mixed(), { filters: { ...SessionsFilterState.allConst, states: ['attention'] }, filterText: '' }, marks)
    const waiting = find(result.nodes, 'session:s-waiting')
    if (waiting.kind !== 'session')
      throw new Error('s-waiting is not a session node')

    expect(everyId(result.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-waiting'])
    expect(waiting.badges).toMatchObject({ attention: true })
  })

  /**
   * The row being looked at stays, and it is what makes this filter usable rather than a widening
   * of it. Opening a session TAKES its mark, so the first click of a double-click used to delete its
   * own row: the row below slid up under the cursor and the second click pinned that session
   * instead. With one marked row the tree collapsed to "No session matches this filter." and the
   * promotion was swallowed whole.
   */
  it('keeps the session this window is looking at, whose mark opening it just took', () => {
    const marks: ReadonlySet<string> = new Set(['s-waiting'])
    const looking = { filters: { ...SessionsFilterState.allConst, states: ['attention' as const] }, filterText: '' }

    // The mark is gone, which is what opening it did, and nothing else is marked either.
    const dropped = build(SessionsFixtures.mixed(), looking, new Set())
    expect(dropped.emptyState).toBe('noMatch')

    const kept = build(
      SessionsFixtures.mixed(),
      { ...looking, inFront: new Set(['s-waiting']) },
      new Set(),
    )

    expect(everyId(kept.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-waiting'])
    // And it is still drawn as a row with nothing new on it: the filter keeps it, the badge does
    // not lie about it.
    const waiting = find(kept.nodes, 'session:s-waiting')
    if (waiting.kind !== 'session') throw new Error('s-waiting is not a session node')
    expect(waiting.badges).toMatchObject({ attention: false })

    // The marked rows are unaffected: this adds one row, it does not replace the answer.
    const both = build(
      SessionsFixtures.mixed(),
      { ...looking, inFront: new Set(['s-ended']) },
      marks,
    )
    expect(everyId(both.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-ended', 'session:s-waiting'])
  })

  it('answers noSessions with nothing recorded and noMatch when the filter hid it all', () => {
    const mixed = SessionsFixtures.mixed()

    expect(build({ ...mixed, sessions: [] }))
      .toEqual({ nodes: [], emptyState: 'noSessions', nextTaskExpiryAt: null, fingerprints: new Map() })
    expect(build(mixed, { filters: SessionsFilterState.allConst, filterText: 'nothing matches this' }).emptyState)
      .toBe('noMatch')
  })

  it('leaves an orphan out of the tree: it is a runtime, not a session record', () => {
    const mixed = SessionsFixtures.mixed()

    expect(mixed.orphans).toHaveLength(1)
    expect(everyId(build(mixed).nodes).join(' ')).not.toContain('orphan')
  })

  it('changes no node when the Host is unreachable: that is the Host state, not the sessions', () => {
    const unreachable = SessionsFixtures.hostUnreachable()
    const running: SessionsSnapshot = {
      ...unreachable,
      host: { ...unreachable.host, presence: 'running', hostVersion: '1', hostInstanceId: 'host-a' },
    }

    expect(build(unreachable)).toEqual(build(running))
    const working = find(build(unreachable).nodes, 'session:s-working')
    if (working.kind !== 'session')
      throw new Error('s-working is not a session node')
    expect(working.glyph).toBe('working')
    expect(working.actions).toEqual(['finalize'])
  })

  it('offers one dialog entry on a stopped worktree without reading its dirty fact', () => {
    const result = build(SessionsFixtures.stoppedWorktree())
    const dirty = find(result.nodes, 'session:s-dirty')
    const clean = find(result.nodes, 'session:s-clean')
    if (dirty.kind !== 'session' || clean.kind !== 'session')
      throw new Error('the stopped worktree sessions are not session nodes')

    expect(dirty.outcome).toBe('finished')
    expect(dirty.exitCode).toBe(-1073741510)
    expect(dirty.finalizeLabel).toBe('Finish…')
    expect(clean.finalizeLabel).toBe('Finish…')
    expect(dirty.actions).toEqual(['finalize', 'reopen', 'remove'])
    expect(clean.actions).toEqual(['finalize', 'reopen', 'remove'])
  })

  it('offers failed-install discard through the local dialog and omits it remotely', () => {
    const local = find(build(SessionsFixtures.setupOutcomes()).nodes, 'session:s-failed')
    const remoteOptions: SessionsTreeBuildOptions = {
      namespace: '',
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a' },
      operationScope: 'remote',
      interactive: true,
      allowLocalPaths: false,
    }
    const remote = find(
      build(SessionsFixtures.setupOutcomes(), all, noMarks, null, remoteOptions).nodes,
      'session:s-failed',
    )
    if (local.kind !== 'session' || remote.kind !== 'session')
      throw new Error('the failed setup did not draw session rows')

    expect(local.actions).toEqual(['finalize', 'retrySetup', 'remove'])
    expect(local.finalizeLabel).toBe('Finish…')
    expect(remote.actions).toEqual([])
    expect(remote.finalizeLabel).toBeNull()
  })

  it('builds remote finalize from the remote catalog scope', () => {
    const options: SessionsTreeBuildOptions = {
      namespace: '',
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a' },
      operationScope: 'remote',
      interactive: true,
      allowLocalPaths: false,
    }
    const remote = find(
      build(SessionsFixtures.stoppedWorktree(), all, noMarks, null, options).nodes,
      'session:s-dirty',
    )
    if (remote.kind !== 'session') throw new Error('the remote worktree did not draw a session row')

    expect(remote.target).toEqual({
      kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-dirty',
    })
    expect(remote.operationScope).toBe('remote')
    expect(remote.actions).toEqual(['finalize', 'reopen'])
    expect(remote.finalizeLabel).toBe('Finish…')
  })

  // Nothing marked it completed, so the daily view keeps it: the merge is still owed.
  it('keeps a stopped worktree session in the daily view until its ending is chosen', () => {
    const result = build(
      SessionsFixtures.stoppedWorktree(),
      { filters: { ...SessionsFilterState.allConst, states: ['active'] }, filterText: '' },
    )

    expect(find(result.nodes, 'session:s-dirty').kind).toBe('session')
  })

  /** A row that offers no Finish has no label for one, and a null is what says so. */
  it('leaves the finish label off a row that offers no finish', () => {
    const ended = find(build(SessionsFixtures.mixed()).nodes, 'session:s-ended')
    if (ended.kind !== 'session') throw new Error('s-ended is not a session node')

    expect(ended.actions).not.toContain('finalize')
    expect(ended.finalizeLabel).toBe(null)
  })

  it('draws an install under the session it installs for', () => {
    const result = build(SessionsFixtures.setupPending())
    const project = find(result.nodes, 'project:category:nodejs/c:/projects/nodejs/appjamatv3')
    const primary = find(result.nodes, 'session:s-primary')
    if (project.kind !== 'project' || primary.kind !== 'session')
      throw new Error('The setup fixture drew no project or no primary session')

    expect(titles(project)).toEqual(['Alpha worktree', 'Zulu shell'])
    expect(titles(primary)).toEqual(['Setup alpha'])
    expect(primary.glyph).toBe('starting')
  })

  it('draws the library badge, the waiting run and the run list off the snapshot', () => {
    const result = build(SessionsFixtures.setupPending())
    const primary = find(result.nodes, 'session:s-primary')
    const install = find(result.nodes, 'session:s-install')
    if (primary.kind !== 'session' || install.kind !== 'session') throw new Error('no session nodes')
    const open = { target: { kind: 'local', sessionId: 's-install' }, tabTitle: 'AppJamatV3 - Setup alpha' }

    expect(primary.scriptsBadge).toEqual({
      phase: 'before', state: 'running', text: 'installing dependencies',
      title: 'Installing dependencies:\npnpm install', runId: 's-install', open, logRunId: null,
    })
    expect(primary.waitingOn).toEqual(open)
    expect(primary.filedWithParent).toBe(false)
    expect(install.filedWithParent).toBe(true)
    expect(install.scriptsBadge).toBe(null)
    expect(install.waitingOn).toBe(null)
  })

  it('draws no row for a run or a step that the Session actions item draws', () => {
    const fixture = SessionsFixtures.setupPending()
    const held: SessionsSnapshot = {
      ...fixture,
      sessions: fixture.sessions.map((session) => session.sessionId !== 's-primary' ? session : {
        ...session,
        step: { text: 'Removing the worktree', detail: '12,000 of 48,000 files', progress: { done: 12000, total: 48000 }, startedAt: 1 },
        actions: { sections: [{ kind: 'before', workflowId: 'setup:s-primary', title: 'Setup', badge: '', summary: 'Installing',
          open: true, actions: [], rounds: [{ title: 'Setup', steps: [
            { key: 'install', title: 'Install', state: 'running', detail: '', startedAt: 1, endedAt: null, target: { kind: 'run', runId: 's-install' } },
            { key: 'remove', title: 'Remove', state: 'running', detail: '', startedAt: 1, endedAt: null, target: { kind: 'none' } },
          ] }] }] },
      }),
    }
    const local = build(held)
    const primary = find(local.nodes, 'session:s-primary')
    if (primary.kind !== 'session') throw new Error('no session node')

    expect(lookup(local.nodes, 'session:s-install')).toBeNull()
    expect(primary.step).toBeNull()
    expect(primary.actionsMark).toEqual({ text: 'actions running', title: 'Installing', waiting: false })
  })

  it('gives a succeeded badge and the history no terminal to open, and the badge its saved log', () => {
    const installed = find(build(SessionsFixtures.setupCollapsed()).nodes, 'session:s-installed')
    if (installed.kind !== 'session') throw new Error('no session node')

    expect(installed.scriptsBadge?.text).toBe('setup ✓ 23.6 s')
    expect(installed.scriptsBadge?.open).toBe(null)
    expect(installed.scriptsBadge?.logRunId).toBe('r-second')
    expect(installed.waitingOn).toBe(null)
    expect(installed.children).toEqual([])
  })

  it('opens a remote run on the computer that runs it', () => {
    const options: SessionsTreeBuildOptions = {
      namespace: 'remote:endpoint-a',
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a' },
      operationScope: 'remote',
      interactive: true,
      allowLocalPaths: false,
    }
    const primary = find(build(SessionsFixtures.setupPending(), all, noMarks, null, options).nodes, 'remote:endpoint-a/session:s-primary')
    if (primary.kind !== 'session') throw new Error('no session node')

    expect(primary.waitingOn?.target).toEqual({ kind: 'remote', remoteEndpointId: 'endpoint-a', sessionId: 's-install' })
  })

  it('keeps the source saved-run identity on a remote succeeded badge', () => {
    const options: SessionsTreeBuildOptions = {
      namespace: 'remote:endpoint-a',
      target: { kind: 'remote', remoteEndpointId: 'endpoint-a' },
      operationScope: 'remote',
      interactive: true,
      allowLocalPaths: false,
    }
    const installed = find(build(SessionsFixtures.setupCollapsed(), all, noMarks, null, options).nodes, 'remote:endpoint-a/session:s-installed')
    if (installed.kind !== 'session') throw new Error('no session node')

    expect(installed.scriptsBadge).toMatchObject({ state: 'succeeded', open: null, logRunId: 'r-second' })
  })

  it('draws an install on its own once its session is filtered away', () => {
    const result = build(SessionsFixtures.setupPending(), { filters: SessionsFilterState.allConst, filterText: 'setup' })
    const install = find(result.nodes, 'session:s-install')

    expect(everyId(result.nodes).filter((id) => id.startsWith('session:')))
      .toEqual(['session:s-install'])
    expect(install.children).toEqual([])
  })

  it('names both outcomes an install can leave behind', () => {
    const result = build(SessionsFixtures.setupOutcomes())
    const skipped = find(result.nodes, 'session:s-skipped')
    const failed = find(result.nodes, 'session:s-failed')
    if (skipped.kind !== 'session' || failed.kind !== 'session')
      throw new Error('The outcome fixture drew no session nodes')

    expect(skipped.scriptsBadge).toMatchObject({ state: 'skipped', text: 'setup skipped', open: null })
    expect(skipped.glyph).toBe('idle')
    expect(failed.scriptsBadge).toMatchObject({
      state: 'failed', text: 'setup failed', title: 'The setup session exited with 1',
      open: { target: { kind: 'local', sessionId: 's-failed-install' }, tabTitle: 'AppJamatV3 - Setup beta' },
    })
    expect(failed.glyph).toBe('ended')
    expect(titles(failed)).toEqual(['Setup beta'])
  })

  it('hands back the same object for every node a tick did not move', () => {
    const first = build(SessionsFixtures.mixed())
    const mixed = SessionsFixtures.mixed()
    const moved: SessionsSnapshot = {
      ...mixed,
      revision: mixed.revision + 1,
      sessions: mixed.sessions.map((session) => session.sessionId === 's-working'
        ? { ...session, activity: 'waiting' as const }
        : session),
    }
    const second = build(moved, all, noMarks, first)

    const before = (result: TreeResult, id: string): TreeNode => find(result.nodes, id)
    // The moved node and its two ancestors are new; nothing else is.
    expect(before(second, 'session:s-working')).not.toBe(before(first, 'session:s-working'))
    expect(before(second, 'project:category:nodejs/c:/projects/nodejs/appjamatv3'))
      .not.toBe(before(first, 'project:category:nodejs/c:/projects/nodejs/appjamatv3'))
    expect(before(second, 'category:nodejs')).not.toBe(before(first, 'category:nodejs'))
    expect(before(second, 'session:s-waiting')).toBe(before(first, 'session:s-waiting'))
    expect(before(second, 'session:s-shell')).toBe(before(first, 'session:s-shell'))
    expect(before(second, 'category:web')).toBe(before(first, 'category:web'))
    expect(before(second, 'root:adhoc')).toBe(before(first, 'root:adhoc'))
  })

  it('hands back the very same nodes when nothing moved at all', () => {
    const first = build(SessionsFixtures.mixed())
    const second = build(SessionsFixtures.mixed(), all, noMarks, first)

    for (const id of everyId(second.nodes))
      expect(find(second.nodes, id)).toBe(find(first.nodes, id))
  })

  describe('session children', () => {
    const source = SessionsFixtures.mixed()
    const { worktree: _worktree, ...plain } = source.sessions.find((session) => session.sessionId === 's-working')!
    const elsewhere = source.sessions.find((session) => session.sessionId === 's-lost')!
    const projectId = 'project:category:nodejs/c:/projects/nodejs/appjamatv3'

    function session(sessionId: string, fields: Partial<SessionInfo> = {}): SessionInfo {
      return { ...plain, sessionId, title: sessionId, tabTitle: `AppJamatV3 - ${sessionId}`, activity: 'idle', ...fields }
    }

    function childOf(
      parentId: string,
      kind: NonNullable<SessionInfo['parent']>['kind'] = 'worktree',
      sameProject = true,
    ): Pick<SessionInfo, 'parent'> {
      return { parent: { sessionId: parentId, kind, sameProject } }
    }

    function snapshotOf(...sessions: SessionInfo[]): SessionsSnapshot {
      return { ...source, sessions }
    }

    function sessionIdsUnder(nodes: readonly TreeNode[], id: string): string[] {
      return find(nodes, id).children.map((node) => node.id)
    }

    it('draws a worktree child of the same project under its parent, filed with it', () => {
      const result = build(snapshotOf(session('P'), session('C', childOf('P'))))
      const child = find(result.nodes, 'session:C')
      if (child.kind !== 'session') throw new Error('no child node')

      expect(sessionIdsUnder(result.nodes, projectId)).toEqual(['session:P'])
      expect(sessionIdsUnder(result.nodes, 'session:P')).toEqual(['session:C'])
      expect(child.filedWithParent).toBe(true)
    })

    it('keeps a ticket child of another project a root under that project', () => {
      const result = build(snapshotOf(
        session('P'),
        session('C', { ...childOf('P', 'ticket', false), directory: elsewhere.directory, project: elsewhere.project }),
      ))
      const child = find(result.nodes, 'session:C')
      if (child.kind !== 'session') throw new Error('no child node')

      expect(sessionIdsUnder(result.nodes, 'session:P')).toEqual([])
      expect(sessionIdsUnder(result.nodes, 'project:category:web/c:/projects/web/webjamatadmin')).toEqual(['session:C'])
      expect(child.filedWithParent).toBe(false)
    })

    it('keeps the setup run of a child under the child, and the child under its parent', () => {
      const result = build(snapshotOf(
        session('P'),
        session('C', childOf('P')),
        session('R', { kind: 'shell', script: { parentId: 'C', phase: 'before', scriptId: 'setup' } }),
      ))

      expect(sessionIdsUnder(result.nodes, projectId)).toEqual(['session:P'])
      expect(sessionIdsUnder(result.nodes, 'session:P')).toEqual(['session:C'])
      expect(sessionIdsUnder(result.nodes, 'session:C')).toEqual(['session:R'])
    })

    it('draws a child of a nested child as a root: one hop', () => {
      const result = build(snapshotOf(session('P'), session('C', childOf('P')), session('G', childOf('C'))))

      expect(sessionIdsUnder(result.nodes, projectId)).toEqual(['session:G', 'session:P'])
      expect(sessionIdsUnder(result.nodes, 'session:P')).toEqual(['session:C'])
      expect(sessionIdsUnder(result.nodes, 'session:G')).toEqual([])
    })

    it('files the family under its most urgent live member, and an ended child does not count', () => {
      const waiting = snapshotOf(session('P'), session('C', { ...childOf('P'), activity: 'waiting' }))
      const attention = build(waiting, { ...all, stateGroup: 'attention' })

      expect(sessionIdsUnder(attention.nodes, projectId)).toEqual(['session:P'])
      expect(sessionIdsUnder(attention.nodes, 'session:P')).toEqual(['session:C'])
      expect(build(waiting, { ...all, stateGroup: 'read' }).emptyState).toBe('noMatch')

      const ended = snapshotOf(session('P'), session('C', {
        ...childOf('P'), life: 'ended', outcome: 'interrupted', activity: 'unknown', endedAt: nowConst - hourConst,
      }))
      expect(build(ended, { ...all, stateGroup: 'attention' }).emptyState).toBe('noMatch')
      expect(sessionIdsUnder(build(ended, { ...all, stateGroup: 'read' }).nodes, 'session:P')).toEqual(['session:C'])
    })

    it('files a run of a waiting child with the family, two hops up', () => {
      const snapshot = snapshotOf(
        session('P'),
        session('C', { ...childOf('P'), activity: 'waiting' }),
        session('R', { kind: 'shell', activity: 'working', script: { parentId: 'C', phase: 'before', scriptId: 'setup' } }),
      )

      expect(sessionIdsUnder(build(snapshot, { ...all, stateGroup: 'attention' }).nodes, 'session:C')).toEqual(['session:R'])
      expect(build(snapshot, { ...all, stateGroup: 'running' }).emptyState).toBe('noMatch')
    })

    it('files a child in its parent group whatever its own assignment says', () => {
      const snapshot = snapshotOf(session('P'), session('C', childOf('P')))
      const assignments = new Map<string, SessionGroup>([['session:P', 'pinned'], ['session:C', 'automation']])

      expect(sessionIdsUnder(build(snapshot, { ...all, assignments, group: 'pinned' }).nodes, 'session:P')).toEqual(['session:C'])
      expect(build(snapshot, { ...all, assignments, group: 'automation' }).emptyState).toBe('noMatch')
    })

    it('draws a child as a root once its parent is removed or filtered away', () => {
      const removed = build(snapshotOf(session('C', childOf('P', 'worktree', false))))
      const unlisted = build(snapshotOf(session('C', childOf('P'))))
      const hidden = build(snapshotOf(session('P'), session('C', { ...childOf('P'), title: 'Quokka' })), { ...all, filterText: 'quokka' })

      for (const result of [removed, unlisted, hidden])
        expect(sessionIdsUnder(result.nodes, projectId)).toEqual(['session:C'])
    })

    it('draws each kind of child as a root once its own Settings toggle is off, and only that kind', () => {
      const snapshot = snapshotOf(
        session('P'),
        session('W', childOf('P', 'worktree')),
        session('T', childOf('P', 'ticket')),
        session('K', childOf('P', 'worker')),
      )
      const nested = SessionsTreeModel.nestedConst
      const cases = [
        [{ ...nested, worktrees: false }, 'session:W'],
        [{ ...nested, tickets: false }, 'session:T'],
        [{ ...nested, subagents: false }, 'session:K'],
      ] as const

      expect(sessionIdsUnder(build(snapshot, { ...all, nesting: nested }).nodes, 'session:P'))
        .toEqual(['session:K', 'session:T', 'session:W'])
      for (const [nesting, root] of cases) {
        const result = build(snapshot, { ...all, nesting })
        const node = find(result.nodes, root)
        if (node.kind !== 'session') throw new Error(`no node ${root}`)
        expect(sessionIdsUnder(result.nodes, projectId)).toEqual(['session:P', root].sort())
        expect(sessionIdsUnder(result.nodes, 'session:P')).not.toContain(root)
        expect(sessionIdsUnder(result.nodes, 'session:P')).toHaveLength(2)
        expect(node.filedWithParent).toBe(false)
      }
    })

    it('rebuilds the tree when only a toggle changed, and gives the parent its child back when it is on again', () => {
      const snapshot = snapshotOf(session('P'), session('C', childOf('P')))
      const first = build(snapshot)
      const off = build(snapshot, { ...all, nesting: { ...SessionsTreeModel.nestedConst, worktrees: false } }, noMarks, first)
      const on = build(snapshot, { ...all, nesting: SessionsTreeModel.nestedConst }, noMarks, off)

      expect(sessionIdsUnder(first.nodes, 'session:P')).toEqual(['session:C'])
      expect(sessionIdsUnder(off.nodes, projectId)).toEqual(['session:C', 'session:P'])
      expect(find(off.nodes, 'session:P')).not.toBe(find(first.nodes, 'session:P'))
      expect(sessionIdsUnder(on.nodes, 'session:P')).toEqual(['session:C'])
    })

    it('reads the Settings toggles as nested unless a key is false', () => {
      expect(SessionsTreeModel.nestingOf({})).toEqual({ subagents: true, worktrees: true, tickets: true })
      expect(SessionsTreeModel.nestingOf({ sessionsNestSubagents: false, sessionsNestTickets: true }))
        .toEqual({ subagents: false, worktrees: true, tickets: true })
    })

    describe('a run follows the filters that keep its parent', () => {
      const { agent: _agent, color: _color, ...shell } = session('R')

      function runOf(sessionId: string, parentId: string, fields: Partial<SessionInfo> = {}): SessionInfo {
        return {
          ...shell, sessionId, title: sessionId, kind: 'shell', life: 'live', activity: 'working',
          script: { parentId, phase: 'inner', scriptId: 'requested' }, ...fields,
        }
      }

      function withFilters(filters: Partial<TreeViewState['filters']>, filterText = ''): ViewUnderTest {
        return { ...all, filterText, filters: { ...all.filters, ...filters } }
      }

      it('draws an uncoloured run under a blue parent, and neither under a red one', () => {
        const blue = snapshotOf(session('P', { color: 'blue' }), runOf('R', 'P'))
        const red = snapshotOf(session('P', { color: 'red' }), runOf('R', 'P'))

        expect(sessionIdsUnder(build(blue, withFilters({ colors: ['blue'] })).nodes, 'session:P')).toEqual(['session:R'])
        expect(build(red, withFilters({ colors: ['blue'] })).emptyState).toBe('noMatch')
      })

      it('draws a run with no agent under a Claude parent', () => {
        const snapshot = snapshotOf(session('P'), runOf('R', 'P'))

        expect(sessionIdsUnder(build(snapshot, withFilters({ agents: ['claude'] })).nodes, 'session:P')).toEqual(['session:R'])
        expect(build(snapshot, withFilters({ agents: ['codex'] })).emptyState).toBe('noMatch')
      })

      it('draws a starting run under a running parent', () => {
        const snapshot = snapshotOf(session('P', { activity: 'working' }), runOf('R', 'P', { life: 'starting', activity: null }))

        expect(sessionIdsUnder(build(snapshot, withFilters({ states: ['running'] })).nodes, 'session:P')).toEqual(['session:R'])
      })

      it('draws a running run under a parent that closed recently', () => {
        const snapshot = snapshotOf(
          session('P', { life: 'ended', outcome: 'interrupted', activity: 'unknown', endedAt: nowConst - hourConst }),
          runOf('R', 'P'),
        )

        expect(sessionIdsUnder(build(snapshot, withFilters({ states: ['closedRecently'] })).nodes, 'session:P'))
          .toEqual(['session:R'])
      })

      it('draws a run under a parent the text keeps, and as a root where only the run matches', () => {
        const snapshot = snapshotOf(session('P', { title: 'Wombat' }), runOf('R', 'P', { title: 'Quokka' }))
        const byParent = build(snapshot, withFilters({}, 'wombat'))
        const byRun = build(snapshot, withFilters({}, 'quokka'))

        expect(sessionIdsUnder(byParent.nodes, 'session:P')).toEqual(['session:R'])
        expect(lookup(byRun.nodes, 'session:P')).toBeNull()
        expect(sessionIdsUnder(byRun.nodes, projectId)).toEqual(['session:R'])
      })

      it('keeps a session child that does not match hidden under a parent that does', () => {
        const snapshot = snapshotOf(session('P', { title: 'Wombat' }), session('C', childOf('P')))
        const result = build(snapshot, withFilters({}, 'wombat'))

        expect(sessionIdsUnder(result.nodes, 'session:P')).toEqual([])
        expect(lookup(result.nodes, 'session:C')).toBeNull()
      })
    })

    it('draws both sessions of a hand-edited cycle as roots', () => {
      const result = build(snapshotOf(session('A', childOf('B')), session('B', childOf('A')), session('S', childOf('S'))))

      expect(sessionIdsUnder(result.nodes, projectId)).toEqual(['session:A', 'session:B', 'session:S'])
      expect(everyId(result.nodes).filter((id) => id.startsWith('session:'))).toHaveLength(3)
    })
  })

  describe('task rows', () => {
    function subagent(subagentId: string, fields: Partial<SessionSubagentRow> = {}): SessionSubagentRow {
      return {
        kind: 'subagent',
        subagentId,
        agentType: 'Explore',
        description: `Agent ${subagentId}`,
        depth: 1,
        parentSubagentId: null,
        state: 'running',
        startedAt: 1_000,
        endedAt: null,
        model: null,
        step: 'Bash pnpm test',
        ...fields,
      }
    }

    function shell(shellId: string, fields: Partial<SessionShellRow> = {}): SessionShellRow {
      return {
        kind: 'shell',
        shellId,
        command: 'ping -n 20 127.0.0.1',
        description: 'Ping the loopback',
        state: 'running',
        startedAt: 1_000,
        endedAt: null,
        ...fields,
      }
    }

    function listing(rows: readonly SessionTaskRow[], olderFinished = 0): SessionTaskListing {
      return { kind: 'tasks', rows, olderFinished, catchingUp: false }
    }

    function idOf(task: TaskRowRef): string {
      switch (task.kind) {
        case 'subagent': return task.subagentId
        case 'shell': return task.shellId
        default: throw new Error(`Unknown task: ${JSON.stringify(task satisfies never)}`)
      }
    }

    function buildWith(
      tasks: ReadonlyMap<string, SessionTaskListing>,
      previous: TreeResult | null = null,
      options?: SessionsTreeBuildOptions,
      view: ViewUnderTest = all,
      snapshot: SessionsSnapshot = SessionsFixtures.mixed(),
    ): TreeResult {
      return SessionsTreeModel.build(
        snapshot,
        { inFront: noneInFront, tabbed: noneTabbed, now: nowConst, ...view },
        noMarks,
        previous,
        options,
        new Set(),
        tasks,
      )
    }

    function sessionOf(result: TreeResult, id: string): Extract<TreeNode, { kind: 'session' }> {
      const node = find(result.nodes, id)
      if (node.kind !== 'session') throw new Error(`${id} is not a session node`)
      return node
    }

    it('keeps recent finished rows and puts a depth-2 row under its depth-1 row', () => {
      const result = buildWith(new Map([['s-working', listing([
        subagent('a1'),
        subagent('a2', { state: 'done', step: null, endedAt: nowConst - 2_000 }),
        subagent('b1', { depth: 2, parentSubagentId: 'a3' }),
        subagent('a3'),
        subagent('a4', { state: 'failed', step: null, endedAt: nowConst - 2_000 }),
      ], 3)]]))

      const tasks = sessionOf(result, 'session:s-working').tasks
      expect(tasks?.placement).toBe('nested')
      expect(tasks?.rows.map((row) => [idOf(row.task), row.depth])).toEqual([['a1', 1], ['a2', 1], ['a3', 1], ['b1', 2], ['a4', 1]])
      expect(tasks?.rows.map((row) => idOf(row.task))).toEqual(['a1', 'a2', 'a3', 'b1', 'a4'])
      expect(tasks?.rows.length).toBe(5)
      expect(tasks?.rows[0]).toMatchObject({
        sessionId: 's-working', label: 'Explore', description: 'Agent a1', detail: 'Bash pnpm test', state: 'running',
      })
    })

    it('places the rows beside the session with its number once Nest sub-agents is off', () => {
      const source = SessionsFixtures.mixed()
      const snapshot = { ...source, sessions: source.sessions.map((info) => info.sessionId === 's-working'
        ? { ...info, titleParts: { number: '018', name: info.titleParts.name } }
        : info) }
      const tasks = new Map([['s-working', listing([subagent('a1'), shell('b1', { state: 'done', endedAt: 2_000 })])]])
      const nested = buildWith(tasks, null, undefined, all, snapshot)
      const beside = buildWith(tasks, nested, undefined, { ...all, nesting: { ...SessionsTreeModel.nestedConst, subagents: false } }, snapshot)
      const tasksKey = SessionsTreeModel.tasksPrintKeyOf('session:s-working')

      expect(sessionOf(nested, 'session:s-working').tasks).toMatchObject({ placement: 'nested', numberPrefix: null })
      expect(sessionOf(beside, 'session:s-working').tasks).toMatchObject({ placement: 'beside', numberPrefix: '018' })
      expect(sessionOf(beside, 'session:s-working').tasks?.rows.map((row) => idOf(row.task))).toEqual(['a1'])
      expect(beside.fingerprints.get(tasksKey)).not.toBe(nested.fingerprints.get(tasksKey))
      expect(sessionOf(beside, 'session:s-waiting')).toBe(sessionOf(nested, 'session:s-waiting'))
    })

    it('draws a shell as `$ <command>` with its description, never under a sub-agent', () => {
      const result = buildWith(new Map([['s-working', listing([
        subagent('a1'),
        shell('b1', { state: 'running' }),
        shell('b2', { state: 'killed', endedAt: nowConst - 2_000, description: null }),
      ])]]))

      const tasks = sessionOf(result, 'session:s-working').tasks
      expect(tasks?.rows.map((row) => idOf(row.task))).toEqual(['a1', 'b1', 'b2'])
      expect(tasks?.rows[1]).toEqual({
        id: 'task:s-working:shell:b1',
        sessionId: 's-working',
        task: { kind: 'shell', shellId: 'b1' },
        label: '$ ping -n 20 127.0.0.1',
        description: 'Ping the loopback',
        detail: null,
        state: 'running',
        depth: 1,
      })
      expect(tasks?.rows[2]).toMatchObject({ task: { kind: 'shell', shellId: 'b2' }, state: 'killed', description: '' })
    })

    it('builds no task rows for a session with no listing, a none listing or an empty one', () => {
      const result = buildWith(new Map<string, SessionTaskListing>([
        ['s-waiting', { kind: 'none', code: 'transcript-not-found', reason: 'no file' }],
        ['s-lost', listing([])],
      ]))

      expect(sessionOf(result, 'session:s-working').tasks).toBeNull()
      expect(sessionOf(result, 'session:s-waiting').tasks).toBeNull()
      expect(sessionOf(result, 'session:s-lost').tasks).toBeNull()
    })

    it('expires ended tasks at 5 seconds, keeps running and open tasks, and ignores unknown end times', () => {
      const tasks = new Map([['s-working', listing([
        subagent('running'),
        subagent('recent', { state: 'done', endedAt: nowConst - 2_000 }),
        subagent('boundary', { state: 'done', endedAt: nowConst - 5_000 }),
        subagent('old', { state: 'failed', endedAt: nowConst - 7_000 }),
        subagent('open', { state: 'done', endedAt: nowConst - 7_000 }),
        subagent('unknown', { state: 'unfinished' }),
        shell('open-unknown', { state: 'killed' }),
      ], 80)]])
      const openTaskKeys = new Set(['task:s-working:subagent:open', 'task:s-working:shell:open-unknown'])
      const result = buildWith(tasks, null, undefined, { ...all, openTaskKeys })
      expect(sessionOf(result, 'session:s-working').tasks?.rows.map((row) => idOf(row.task)))
        .toEqual(['running', 'recent', 'open', 'open-unknown'])
      expect(result.nextTaskExpiryAt).toBe(nowConst + 3_000)
      const expired = buildWith(tasks, result, undefined, { ...all, openTaskKeys, now: nowConst + 3_000 })
      expect(sessionOf(expired, 'session:s-working').tasks?.rows.map((row) => idOf(row.task)))
        .toEqual(['running', 'open', 'open-unknown'])
      expect(expired.nextTaskExpiryAt).toBeNull()
      const closed = buildWith(tasks, expired, undefined, { ...all, now: nowConst + 3_000 })
      expect(sessionOf(closed, 'session:s-working').tasks?.rows.map((row) => idOf(row.task))).toEqual(['running'])
    })

    it('places a running depth-2 child below its retained finished parent', () => {
      const result = buildWith(new Map([['s-working', listing([
        subagent('child', { depth: 2, parentSubagentId: 'parent' }),
        subagent('other'),
        subagent('parent', { state: 'done', endedAt: nowConst - 2_000 }),
      ])]]))
      expect(sessionOf(result, 'session:s-working').tasks?.rows.map((row) => idOf(row.task)))
        .toEqual(['other', 'parent', 'child'])
    })

    it('retains recent or open script history without trimming the menu history or failed record rows', () => {
      const source = SessionsFixtures.setupCollapsed()
      const parent = source.sessions.find((info) => info.sessionId === 's-installed')!
      const run = parent.scripts!.runs[0]!
      const snapshot = { ...source, sessions: [{ ...parent, scripts: { ...parent.scripts!, runs: [
        { ...run, runId: 'recent', endedAt: nowConst - 2_000 },
        { ...run, runId: 'old', endedAt: nowConst - 7_000 },
        { ...run, runId: 'open', endedAt: nowConst - 7_000 },
        { ...run, runId: 'unknown', endedAt: undefined },
        { ...run, runId: 'open-unknown', endedAt: undefined },
      ] } }] }
      const openTaskKeys = new Set(['task:s-installed:script:open', 'task:s-installed:script:open-unknown'])
      const result = build(snapshot, { ...all, openTaskKeys })
      const node = sessionOf(result, 'session:s-installed')
      expect(node.scriptHistoryRows.map((entry) => entry.runId)).toEqual(['recent', 'open', 'open-unknown'])
      expect(result.nextTaskExpiryAt).toBe(nowConst + 3_000)
      expect(sessionOf(build(SessionsFixtures.setupOutcomes()), 'session:s-failed-install')).toBeTruthy()
    })

    it('gives a new node to the session whose listing moved, and keeps every other session node', () => {
      const first = buildWith(new Map([['s-working', listing([subagent('a1')])], ['s-waiting', listing([subagent('w1')])]]))
      const second = buildWith(
        new Map([['s-working', listing([subagent('a1'), subagent('a2')])], ['s-waiting', listing([subagent('w1')])]]),
        first,
      )

      expect(sessionOf(second, 'session:s-working')).not.toBe(sessionOf(first, 'session:s-working'))
      const others = everyId(second.nodes).filter((id) => id.startsWith('session:') && id !== 'session:s-working')
      expect(others.length).toBeGreaterThan(3)
      for (const id of others)
        expect(find(second.nodes, id)).toBe(find(first.nodes, id))
      expect(sessionOf(second, 'session:s-waiting').tasks).toBe(sessionOf(first, 'session:s-waiting').tasks)
    })

    it('changes the tasks print and keeps the session print when only a step moved', () => {
      const first = buildWith(new Map([['s-working', listing([subagent('a1', { step: 'Read a.ts' })])]]))
      const second = buildWith(new Map([['s-working', listing([subagent('a1', { step: 'Read b.ts' })])]]), first)
      const tasksKey = SessionsTreeModel.tasksPrintKeyOf('session:s-working')

      expect(second.fingerprints.get('session:s-working')).toBe(first.fingerprints.get('session:s-working'))
      expect(second.fingerprints.get(tasksKey)).not.toBe(first.fingerprints.get(tasksKey))
      expect(sessionOf(second, 'session:s-working').tasks?.rows[0].detail).toBe('Read b.ts')
    })

    it('names the drawn sessions: filtered ones are not built, folded groups hold theirs back', () => {
      const active = build(SessionsFixtures.mixed(), { ...all, filters: SessionsFilterState.defaultConst })
      const drawn = SessionsTreeModel.drawnSessionIdsOf([active], new Set())
      expect(drawn.has('s-working')).toBe(true)
      expect(drawn.has('s-done')).toBe(false)

      const folded = SessionsTreeModel.drawnSessionIdsOf([build(SessionsFixtures.mixed())], new Set(['category:web']))
      expect(folded.has('s-done')).toBe(false)
      expect(folded.has('s-lost')).toBe(false)
      expect(folded.has('s-working')).toBe(true)
    })

    it('hands back the same session node when its listing arrives again unchanged', () => {
      const first = buildWith(new Map([['s-working', listing([subagent('a1')])]]))
      const second = buildWith(new Map([['s-working', listing([subagent('a1')])]]), first)

      expect(sessionOf(second, 'session:s-working')).toBe(sessionOf(first, 'session:s-working'))
    })

    it('builds task rows from the selected source listing on a remote snapshot', () => {
      const result = buildWith(new Map([['s-working', listing([subagent('a1')])]]), null, {
        namespace: 'remote:pc',
        target: { kind: 'remote', remoteEndpointId: 'pc' },
        operationScope: 'remote',
        interactive: true,
        allowLocalPaths: false,
      })
      const tasks: unknown[] = []
      const walk = (nodes: readonly TreeNode[]): void => {
        for (const node of nodes) {
          if (node.kind === 'session') tasks.push(node.tasks)
          walk(node.children)
        }
      }
      walk(result.nodes)

      expect(tasks.length).toBeGreaterThan(0)
      expect(tasks.filter((one) => one !== null)).toHaveLength(1)
      expect(tasks.find((one) => one !== null)).toMatchObject({ rows: [{ task: { kind: 'subagent', subagentId: 'a1' } }] })
    })
  })
})
