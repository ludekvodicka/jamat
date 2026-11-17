import { describe, expect, it } from 'vitest'

import type { SessionActivity, SessionInfo } from '../../../lib-orchestrator/sessionManager/sessionManagerApi.types'
import { CompletedAttention, type CompletedAttentionNotice } from './completedAttention'

describe('app-orchestrator/app/sessions/completedAttention', () => {
  const session = (sessionId: string, activity: SessionActivity | null, extra: Partial<SessionInfo> = {}): SessionInfo => ({
    sessionId, kind: 'agent', title: `${sessionId} title`, tabTitle: `${sessionId} tab`, life: 'live', activity, admits: [],
    directory: { mode: 'default' }, project: { kind: 'none' }, ...extra,
  } as SessionInfo)
  const snapshot = (sessions: SessionInfo[], reconciled = true) => ({ reconciled, sessions })
  const attention = (state: { enabled: boolean; sound: boolean; background: boolean }) => {
    const shown: CompletedAttentionNotice[] = []
    const it = new CompletedAttention({ settings: () => state, background: () => state.background, show: notice => shown.push(notice) })
    return { shown, it }
  }

  it('tells a settled turn in the background once, silent by the setting, with the session title', () => {
    const { shown, it: told } = attention({ enabled: true, sound: false, background: true })
    told.seen(snapshot([session('s1', 'working')]))
    told.seen(snapshot([session('s1', 'idle')]))
    told.seen(snapshot([session('s1', 'idle')]))
    expect(shown).toEqual([{ sessionId: 's1', title: 's1 title', body: 'Session completed', attribution: null, silent: true }])
  })

  it('titles the project folder with the session and puts the folders above it in the attribution', () => {
    expect(CompletedAttention.textOf({ title: '001 - brainstorm',
      project: { kind: 'project', categoryId: 'tools', projectName: 'WorkTracking', projectPath: 'D:\\Work\\Tools\\WorkTracking\\' } }))
      .toEqual({ title: 'WorkTracking · 001 - brainstorm', body: 'Session completed', attribution: 'Work/Tools' })
    expect(CompletedAttention.textOf({ title: '002', project: { kind: 'adHoc', path: 'D:/scratch' } }))
      .toEqual({ title: 'scratch · 002', body: 'Session completed', attribution: null })
    expect(CompletedAttention.textOf({ title: '003', project: { kind: 'none' } }))
      .toEqual({ title: '003', body: 'Session completed', attribution: null })
    expect(CompletedAttention.textOf({ title: '004', project: { kind: 'adHoc', path: 'D:\\' } }).title).toBe('004')
  })

  it('plays the sound when the setting asks, and tells a settle into waiting too', () => {
    const { shown, it: told } = attention({ enabled: true, sound: true, background: true })
    told.seen(snapshot([session('s1', 'working')]))
    told.seen(snapshot([session('s1', 'waiting')]))
    expect(shown.map(notice => notice.silent)).toEqual([false])
  })

  it('tells nothing while a Jamat window has the focus, when disabled, or for a first sighting', () => {
    const state = { enabled: true, sound: false, background: false }
    const { shown, it: told } = attention(state)
    told.seen(snapshot([session('s1', 'working')]))
    told.seen(snapshot([session('s1', 'idle')]))
    state.background = true
    state.enabled = false
    told.seen(snapshot([session('s1', 'working')]))
    told.seen(snapshot([session('s1', 'idle')]))
    state.enabled = true
    told.seen(snapshot([session('s1', 'idle'), session('s2', 'idle')]))
    expect(shown).toEqual([])
  })

  it('ignores an unreconciled snapshot, script runs, unknown activity, and forgets a removed session', () => {
    const { shown, it: told } = attention({ enabled: true, sound: false, background: true })
    told.seen(snapshot([session('s1', 'working'), session('run', 'working', { script: { parentId: 's1' } as SessionInfo['script'] })]))
    told.seen(snapshot([session('s1', 'idle')], false))
    told.seen(snapshot([session('s1', 'unknown'), session('run', 'idle', { script: { parentId: 's1' } as SessionInfo['script'] })]))
    told.seen(snapshot([session('s1', 'working')]))
    told.seen(snapshot([]))
    told.seen(snapshot([session('s1', 'idle')]))
    expect(shown).toEqual([])
  })
})
