import { describe, expect, it } from 'vitest'

import type {
  SessionActivity,
  SessionsSnapshot,
} from '../../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsFilterState } from '../../../shared/sessionsFilterState'
import { SessionsFixtures } from '../../sessions/fixtures/sessionsFixtures'
import { SessionsQuestionReveal } from './sessionsQuestionReveal'
import { SessionsTreeModel, type TreeNode } from './sessionsTreeModel'

describe('app-client-ui/renderer/views/sessionsTree/sessionsQuestionReveal', () => {
  function treeOf(snapshot: SessionsSnapshot): readonly TreeNode[] {
    return SessionsTreeModel.build(
      snapshot,
      { filters: SessionsFilterState.allConst, content: 'both', filterText: '', now: 1_754_400_000_000, inFront: new Set(), tabbed: new Set() },
      new Set(),
      null,
    ).nodes
  }

  function withActivity(snapshot: SessionsSnapshot, sessionId: string, activity: SessionActivity): SessionsSnapshot {
    return { ...snapshot, revision: snapshot.revision + 1, sessions: snapshot.sessions.map((session) =>
      session.sessionId === sessionId ? { ...session, activity } : session) }
  }

  function open(reveal: SessionsQuestionReveal, snapshot: SessionsSnapshot, above: readonly string[] = []): string[] {
    return [...reveal.groupsToOpen([{ above, nodes: treeOf(snapshot) }])].sort()
  }

  /**
   * The project and the root it hangs in, and nothing else: a question is unreachable behind either
   * of them, and the session row above an install carries no twisty to open.
   */
  it('names every group standing between the tree and a session that has just asked', () => {
    const reveal = new SessionsQuestionReveal()
    const working = withActivity(SessionsFixtures.mixed(), 's-working', 'working')
    // The fixture already holds one waiting session, so the model is shown the tree until it has
    // nothing left to say about it. What follows is about the session that asks next.
    open(reveal, working)
    expect(open(reveal, working)).toEqual([])

    expect(open(reveal, withActivity(working, 's-working', 'waiting')))
      .toEqual(['category:nodejs', 'project:category:nodejs/c:/projects/nodejs/appjamatv3'])
  })

  /** The person may fold the group back while the question still stands, and it stays folded. */
  it('reveals once per question and not again while the same session keeps waiting', () => {
    const reveal = new SessionsQuestionReveal()
    const working = withActivity(SessionsFixtures.mixed(), 's-working', 'working')
    const waiting = withActivity(working, 's-working', 'waiting')
    open(reveal, working)
    expect(open(reveal, waiting)).toHaveLength(2)

    expect(open(reveal, waiting)).toEqual([])

    // A second question from the same session is a second reveal: it worked in between.
    open(reveal, withActivity(waiting, 's-working', 'working'))
    expect(open(reveal, waiting)).toHaveLength(2)
  })

  /**
   * A remote tree hangs under two rows this tree never built - the computer and its endpoint - and a
   * project opened inside them without them is still behind a folded row.
   */
  it('opens the rows standing above a remote tree as well as the groups inside it', () => {
    const reveal = new SessionsQuestionReveal()
    const working = withActivity(SessionsFixtures.mixed(), 's-working', 'working')
    open(reveal, working)

    expect(open(reveal, withActivity(working, 's-working', 'waiting'), ['computer:office', 'endpoint:office-dev']))
      .toEqual(['category:nodejs', 'computer:office', 'endpoint:office-dev', 'project:category:nodejs/c:/projects/nodejs/appjamatv3'])
  })

  /** A first sighting that is already waiting is a question nobody has been shown yet. */
  it('reveals a session it has never seen in any other state', () => {
    const reveal = new SessionsQuestionReveal()

    expect(open(reveal, SessionsFixtures.mixed())).toContain('category:nodejs')
  })
})
