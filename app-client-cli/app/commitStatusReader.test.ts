import { describe, expect, it } from 'vitest'
import type { RemoteControlCommitStatusDto, RemoteControlResponse } from '../../lib-orchestrator/remoteControl/remoteControlApi.types'
import { RemoteControlConst } from '../../lib-orchestrator/remoteControl/remoteControlProtocol'
import { CommitStatusReader } from './commitStatusReader'

class CommitStatusFixture {
  static readonly id = '11111111-1111-4111-8111-111111111111'
  time = 0
  reads = 0
  states: RemoteControlCommitStatusDto['state'][] = ['editing', 'running', 'committed']
  answer(state: RemoteControlCommitStatusDto['state']): RemoteControlResponse {
    return { protocol: RemoteControlConst.protocol, requestId: 'read', operation: 'tabs.commitStatus', operationId: null, ok: true,
      value: { kind: 'commit-status', commitSessionId: CommitStatusFixture.id, sessionId: 'session', scopeRoot: 'Q:/app', vcs: 'svn',
        state, closed: state === 'cancelled', revision: state === 'committed' ? '42' : null, detail: state === 'failed' ? 'out of date' : null } }
  }
  reader(): CommitStatusReader {
    return new CommitStatusReader({ read: async () => this.answer(this.states[Math.min(this.reads++, this.states.length - 1)]!),
      now: () => this.time, pause: async (ms) => { this.time += ms } })
  }
}

describe('app-client-cli/app/commitStatusReader', () => {
  it('waits on the same review until the actual revision exists', async () => {
    const f = new CommitStatusFixture()
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000)).toMatchObject({ ok: true, value: { state: 'committed', revision: '42', closed: false } })
    expect(f.reads).toBe(3)
    expect(f.time).toBe(2_000)
  })
  it.each(['cancelled', 'failed', 'external-closed'] as const)('finishes on %s without declaring a commit', async (state) => {
    const f = new CommitStatusFixture()
    f.states = ['editing', state]
    expect(await f.reader().read(CommitStatusFixture.id, true, 5_000)).toMatchObject({ ok: true, value: { state, revision: null } })
    expect(f.reads).toBe(2)
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
    for (const value of [null, { ...answer.value, revision: null }, { ...answer.value, state: 'unknown' }, { ...answer.value, vcs: 'hg' }])
      expect(CommitStatusReader.valid(value, CommitStatusFixture.id)).toBe(false)
  })
  it('returns controller loss instead of continuing to poll', async () => {
    const f = new CommitStatusFixture()
    const error = { protocol: RemoteControlConst.protocol, requestId: null, operation: 'tabs.commitStatus' as const, operationId: null,
      ok: false as const, error: { code: 'unavailable' as const, detail: 'Controller stopped' } }
    const reader = new CommitStatusReader({ read: async () => error, now: () => f.time, pause: async () => { throw new Error('Unexpected wait') } })
    expect(await reader.read(CommitStatusFixture.id, true, 10)).toMatchObject({ ok: false,
      error: { code: 'unavailable', detail: expect.stringContaining(CommitStatusFixture.id), data: { commitSessionId: CommitStatusFixture.id } } })
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
