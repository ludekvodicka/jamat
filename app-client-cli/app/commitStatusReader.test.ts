import { describe, expect, it } from 'vitest'
import type { RemoteControlCommitStatusDto, RemoteControlError, RemoteControlResponse } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { CommitStatusReader } from './commitStatusReader'

class CommitStatusFixture {
  static readonly id = '11111111-1111-4111-8111-111111111111'
  time = 0
  reads = 0
  states: RemoteControlCommitStatusDto['state'][] = ['editing', 'running', 'committed']
  replies: RemoteControlResponse[] = []
  closedStates = new Set<RemoteControlCommitStatusDto['state']>()
  answer(state: RemoteControlCommitStatusDto['state']): RemoteControlResponse {
    return { protocol: RemoteControlConst.protocol, requestId: 'read', operation: 'tabs.commitStatus', operationId: null, ok: true,
      value: { kind: 'commit-status', commitSessionId: CommitStatusFixture.id, sessionId: 'session', scopeRoot: 'Q:/app', vcs: 'svn',
        state, closed: state === 'cancelled' || this.closedStates.has(state),
        revision: state === 'committed' ? '42' : null, detail: state === 'failed' ? 'out of date' : null } }
  }
  reader(): CommitStatusReader {
    return new CommitStatusReader({ read: async () => {
      const index = this.reads++
      return this.replies.length > 0 ? this.replies[Math.min(index, this.replies.length - 1)]!
        : this.answer(this.states[Math.min(index, this.states.length - 1)]!)
    },
      now: () => this.time, pause: async (ms) => { this.time += ms } })
  }
  failure(code: RemoteControlError['code']): RemoteControlResponse {
    return { protocol: RemoteControlConst.protocol, requestId: 'read', operation: 'tabs.commitStatus', operationId: null,
      ok: false, error: { code, detail: 'The status request failed' } }
  }
}

