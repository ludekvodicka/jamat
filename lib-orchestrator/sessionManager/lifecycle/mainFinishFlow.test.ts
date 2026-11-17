import { describe, expect, it } from 'vitest'

import type { MainFinishChanges, MainFinishPort } from '../mainFinishPort.types'
import type { SessionRecordMainFinish } from '../records/sessionRecord.types'
import type { SessionInfo, SessionsOpResult } from '../sessionManagerApi.types'
import { MainFinishFlow, type MainFinishSessions } from './mainFinishFlow'

describe('lib-orchestrator/sessionManager/lifecycle/mainFinishFlow', () => {
  const changed: MainFinishChanges = { ok: true, vcs: 'svn', paths: ['app/a.ts', 'docs/b.md'] }
  const clean: MainFinishChanges = { ok: true, vcs: 'svn', paths: [] }

  /** One session `s1`, its record field, the clock, and every port call written down in order. */
  class World implements MainFinishSessions, MainFinishPort {
    info_: SessionInfo | null = { sessionId: 's1', kind: 'agent', life: 'live', activity: 'idle', agent: { agentId: 'claude' } } as SessionInfo
    finish: SessionRecordMainFinish | undefined = undefined
    reads: MainFinishChanges[] = [changed]
    refusal: string | null = null
    pending = false
    stopAnswer: SessionsOpResult = { ok: true, value: undefined }
    removeAnswer: SessionsOpResult = { ok: true, value: undefined }
    at = 1_000
    readonly calls: string[] = []

    info(): SessionInfo | null { return this.info_ }
    current(): SessionRecordMainFinish | undefined { return this.finish }
    committing(): readonly string[] { return this.finish?.phase === 'committing' ? ['s1'] : [] }
    async write(_sessionId: string, change: (current: SessionRecordMainFinish | undefined) => SessionRecordMainFinish | null): Promise<boolean> {
      const next = change(this.finish)
      if (next !== null) this.finish = next
      return true
    }
    async stop(): Promise<SessionsOpResult> {
      this.calls.push('stop')
      if (this.stopAnswer.ok && this.info_ !== null) this.info_ = { ...this.info_, life: 'ended' }
      return this.stopAnswer
    }
    async remove(): Promise<SessionsOpResult> {
      this.calls.push('remove')
      return this.removeAnswer
    }
    report(message: string): void { this.calls.push(`report:${message}`) }
    now(): number { return this.at }
    async changes(): Promise<MainFinishChanges> {
      this.calls.push('read')
      return this.reads.length > 1 ? this.reads.shift()! : this.reads[0]!
    }
    command(vcs: 'svn' | 'git'): string { return vcs === 'svn' ? '/commit-svn' : '/commit-git' }
    async deliver(_sessionId: string, text: string, input: 'typed' | 'paste'): Promise<string | null> {
      this.calls.push(input === 'typed' ? `deliver:${text}` : `paste:${text}`)
      return this.refusal
    }
    reviewPending(): boolean { return this.pending }
    activity(activity: SessionInfo['activity']): void { this.info_ = { ...this.info_!, activity } }
  }

  const flowOf = (world: World): MainFinishFlow => new MainFinishFlow(world, world)

  it('stops a session that is no main-copy agent without reading anything', async () => {
    const world = new World()
    world.info_ = { ...world.info_!, kind: 'shell' }
    expect(await flowOf(world).press('s1')).toEqual({ ok: true, value: { outcome: 'stopped' } })
    expect(world.calls).toEqual(['stop'])
    expect(world.finish).toBeUndefined()
  })

  it('stops an agent without changes of its own, as Finish did before', async () => {
    const world = new World()
    world.reads = [clean]
    expect(await flowOf(world).press('s1')).toEqual({ ok: true, value: { outcome: 'stopped' } })
    expect(world.calls).toEqual(['read', 'stop'])
  })

  it('keeps an agent with changes running and waits for the choice', async () => {
    const world = new World()
    expect(await flowOf(world).press('s1')).toEqual({ ok: true, value: { outcome: 'choose' } })
    expect(world.calls).toEqual(['read'])
    expect(world.finish).toEqual({ startedAt: 1_000, phase: 'choosing', vcs: 'svn', paths: ['app/a.ts', 'docs/b.md'], more: 0 })
    // A second Finish only brings the waiting choice forward.
    expect(await flowOf(world).press('s1')).toEqual({ ok: true, value: { outcome: 'choose' } })
    expect(world.calls).toEqual(['read'])
  })

  it('offers no commit when the changes cannot be read, and says why', async () => {
    const world = new World()
    world.reads = [{ ok: false, detail: 'svn status failed' }]
    await flowOf(world).press('s1')
    expect(world.finish).toMatchObject({ phase: 'choosing', vcs: null, paths: [], note: 'The changes of this session could not be read: svn status failed' })
    expect(await flowOf(world).press('s1', 'commit-close')).toMatchObject({ ok: false, code: 'invalid-spec' })
  })

  it('Commit & continue types the command and leaves the session running', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    world.at = 2_000
    expect(await flow.press('s1', 'commit-continue')).toEqual({ ok: true, value: { outcome: 'sent' } })
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn'])
    expect(world.finish).toMatchObject({ phase: 'closed', result: 'sent', command: '/commit-svn', sentAt: 2_000, endedAt: 2_000 })
  })

  it('gives Codex a slash command as its pasted skill selector', async () => {
    const world = new World()
    world.info_ = { ...world.info_!, agent: { agentId: 'codex' } } as SessionInfo
    const flow = flowOf(world)
    await flow.press('s1')
    expect(await flow.press('s1', 'commit-continue')).toEqual({ ok: true, value: { outcome: 'sent' } })
    expect(world.calls).toEqual(['read', 'paste:$commit-svn'])
    expect(world.finish).toMatchObject({ command: '$commit-svn' })
  })

  it('keeps asking, with the reason, when the command could not be typed', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    world.refusal = 'the composer holds a draft'
    expect(await flow.press('s1', 'commit-close')).toMatchObject({ ok: false, code: 'not-delivered' })
    expect(world.finish).toMatchObject({ phase: 'choosing', note: 'The commit command was not typed into the session: the composer holds a draft' })
  })

  it('Commit & close stops and removes the session once its turn ended, no review is open and nothing of it is left', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    expect(await flow.press('s1', 'commit-close')).toEqual({ ok: true, value: { outcome: 'committing' } })
    world.reads = [clean]
    world.activity('working')
    await flow.tick()
    expect(world.finish).toMatchObject({ phase: 'committing', workingSeen: true })
    world.activity('idle')
    await flow.tick()
    world.at += MainFinishFlow.settleMillisecondsConst - 1
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn'])
    // The review the command opened is still with the person: nothing is read, nothing stops.
    world.at += 1
    world.pending = true
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn'])
    world.pending = false
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn', 'read', 'stop', 'remove'])
    expect(world.finish).toMatchObject({ phase: 'closed', result: 'closed', sentAt: 1_000 })
    expect(world.finish?.workingSeen).toBeUndefined()
  })

  it('reports a row the Remove refused, after the commit and the stop were done', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    await flow.press('s1', 'commit-close')
    world.reads = [clean]
    world.removeAnswer = { ok: false, code: 'live-refused', detail: 'still running' }
    world.at += MainFinishFlow.unseenTurnMillisecondsConst
    await flow.tick()
    world.at += MainFinishFlow.settleMillisecondsConst
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn', 'read', 'stop', 'remove',
      'report:Session s1 committed its changes and stopped, but its row stays: still running'])
    expect(world.finish).toMatchObject({ phase: 'closed', result: 'closed' })
  })

  it('asks again when the commit turn left changes of the session', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    await flow.press('s1', 'commit-close')
    world.reads = [{ ok: true, vcs: 'svn', paths: ['docs/b.md'] }]
    world.activity('working')
    await flow.tick()
    world.activity('idle')
    await flow.tick()
    world.at += MainFinishFlow.settleMillisecondsConst
    await flow.tick()
    expect(world.calls).not.toContain('stop')
    expect(world.calls).not.toContain('remove')
    expect(world.finish).toEqual({ startedAt: 1_000, phase: 'choosing', vcs: 'svn', paths: ['docs/b.md'], more: 0,
      command: '/commit-svn', sentAt: 1_000, note: 'The commit turn ended and 1 file of this session is still changed. Commit again, or close the session.' })
  })

  it('counts a turn it never saw working once the command is long past', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    await flow.press('s1', 'commit-close')
    world.reads = [clean]
    world.at += MainFinishFlow.unseenTurnMillisecondsConst - 1
    await flow.tick()
    world.at += MainFinishFlow.settleMillisecondsConst + 1
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn'])
    world.at += MainFinishFlow.settleMillisecondsConst
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn', 'read', 'stop', 'remove'])
  })

  it('Close session stops first and closes the Finish only once the stop was taken', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    world.stopAnswer = { ok: false, code: 'host-unreachable', detail: 'no Host' }
    expect(await flow.press('s1', 'close')).toMatchObject({ ok: false, code: 'host-unreachable' })
    expect(world.finish?.phase).toBe('choosing')
    world.stopAnswer = { ok: true, value: undefined }
    expect(await flow.press('s1', 'close')).toEqual({ ok: true, value: { outcome: 'stopped' } })
    expect(world.finish).toMatchObject({ phase: 'closed', result: 'closed' })
    expect(world.finish?.sentAt).toBeUndefined()
    // Its changes stay in the working copy, so its row stays too.
    expect(world.calls).not.toContain('remove')
  })

  it('Keep the session ends the watch without stopping anything', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    await flow.press('s1', 'commit-close')
    expect(await flow.press('s1', 'cancel')).toEqual({ ok: true, value: { outcome: 'cancelled' } })
    world.reads = [clean]
    world.at += 60_000
    await flow.tick()
    expect(world.calls).toEqual(['read', 'deliver:/commit-svn'])
    expect(world.finish).toMatchObject({ phase: 'closed', result: 'cancelled' })
    expect(await flow.press('s1', 'cancel')).toMatchObject({ ok: false, code: 'invalid-spec' })
  })

  it('closes a commit whose session ended by itself', async () => {
    const world = new World()
    const flow = flowOf(world)
    await flow.press('s1')
    await flow.press('s1', 'commit-close')
    world.info_ = { ...world.info_!, life: 'ended' }
    await flow.tick()
    expect(world.finish).toMatchObject({ phase: 'closed', result: 'ended', note: 'The session ended before its commit was done.' })
    expect(world.calls).not.toContain('stop')
  })
})
