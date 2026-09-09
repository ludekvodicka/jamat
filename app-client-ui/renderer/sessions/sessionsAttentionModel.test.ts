import { describe, expect, it } from 'vitest'

import type {
  SessionActivity,
  SessionInfo,
} from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { SessionsFixtures } from './fixtures/sessionsFixtures'
import { SessionsAttentionModel } from './sessionsAttentionModel'

describe('app-client-ui/renderer/sessions/sessionsAttentionModel', () => {
  function sessionOf(over: Partial<SessionInfo> = {}): SessionInfo {
    return {
      sessionId: 's-1',
      kind: 'agent',
      title: 'Alpha',
      titleParts: { number: null, name: 'Alpha' },
      tabTitle: 'Terminal - Alpha',
      directory: { mode: 'default' },
      project: { kind: 'none' },
      agent: { agentId: 'claude' },
      life: 'live',
      activity: 'working',
      admits: ['newBeside', 'compact'],
      ...over,
    }
  }

  it('raises nothing from the first snapshot, however much output it carries', () => {
    const model = new SessionsAttentionModel()

    const marked = model.apply({
      sessions: SessionsFixtures.mixed().sessions,
      activeSessionIds: new Set(),
    })

    expect([...marked]).toEqual([])
  })

  it('raises attention when a turn settles away from the session the user is looking at', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })

    const settled = model.apply({
      sessions: [sessionOf({ activity: 'waiting' })],
      activeSessionIds: new Set(),
    })

    expect(settled.has('s-1')).toBe(true)
  })

  it('raises nothing for the session the user is looking at', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set(['s-1']) })

    const settled = model.apply({
      sessions: [sessionOf({ activity: 'idle'})],
      activeSessionIds: new Set(['s-1']),
    })

    expect(settled.has('s-1')).toBe(false)
  })

  it('suppresses marks for every session visible across workspace windows', () => {
    const model = new SessionsAttentionModel()
    const sessions = [sessionOf(), sessionOf({ sessionId: 's-2' })]
    model.apply({ sessions, activeSessionIds: new Set() })

    const settled = model.apply({
      sessions: sessions.map((entry) => ({ ...entry, activity: 'waiting'})),
      activeSessionIds: new Set(['s-1', 's-2']),
    })

    expect([...settled]).toEqual([])
  })

  it('treats a classifier that lost the thread as no settle at all', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })

    const unknown = model.apply({
      sessions: [sessionOf({ activity: 'unknown' })],
      activeSessionIds: new Set(),
    })

    expect(unknown.has('s-1')).toBe(false)
  })

  it('raises attention when a runtime stops, including a session whose install failed', () => {
    const exited = new SessionsAttentionModel()
    exited.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })
    const stopped = exited.apply({
      sessions: [sessionOf({ life: 'ended', activity: 'unknown', exitCode: 0 })],
      activeSessionIds: new Set(),
    })

    const installing = new SessionsAttentionModel()
    installing.apply({
      sessions: [sessionOf({ life: 'starting', activity: 'unknown', setup: { state: 'running', setupSessionId: 's-2', commands: [] } })],
      activeSessionIds: new Set(),
    })
    const failed = installing.apply({
      sessions: [sessionOf({ life: 'ended', activity: 'unknown', setup: { state: 'failed', setupSessionId: 's-2', commands: [] } })],
      activeSessionIds: new Set(),
    })

    expect(stopped.has('s-1')).toBe(true)
    expect(failed.has('s-1')).toBe(true)
  })

  /**
   * The rule that replaced `unread`, and the regression this file exists to prevent. Output moving
   * is not news: an agent TUI repaints its own status row, measured on 2026-08-20 at hundreds of
   * bytes a second while working and every few minutes while sitting at an idle prompt. A mark that
   * fires on that is lit on every session nobody is looking at, which is the same as no mark.
   */
  it('raises nothing for output alone, however much of it arrives', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })

    const noisy = model.apply({
      sessions: [sessionOf({})],
      activeSessionIds: new Set(),
    })

    expect(noisy.has('s-1')).toBe(false)
  })

  it('does not mark a turn merely because foreground work moved into the background', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })

    const background = model.apply({
      sessions: [sessionOf({ activityDetail: 'background' })],
      activeSessionIds: new Set(),
    })

    expect(background.has('s-1')).toBe(false)
  })

  /** The same answer the deleted `clear()` used to give, reached the way it is actually reached. */
  it('puts the mark out the moment the session is on screen', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })
    model.apply({ sessions: [sessionOf({ activity: 'waiting' })], activeSessionIds: new Set() })

    const opened = model.apply({
      sessions: [sessionOf({ activity: 'waiting' })],
      activeSessionIds: new Set(['s-1']),
    })

    expect(opened.has('s-1')).toBe(false)
  })

  /**
   * The same snapshot, read again because the user switched tabs: the model is asked once per
   * snapshot AND once per switch, so a mark has to go out on the switch alone, and the session left
   * behind must not light up again for a state it has already been read in.
   */
  it('answers a session the moment it is the one on screen, and then the next one', () => {
    const model = new SessionsAttentionModel()
    const both = (over: Partial<SessionInfo>): SessionInfo[] =>
      [sessionOf(over), sessionOf({ sessionId: 's-2' })]
    model.apply({ sessions: both({}), activeSessionIds: new Set() })

    const raised = model.apply({
      sessions: both({ activity: 'waiting' }),
      activeSessionIds: new Set(),
    })
    const looked = model.apply({
      sessions: both({ activity: 'waiting' }),
      activeSessionIds: new Set(['s-1']),
    })
    const switched = model.apply({
      sessions: both({ activity: 'waiting'}),
      activeSessionIds: new Set(['s-2']),
    })

    expect(raised.has('s-1')).toBe(true)
    expect(looked.has('s-1')).toBe(false)
    // Switching away does not re-light the session just read, and the output it wrote meanwhile is
    // not news either: nothing changed state.
    expect(switched.has('s-1')).toBe(false)
    expect(switched.has('s-2')).toBe(false)
  })

  it('forgets a session that left the records rather than keeping its dot', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })
    model.apply({ sessions: [sessionOf({ life: 'ended', activity: 'unknown' })], activeSessionIds: new Set() })

    const removed = model.apply({ sessions: [], activeSessionIds: new Set() })
    const recycled = model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })

    expect(removed.has('s-1')).toBe(false)
    expect(recycled.has('s-1')).toBe(false)
  })

  it('throws on an activity or a life it does not know', () => {
    const activity = new SessionsAttentionModel()
    activity.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })
    const life = new SessionsAttentionModel()
    life.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })

    expect(() => activity.apply({
      sessions: [sessionOf({ activity: 'napping' as SessionActivity })],
      activeSessionIds: new Set(),
    })).toThrow('Unknown session activity: "napping"')
    // The activity must NOT settle here, or the two rules short-circuit and the life is never read.
    expect(() => life.apply({
      sessions: [sessionOf({ life: 'zombie' as SessionInfo['life'], activity: 'working' })],
      activeSessionIds: new Set(),
    })).toThrow('Unknown session life: "zombie"')
  })

  it('keeps attention until it is answered, across snapshots that changed nothing', () => {
    const model = new SessionsAttentionModel()
    model.apply({ sessions: [sessionOf()], activeSessionIds: new Set() })
    model.apply({ sessions: [sessionOf({ activity: 'waiting' })], activeSessionIds: new Set() })

    const later = model.apply({ sessions: [sessionOf({ activity: 'waiting' })], activeSessionIds: new Set() })

    expect(later.has('s-1')).toBe(true)
    // Asserted through what `apply` returns, which is the only surface anything reads: the model
    // held a public `current()` that no production caller ever asked, and `noUnusedLocals` cannot
    // see a public method.
    const again = model.apply({ sessions: [sessionOf({ activity: 'waiting' })], activeSessionIds: new Set() })
    expect(again.has('s-1')).toBe(true)
  })
})
