import { SessionsFilterState, type SessionFilterStatus } from '../../../shared/sessionsFilterState'
import { describe, expect, it } from 'vitest'

import type { SessionInfo, SessionsSnapshot } from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import {
  SessionsTreeModel,
  type SessionsTreeBuildOptions,
  type TreeContent,
  type TreeNode,
  type TreeResult,
  type TreeViewState,
} from './sessionsTreeModel'

describe('app-client-ui/renderer/views/sessionsTree/sessionsTreeModel', () => {
  const noMarks: ReadonlySet<string> = new Set()
  /** Nothing is in front unless a test says so; only the `attention` filter reads it. */
  const noneInFront: ReadonlySet<string> = new Set()
  type ViewUnderTest =
    Omit<TreeViewState, 'inFront' | 'now'> & { inFront?: ReadonlySet<string>; now?: number }
  /** The moment every build happens at unless a test names another one. */
  const nowConst = 1_754_400_000_000
  const hourConst = 60 * 60 * 1_000
  const all: ViewUnderTest = { filters: SessionsFilterState.allConst, content: 'sessions', filterText: '' }

  function build(
    snapshot: SessionsSnapshot,
    view: ViewUnderTest = all,
    marks: ReadonlySet<string> = noMarks,
    previous: TreeResult | null = null,
    options?: SessionsTreeBuildOptions,
  ): TreeResult {
    return SessionsTreeModel.build(
      snapshot,
      { inFront: noneInFront, now: nowConst, ...view },
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

  it('matches lifecycle and work state independently of stale activity on ended sessions', () => {
    const source = SessionsFixtures.mixed()
    const base = source.sessions.find((session) => session.sessionId === 's-working')!
    const cases: readonly [string, Partial<SessionInfo>][] = [
      ['working', {}], ['background', { activityDetail: 'background' }],
      ['question', { activity: 'waiting' }], ['idle', { activity: 'idle' }],
      ['starting', { life: 'starting' }], ['unknown', { activity: 'unknown' }],
      ['ended', { life: 'ended' }], ['lost', { life: 'lost' }],
      ['completed', { life: 'ended', completed: true }],
      ['shell', { kind: 'shell', agent: undefined, activity: null }],
    ]
    const snapshot = { ...source, sessions: cases.map(([sessionId, over]) => ({ ...base, sessionId, ...over })) }
    const wanted: Record<SessionFilterStatus, readonly string[]> = {
      active: ['working', 'background', 'question', 'idle', 'starting', 'unknown', 'ended', 'lost', 'shell'],
      attention: ['idle'], running: ['working', 'background', 'shell'], question: ['question'],
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
      running: ['working', 'background', 'starting', 'shell'],
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
      ...session, color: session.setupFor === undefined ? 'red' as const : 'blue' as const,
    })) }
    const result = build(snapshot, { ...all, filters: { ...all.filters, colors: ['blue'] } })
    expect(everyId(result.nodes).filter((id) => id.startsWith('session:')))
      .toEqual(snapshot.sessions.filter((session) => session.setupFor !== undefined).map((session) => `session:${session.sessionId}`))
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
      // `changedFiles` is deliberately NOT carried: the mark draws two numbers, and a third
      // that moves on its own is a tree rebuild nobody asked for.
      .toEqual({ branch: 'feature/alpha', diff: { added: 12, removed: 3 }, baseMoved: true })
    // Nothing has measured this worktree yet, which is not the same as no changes.
    expect(waiting.badges.worktree?.diff).toBe(null)
    expect(waiting.badges.worktree?.baseMoved).toBe(false)
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
    const active = build(SessionsFixtures.mixed(), { filters: { ...SessionsFilterState.allConst, states: ['active'] }, content: 'sessions', filterText: '' })

    expect(everyId(active.nodes)).toContain('session:s-ended')
    expect(everyId(active.nodes)).toContain('session:s-lost')
    expect(everyId(active.nodes)).toContain('session:s-working')
    expect(everyId(active.nodes)).not.toContain('session:s-done')
    // And `all` is the archive: the finished one is there too.
    expect(everyId(build(SessionsFixtures.mixed()).nodes)).toContain('session:s-done')
  })

  it('shows plain tabs only in a tree whose content asks for them', () => {
    const sessions = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content: 'sessions', filterText: '' })
    const tabs = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content: 'tabs', filterText: '' })
    const both = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content: 'both', filterText: '' })

    // Not even under `all`: the content picks the set, and the mode filters inside it.
    expect(everyId(sessions.nodes)).not.toContain('session:s-tab')
    expect(everyId(tabs.nodes).filter((id) => id.startsWith('session:'))).toEqual(['session:s-tab'])
    expect(everyId(both.nodes)).toContain('session:s-tab')
    expect(everyId(both.nodes)).toContain('session:s-working')
  })

  /** The one filter path, read three times: what a mode hides cannot depend on which tree asked. */
  it('applies the filter mode the same way whatever the tree contains', () => {
    const contents: readonly TreeContent[] = ['sessions', 'tabs', 'both']
    const active = contents.map((content) =>
      everyId(build(SessionsFixtures.mixed(), { filters: { ...SessionsFilterState.allConst, states: ['active'] }, content, filterText: '' }).nodes)
        .filter((id) => id.startsWith('session:')))
    const byText = contents.map((content) =>
      everyId(build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content, filterText: 'scratch tab' }).nodes)
        .filter((id) => id.startsWith('session:')))

    // `s-done` is finished business and `s-tab` is a plain tab: the mode takes the first out of all
    // three trees, and the content decides which of them the second is in at all.
    for (const ids of active)
      expect(ids).not.toContain('session:s-done')
    expect(active[0]).not.toContain('session:s-tab')
    expect(active[1]).toEqual(['session:s-tab'])
    expect(active[2]).toContain('session:s-tab')
    expect(byText).toEqual([[], ['session:s-tab'], ['session:s-tab']])
  })

  it('throws on a content it does not know, rather than showing an arbitrary set', () => {
    expect(() => build(SessionsFixtures.mixed(), {
      filters: SessionsFilterState.allConst,
      content: 'windows' as never,
      filterText: '',
    })).toThrow('Unknown tree content: "windows"')
  })

  it('filters by text over the title, the agent and the project', () => {
    const byTitle = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content: 'sessions', filterText: 'gamma' })
    const byProject = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content: 'sessions', filterText: 'WebJamatAdmin' })
    const byAgent = build(SessionsFixtures.mixed(), { filters: SessionsFilterState.allConst, content: 'sessions', filterText: 'codex' })

    expect(everyId(byTitle.nodes).filter((id) => id.startsWith('session:')))
      .toEqual(['session:s-shell'])
    expect(everyId(byProject.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-done', 'session:s-ended', 'session:s-lost'])
    expect(everyId(byAgent.nodes).filter((id) => id.startsWith('session:')).sort())
      .toEqual(['session:s-ended', 'session:s-waiting'])
  })

  it('shows only what is marked in attention, and nothing else', () => {
    const marks: ReadonlySet<string> = new Set(['s-waiting'])
    const result = build(SessionsFixtures.mixed(), { filters: { ...SessionsFilterState.allConst, states: ['attention'] }, content: 'sessions', filterText: '' }, marks)
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
    const looking = { filters: { ...SessionsFilterState.allConst, states: ['attention' as const] }, content: 'sessions' as const, filterText: '' }

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
      .toEqual({ nodes: [], emptyState: 'noSessions', fingerprints: new Map() })
    expect(build(mixed, { filters: SessionsFilterState.allConst, content: 'sessions', filterText: 'nothing matches this' }).emptyState)
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
      { filters: { ...SessionsFilterState.allConst, states: ['active'] }, content: 'sessions', filterText: '' },
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
    expect(primary.setup).toBe('installing')
    expect(primary.glyph).toBe('starting')
  })

  it('draws an install on its own once its session is filtered away', () => {
    const result = build(SessionsFixtures.setupPending(), { filters: SessionsFilterState.allConst, content: 'sessions', filterText: 'setup' })
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

    expect(skipped.setup).toBe('install-skipped')
    expect(skipped.glyph).toBe('idle')
    expect(failed.setup).toBe('install-failed')
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

  /**
   * Absence is not a measurement. A directory nothing has looked at yet draws nothing, exactly as a
   * clean one does, rather than claiming there is nothing to commit.
   */
  it('carries the VCS only where a measurement actually said dirty', () => {
    const snapshot = SessionsFixtures.stoppedWorktree()
    const result = build(snapshot)

    const dirty = find(result.nodes, 'session:s-dirty')
    const clean = find(result.nodes, 'session:s-clean')
    if (dirty.kind !== 'session' || clean.kind !== 'session')
      throw new Error('expected two session rows')

    expect(dirty.badges.vcs).toBe('git')
    expect(clean.badges.vcs).toBeNull()
  })
})
