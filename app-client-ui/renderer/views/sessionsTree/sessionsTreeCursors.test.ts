import { describe, expect, it } from 'vitest'

import { SessionsTreeCursors } from './sessionsTreeCursors'
import type { TreeResult } from './sessionsTreeModel'

describe('app-client-ui/renderer/views/sessionsTree/sessionsTreeCursors', () => {
  function treeOf(state: TreeResult['emptyState']): TreeResult {
    return { nodes: [], emptyState: state, fingerprints: new Map() }
  }

  /*
   * A miss is a section drawing for the first time, which is exactly the case where there is nothing
   * to compare against. It stopped being a defect on 2026-09-22: a record listing every group could
   * not be initialized for a section a person had not invented yet.
   */
  it('answers nothing for a section it has never drawn', () => {
    const cursors = new SessionsTreeCursors()

    expect(cursors.localOf('group:invented-yesterday')).toBeNull()
    expect(cursors.remoteOf('group:invented-yesterday').size).toBe(0)
  })

  it('hands the same empty remote map back every time, so identity means something', () => {
    const cursors = new SessionsTreeCursors()

    expect(cursors.remoteOf('one')).toBe(cursors.remoteOf('two'))
  })

  it('keeps one cursor per section and never mixes two', () => {
    const cursors = new SessionsTreeCursors()
    const sessions = treeOf('noSessions')
    const tabs = treeOf('noMatch')

    cursors.record('sessions', sessions, null)
    cursors.record('tabs', tabs, new Map([['endpoint', tabs]]))

    expect(cursors.localOf('sessions')).toBe(sessions)
    expect(cursors.localOf('tabs')).toBe(tabs)
    expect(cursors.remoteOf('sessions').size).toBe(0)
    expect(cursors.remoteOf('tabs').get('endpoint')).toBe(tabs)
  })

  /** Two local trees and one set of remote sections: the remote builder takes no content. */
  it('records the remote half on its own', () => {
    const cursors = new SessionsTreeCursors()
    const remote = new Map([['endpoint', treeOf('none')]])

    cursors.recordRemote('both', remote)

    expect(cursors.localOf('both')).toBeNull()
    expect(cursors.remoteOf('both')).toBe(remote)
  })

  it('replaces what a section drew last time', () => {
    const cursors = new SessionsTreeCursors()
    const first = treeOf('noSessions')
    const second = treeOf('none')

    cursors.record('group:waiting', first, null)
    cursors.record('group:waiting', second, null)

    expect(cursors.localOf('group:waiting')).toBe(second)
  })
})