describe('app-client-cli/app/commitStatusReader', () => {
  it('waits on the same review until the actual revision exists', async () => {
    const f = new CommitStatusFixture()
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000)).toMatchObject({ ok: true, value: { state: 'committed', revision: '42', closed: false } })
    expect(f.reads).toBe(3)
    expect(f.time).toBe(2_000)
  })
  it.each(['committed', 'cancelled', 'failed'] as const)('recovers from status timeouts and reports the actual %s outcome', async (state) => {
    const f = new CommitStatusFixture()
    f.closedStates.add(state)
    f.replies = [f.answer('editing'), f.failure('timeout'), f.failure('timeout'), f.answer(state)]
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000))
      .toMatchObject({ ok: true, value: { state, closed: true, revision: state === 'committed' ? '42' : null } })
    expect(f.reads).toBe(4)
    expect(f.time).toBe(3_000)
  })
  it('bounds repeated status timeouts by the original deadline and keeps the outcome unknown', async () => {
    const f = new CommitStatusFixture()
    f.replies = [f.failure('timeout')]
    await expect(f.reader().read(CommitStatusFixture.id, true, 2_500))
      .rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('outcome is unknown') })
    expect(f.time).toBe(2_500)
    expect(f.reads).toBe(4)
  })
  it('does not retry a timeout when only one read was requested', async () => {
    const f = new CommitStatusFixture()
    f.replies = [f.failure('timeout'), f.answer('committed')]
    expect(await f.reader().read(CommitStatusFixture.id, false, 5_000))
      .toMatchObject({ ok: false, error: { code: 'timeout', data: { commitSessionId: CommitStatusFixture.id } } })
    expect(f.reads).toBe(1)
    expect(f.time).toBe(0)
  })
  it.each(['forbidden', 'not-found', 'protocol-mismatch', 'operation-failed', 'conflict'] as const)('stops on %s after a transient timeout', async (code) => {
    const f = new CommitStatusFixture()
    f.replies = [f.failure('timeout'), f.failure(code), f.answer('committed')]
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000))
      .toMatchObject({ ok: false, error: { code, data: { commitSessionId: CommitStatusFixture.id } } })
    expect(f.reads).toBe(2)
  })
  it('passes cancellation to the in-flight read and does not retry its timeout', async () => {
    const f = new CommitStatusFixture()
    const abort = new AbortController()
    const reader = new CommitStatusReader({
      read: async (signal) => {
        expect(signal).toBe(abort.signal)
        abort.abort()
        return f.failure('timeout')
      },
      now: () => f.time, pause: async () => { throw new Error('Unexpected retry') },
    })
    await expect(reader.read(CommitStatusFixture.id, true, 5_000, abort.signal))
      .rejects.toMatchObject({ code: 'operation-failed', message: expect.stringContaining('Stopped waiting') })
  })
  it.each(['cancelled', 'external-closed'] as const)('finishes on %s without declaring a commit', async (state) => {
    const f = new CommitStatusFixture()
    f.states = ['editing', state]
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000)).toMatchObject({ ok: true, value: { state, revision: null } })
    expect(f.reads).toBe(2)
  })
  it('finishes on a failure the person closed', async () => {
    const f = new CommitStatusFixture()
    f.states = ['editing', 'failed']
    f.closedStates.add('failed')
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000))
      .toMatchObject({ ok: true, value: { state: 'failed', closed: true, revision: null, detail: 'out of date' } })
    expect(f.reads).toBe(2)
  })
  it('keeps waiting through a failure the same review then commits', async () => {
    const f = new CommitStatusFixture()
    f.states = ['running', 'failed', 'editing', 'running', 'committed']
    expect(await f.reader().read(CommitStatusFixture.id, true, 30_000))
      .toMatchObject({ ok: true, value: { state: 'committed', revision: '42' } })
    expect(f.reads).toBe(5)
  })
  it('supports one read, bounded waiting and abort', async () => {
    const f = new CommitStatusFixture()
    f.states = ['editing']
    expect(await f.reader().read(CommitStatusFixture.id, false, 1)).toMatchObject({ ok: true, value: { state: 'editing' } })
    await expect(f.reader().read(CommitStatusFixture.id, true, 10)).rejects.toMatchObject({ code: 'timeout' })
    const abort = new AbortController()
    abort.abort()
    await expect(f.reader().read(CommitStatusFixture.id, true, 10, abort.signal)).rejects.toThrow('outcome is unknown')
  })
  it('refuses another UUID and impossible or malformed outcomes', async () => {
    const f = new CommitStatusFixture()
    await expect(f.reader().read('another', true, 10)).rejects.toThrow('Invalid status')
    const answer = f.answer('committed')
    if (!answer.ok) throw new Error('Fixture failed')
    for (const value of [null, { ...answer.value, revision: null }, { ...answer.value, state: 'unknown' }, { ...answer.value, vcs: 'hg' },
      { ...answer.value, detail: 7 }, { ...answer.value, state: 'editing' }, { ...answer.value, state: 'failed', revision: null }])
      expect(CommitStatusReader.valid(value, CommitStatusFixture.id)).toBe(false)
  })
  it('reads through a short controller refusal and reports the actual outcome', async () => {
    const f = new CommitStatusFixture()
    f.replies = [f.answer('editing'), f.failure('unavailable'), f.failure('unavailable'), f.answer('editing'), f.failure('unavailable'), f.answer('committed')]
    expect(await f.reader().read(CommitStatusFixture.id, true, 60_000)).toMatchObject({ ok: true, value: { state: 'committed', revision: '42' } })
    expect(f.reads).toBe(6)
  })
  it('returns a lasting controller loss within its grace, naming the status command, so the caller can discover the client again', async () => {
    const f = new CommitStatusFixture()
    f.replies = [f.answer('editing'), f.failure('unavailable')]
    const answer = await f.reader().read(CommitStatusFixture.id, true, 86_400_000)
    expect(answer).toMatchObject({ ok: false, error: { code: 'unavailable', data: { commitSessionId: CommitStatusFixture.id },
      detail: expect.stringContaining(`outcome is unknown; check it with commit status --commit-session-id ${CommitStatusFixture.id}`) } })
    expect(f.time).toBe(CommitStatusReader.unavailableGraceMillisecondsConst + 1_000)
    expect(f.reads).toBe(2 + CommitStatusReader.unavailableGraceMillisecondsConst / 1_000)
  })
  it('measures the grace from the first refusal after the controller last answered', async () => {
    const f = new CommitStatusFixture()
    const refusals = CommitStatusReader.unavailableGraceMillisecondsConst / 1_000 - 1
    f.replies = [...Array(refusals).fill(f.failure('unavailable')), f.failure('timeout'),
      ...Array(refusals).fill(f.failure('unavailable')), f.answer('committed')]
    expect(await f.reader().read(CommitStatusFixture.id, true, 86_400_000)).toMatchObject({ ok: true, value: { state: 'committed' } })
  })
  it('returns controller loss at once when only one read was requested', async () => {
    const f = new CommitStatusFixture()
    f.replies = [f.failure('unavailable'), f.answer('committed')]
    expect(await f.reader().read(CommitStatusFixture.id, false, 5_000)).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(f.reads).toBe(1)
  })
  it.each([
    ['a pane closed without a decision, or a review restored after a client restart', 'editing', true, null],
    ['a cancellation its pane still shows', 'cancelled', false, null],
    ['a commit with selected paths SVN did not report', 'committed', false, 'SVN published revisions, but did not report these selected paths: a.ts'],
    ['a pending review with that notice', 'editing', false, 'SVN published revisions, but did not report these selected paths: a.ts'],
  ] as const)('accepts %s', (_name, state, closed, detail) => {
    const f = new CommitStatusFixture()
    const answer = f.answer(state)
    if (!answer.ok) throw new Error('Fixture failed')
    expect(CommitStatusReader.valid({ ...answer.value, closed, detail }, CommitStatusFixture.id)).toBe(true)
  })
  it('keeps waiting on a restored review whose pane has not taken it again', async () => {
    const f = new CommitStatusFixture()
    f.closedStates.add('editing')
    f.states = ['editing', 'editing', 'committed']
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000)).toMatchObject({ ok: true, value: { state: 'committed' } })
    expect(f.reads).toBe(3)
  })
  it.each(['read', 'pause'])('preserves the UUID after an interrupted %s', async (step) => {
    const f = new CommitStatusFixture()
    const reader = new CommitStatusReader({
      read: async () => { if (step === 'read') throw new Error('Disconnected'); return f.answer('editing') },
      now: () => f.time, pause: async () => { throw new Error('Aborted') },
    })
    await expect(reader.read(CommitStatusFixture.id, true, 10)).rejects.toThrow(CommitStatusFixture.id)
  })
})
